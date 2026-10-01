// Updates from GitHub Releases. When a newer release exists, the toolbar shows
// a blue "Update" button. Clicking it downloads this computer's installer,
// checks its size and SHA-256 against what GitHub reports, installs it over
// the running copy, and restarts.
//   macOS:   mount the DMG, copy the app out, verify bundle id, version and
//            signature, then swap it in after Lumio quits.
//   Windows: unzip, then copy the new files over the app folder after Lumio
//            quits (not tested on a real Windows PC yet).
// If the app's folder isn't writable, the installer is opened for the person.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const REPO = 'juaniRD23/lumio-browser';
const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const BUNDLE_ID = 'online.lumio-usa.browser';

// 1.10.0 > 1.9.2; a pre-release suffix sorts before the plain version.
function compareVersions(a, b) {
  const parse = (v) => {
    const [main, pre = ''] = String(v).trim().replace(/^v/i, '').split('-');
    return { nums: main.split('.').map((n) => parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

// The "What's new" text of a release (Markdown from GitHub), without the
// install section, and whether it's marked urgent (<!-- lumio:critical -->,
// added by the release workflow when "critical" is ticked).
function releaseNotes(body) {
  const text = String(body || '');
  const critical = /<!--\s*lumio:critical\s*-->/i.test(text);
  const notes = text.replace(/<!--[\s\S]*?-->/g, '').split(/\n##\s+Install\b/i)[0].replace(/^##\s+What['’]s new\s*\n/i, '').trim().slice(0, 4000);
  return { notes, critical };
}

// The installer that fits this computer (fixed names, see build/package.mjs).
function assetName(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') return arch === 'arm64' ? 'Lumio-Browser-mac-apple-silicon.dmg' : 'Lumio-Browser-mac-intel.dmg';
  if (platform === 'win32' && arch === 'x64') return 'Lumio-Browser-windows-x64.zip';
  return null;
}

function run(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 180_000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || '').toString().trim().split('\n')[0] || 'Command failed'));
      else resolve(String(stdout));
    });
  });
}

class Updater {
  // fetchImpl: fetch-compatible (Electron's net.fetch in the app).
  // quit(): closes Lumio so the swap can happen. installTarget: override for tests.
  constructor({ currentVersion, fetchImpl, workDir, onChange = () => {}, platform = process.platform, arch = process.arch,
    exePath = process.execPath, quit = () => {}, openPath = () => {}, api = LATEST, fakeExit = false, installTarget = null } = {}) {
    Object.assign(this, { currentVersion, fetchImpl, workDir, onChange, platform, arch, exePath, quit, openPath, api, fakeExit, installTarget });
    this.release = null; // { version, url, size, digest, notesUrl, name }
    this.file = null; // the downloaded, verified installer
    this.busy = null;
    this.state = { status: 'idle', current: currentVersion, latest: null, progress: 0, error: null, notesUrl: null, notes: '', critical: false };
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
    return this.state;
  }

  // Asks GitHub for the latest release. Quiet unless `manual` (Settings).
  async check({ manual = false } = {}) {
    if (['downloading', 'installing'].includes(this.state.status)) return this.state;
    if (!['ready', 'available'].includes(this.state.status)) this.set({ status: 'checking', error: null });
    try {
      const res = await this.fetchImpl(this.api, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Lumio-Browser' }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(res.status === 404 ? 'No releases yet.' : `GitHub answered ${res.status}.`);
      const rel = await res.json();
      const version = String(rel.tag_name || '').replace(/^v/i, '');
      const name = assetName(this.platform, this.arch);
      const asset = (rel.assets || []).find((a) => a.name === name);
      const { notes, critical } = releaseNotes(rel.body);
      if (!version || rel.draft || rel.prerelease || compareVersions(version, this.currentVersion) <= 0 || !asset) {
        this.release = null;
        return this.set({ status: 'current', latest: version || null, error: null, notesUrl: rel.html_url || null, notes: '', critical: false });
      }
      if (this.release?.version !== version) { this.release = null; this.file = null; }
      this.release = {
        version, name, url: asset.browser_download_url, size: asset.size,
        digest: /^sha256:[a-f0-9]{64}$/i.test(asset.digest || '') ? asset.digest.slice(7).toLowerCase() : null,
        notesUrl: rel.html_url || null,
      };
      return this.set({ status: this.file ? 'ready' : 'available', latest: version, error: null, notesUrl: this.release.notesUrl, notes, critical });
    } catch (err) {
      return this.set({ status: this.release ? 'available' : 'idle', error: manual ? `Couldn't check for updates: ${err.message}` : null });
    }
  }

  // Downloads and verifies the installer (once).
  download() {
    this.busy ??= this.doDownload().finally(() => { this.busy = null; });
    return this.busy;
  }

  async doDownload() {
    const rel = this.release;
    if (!rel) throw new Error('No update available.');
    if (this.file && fs.existsSync(this.file)) return this.file;
    fs.mkdirSync(this.workDir, { recursive: true });
    const file = path.join(this.workDir, rel.name);
    const part = file + '.part';
    this.set({ status: 'downloading', progress: 0, error: null });
    try {
      const res = await this.fetchImpl(rel.url, { headers: { 'User-Agent': 'Lumio-Browser' } });
      if (!res.ok || !res.body) throw new Error(`the download failed (${res.status})`);
      const total = Number(res.headers.get('content-length')) || rel.size || 0;
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(part);
      let got = 0;
      let shown = 0;
      for await (const chunk of res.body) {
        const buf = Buffer.from(chunk);
        hash.update(buf);
        got += buf.length;
        if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
        const pct = total ? Math.min(99, Math.floor((got / total) * 100)) : 0;
        if (pct !== shown) { shown = pct; this.set({ progress: pct }); }
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
      if (rel.size && got !== rel.size) throw new Error('the download was incomplete');
      if (rel.digest && hash.digest('hex') !== rel.digest) throw new Error("the download didn't match the release's fingerprint");
      fs.renameSync(part, file);
      this.file = file;
      this.set({ status: 'ready', progress: 100 });
      return file;
    } catch (err) {
      fs.rmSync(part, { force: true });
      this.set({ status: 'available', progress: 0, error: `Couldn't download the update: ${err.message}.` });
      throw err;
    }
  }

  // Where the running app lives: the .app bundle (macOS) or its folder (Windows).
  target() {
    if (this.installTarget) return this.installTarget;
    if (this.platform === 'darwin') {
      const bundle = path.resolve(this.exePath, '..', '..', '..');
      return bundle.endsWith('.app') ? bundle : null;
    }
    return path.dirname(this.exePath);
  }

  writable(target) {
    try { fs.accessSync(path.dirname(target), fs.constants.W_OK); fs.accessSync(target, fs.constants.W_OK); return true; } catch { return false; }
  }

  // Installs the downloaded update and restarts Lumio.
  async install() {
    const file = await this.download();
    const target = this.target();
    if (!target || !this.writable(target)) {
      // e.g. an app folder the person can't write to: let them install it.
      this.openPath(file);
      return this.set({ status: 'manual', error: null });
    }
    this.set({ status: 'installing', error: null });
    try {
      if (this.platform === 'darwin') await this.installMac(file, target);
      else if (this.platform === 'win32') await this.installWindows(file, target);
      else throw new Error('Updating isn’t supported on this system.');
    } catch (err) {
      this.set({ status: 'ready', error: `Couldn't install the update: ${err.message}` });
      throw err;
    }
    this.quit();
    return this.state;
  }

  async installMac(dmg, target) {
    const stage = fs.mkdtempSync(path.join(this.workDir, 'stage-'));
    const mnt = path.join(stage, 'mnt');
    fs.mkdirSync(mnt);
    const fresh = path.join(stage, path.basename(target));
    await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mnt, dmg]);
    try {
      const src = path.join(mnt, 'Lumio Browser.app');
      if (!fs.existsSync(src)) throw new Error('the installer has no Lumio Browser.app');
      await run('ditto', [src, fresh]);
    } finally {
      await run('hdiutil', ['detach', '-quiet', '-force', mnt]).catch(() => {});
    }
    const plist = path.join(fresh, 'Contents', 'Info.plist');
    const id = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist])).trim();
    const version = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist])).trim();
    if (id !== BUNDLE_ID) throw new Error('the installer is not Lumio Browser');
    if (version !== this.release.version) throw new Error(`the installer is version ${version}, not ${this.release.version}`);
    await run('codesign', ['--verify', '--deep', '--strict', fresh]);
    // After Lumio quits: move the old copy aside, put the new one in place
    // (putting the old one back if that fails), then open it.
    const script = [
      'pid="$1"; target="$2"; fresh="$3"; relaunch="$4"; old="$target.old-$$"',
      'while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done',
      'if mv "$target" "$old"; then',
      '  if mv "$fresh" "$target"; then rm -rf "$old"; else mv "$old" "$target"; fi',
      'fi',
      'if [ "$relaunch" = 1 ]; then open "$target"; fi',
    ].join('\n');
    const pid = this.fakeExit ? '999999' : String(process.pid);
    spawn('/bin/sh', ['-c', script, 'lumio-update', pid, target, fresh, this.fakeExit ? '0' : '1'], { detached: true, stdio: 'ignore' }).unref();
  }

  async installWindows(zip, target) {
    const stage = fs.mkdtempSync(path.join(this.workDir, 'stage-'));
    const ps = (command, env) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { env: { ...process.env, ...env } });
    await ps('Expand-Archive -LiteralPath $env:LUMIO_ZIP -DestinationPath $env:LUMIO_STAGE -Force', { LUMIO_ZIP: zip, LUMIO_STAGE: stage });
    const folder = fs.readdirSync(stage).map((n) => path.join(stage, n)).find((p) => fs.existsSync(path.join(p, 'Lumio Browser.exe')));
    if (!folder) throw new Error('the installer has no Lumio Browser.exe');
    const script = [
      'try { Wait-Process -Id ([int]$env:LUMIO_PID) -Timeout 60 -ErrorAction SilentlyContinue } catch {}',
      'Start-Sleep -Milliseconds 500',
      'robocopy $env:LUMIO_SRC $env:LUMIO_DEST /E /R:5 /W:1 /NFL /NDL /NJH /NJS | Out-Null',
      "if ($env:LUMIO_RELAUNCH -eq '1') { Start-Process -FilePath (Join-Path $env:LUMIO_DEST 'Lumio Browser.exe') }",
    ].join('; ');
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', script], {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, LUMIO_PID: this.fakeExit ? '999999' : String(process.pid), LUMIO_SRC: folder, LUMIO_DEST: target, LUMIO_RELAUNCH: this.fakeExit ? '0' : '1' },
    }).unref();
  }
}

module.exports = { releaseNotes, Updater, compareVersions, assetName, LATEST };
