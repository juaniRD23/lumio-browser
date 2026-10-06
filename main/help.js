// Help: the help center and release notes (on the web), "Report an issue…"
// (renderer/ui/overlay-help.js, sent to the Lumio server's POST /api/feedback),
// lumio://version and lumio://flags-lite.
//
// A report only carries what the person ticks: the page's address and a
// screenshot are off until they turn them on, and system info (versions,
// OS) can be turned off. The screenshot is taken when the dialog opens, kept
// in memory to preview, and dropped when it closes.
const { app, dialog } = require('electron');
const os = require('os');
const pkg = require('../package.json');
const FLAVOR = require('./flavor');
const flags = require('./flags');

const REPO = String(pkg.repository?.url || '').replace(/\.git$/, '');
const MAX_DESCRIPTION = 5000;
const SHOT_BYTES = 900_000; // the server's limit, with room to spare

const helpCenterUrl = (base) => `${base}/#faq`;
const releaseNotesUrl = (version) => `${REPO}/releases/tag/v${version}`;

function osName() {
  const v = typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : os.release();
  return process.platform === 'darwin' ? `macOS ${v}` : process.platform === 'win32' ? `Windows ${v}` : `${os.type()} ${v}`;
}

// What "Include system info" sends (and the dialog lists).
function systemInfo() {
  return {
    lumio: app.getVersion() + (FLAVOR.beta ? ' (Beta)' : ''),
    chromium: process.versions.chrome,
    electron: process.versions.electron,
    os: osName(),
    arch: process.arch,
    language: app.getLocale(),
  };
}

// The report's body from what the person chose. Nothing about the page goes
// in unless its box was ticked.
function buildReport(form = {}, { url = '', shot = null, system = null } = {}) {
  const description = String(form.description || '').trim().slice(0, MAX_DESCRIPTION);
  const email = String(form.email || '').trim().slice(0, 200);
  const body = { description };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) body.email = email;
  if (form.includeUrl === true && /^https?:\/\//.test(url)) body.url = String(url).slice(0, 2000);
  if (form.includeShot === true && shot) body.screenshot = shot;
  if (form.includeSystem === true && system) body.system = system;
  return body;
}

// lumio://version
function versionInfo(profileDir = app.getPath('userData')) {
  return {
    name: FLAVOR.name,
    version: app.getVersion(),
    beta: FLAVOR.beta,
    chromium: process.versions.chrome,
    electron: process.versions.electron,
    v8: process.versions.v8,
    node: process.versions.node,
    os: `${osName()} (${process.arch})`,
    userAgent: app.userAgentFallback,
    executable: process.execPath,
    profile: profileDir,
    commandLine: process.argv.join(' '),
    notesUrl: releaseNotesUrl(app.getVersion()),
  };
}

class Help {
  // account (or accountOf(w): the window's profile's Lumio account), store
  // (Lumio's own settings: the experiments), current() (the focused window),
  // openUrl(url), openInternal(url), profileDir(w) (Version's profile path)
  constructor({ account, accountOf = () => account, store, current, openUrl, openInternal, profileDir = () => app.getPath('userData') }) {
    this.accountOf = accountOf;
    this.profileDir = profileDir;
    this.store = store;
    this.current = current;
    this.openUrl = openUrl;
    this.openInternal = openInternal;
  }

  commands() {
    return {
      helpCenter: () => this.openUrl(helpCenterUrl(this.accountOf(this.current()).base)),
      whatsNew: () => this.openUrl(releaseNotesUrl(app.getVersion())),
      reportIssue: () => { const w = this.current(); if (w) this.openReport(w); },
      versionPage: () => this.openInternal('lumio://version/'),
      flagsPage: () => this.openInternal('lumio://flags-lite/'),
    };
  }

  register({ on, handle, internalHandle }) {
    handle('help:send', (w, form) => this.send(w, form || {}));
    on('help:close', (w) => this.closeReport(w));
    internalHandle('page:version-info', ['version'], ({ w } = {}) => versionInfo(this.profileDir(w)));
    internalHandle('page:flags', ['flags-lite'], () => flags.state(this.store.settings.flags));
    internalHandle('page:set-flag', ['flags-lite'], (_ctx, id, value) => {
      this.store.setSetting('flags', flags.set(this.store.settings.flags, String(id), !!value));
      return flags.state(this.store.settings.flags);
    });
    internalHandle('page:flags-reset', ['flags-lite'], () => {
      this.store.setSetting('flags', {});
      return flags.state({});
    });
    internalHandle('page:relaunch', ['flags-lite'], async ({ w }) => {
      const { response } = await dialog.showMessageBox(w.win, {
        type: 'question', buttons: ['Restart', 'Cancel'], defaultId: 0, cancelId: 1,
        message: 'Restart Lumio Browser now?', detail: 'Your tabs come back after the restart.',
      });
      if (response !== 0) return false;
      app.relaunch();
      app.quit();
      return true;
    });
  }

  // "Report an issue…": the dialog over the page, with a screenshot ready
  // in case the person wants to include it.
  async openReport(w) {
    if (w.closed) return;
    const tab = w.tabs.active;
    const wc = tab?.view?.webContents;
    const url = tab ? w.tabs.displayUrl(tab) : '';
    let shot = null;
    let thumb = null;
    try {
      let img = wc && !wc.isDestroyed() ? await wc.capturePage() : null;
      if (img && !img.isEmpty()) {
        if (img.getSize().width > 1280) img = img.resize({ width: 1280, quality: 'good' });
        let jpg = img.toJPEG(70);
        if (jpg.length > SHOT_BYTES) jpg = img.resize({ width: 900, quality: 'good' }).toJPEG(55);
        if (jpg.length <= SHOT_BYTES) {
          shot = `data:image/jpeg;base64,${jpg.toString('base64')}`;
          thumb = `data:image/jpeg;base64,${img.resize({ width: 320, quality: 'good' }).toJPEG(70).toString('base64')}`;
        }
      }
    } catch { /* no screenshot to offer */ }
    w.feedback = { url, shot };
    const a = this.accountOf(w).state();
    const b = tab?.view?.getBounds() || { x: 0, y: 84, width: w.win.getContentSize()[0], height: 600 };
    const width = Math.min(460, b.width - 24);
    w.showOverlay(
      { x: b.x + Math.round((b.width - width) / 2) - 12, y: b.y + 12, width: width + 24, height: Math.min(600, b.height - 24) },
      // signedIn: the report goes with the Lumio account (the dialog says so).
      { kind: 'feedback', url: /^https?:\/\//.test(url) ? url : '', thumb, email: a.signedIn ? a.email || '' : '', signedIn: !!a.signedIn, system: systemInfo() },
    );
    w.overlay.webContents.focus();
  }

  closeReport(w) {
    w.feedback = null;
    if (w.overlayKind === 'feedback') w.hideOverlay();
    w.tabs.wc()?.focus();
  }

  async send(w, form) {
    const ctx = w.feedback;
    if (!ctx) return { ok: false, error: 'Open Report an issue again.' };
    const body = buildReport(form, { url: ctx.url, shot: ctx.shot, system: systemInfo() });
    if (!body.description) return { ok: false, error: 'Describe the issue first.' };
    const r = await this.accountOf(w).api('/api/feedback', { method: 'POST', body }).catch(() => null);
    if (!r) return { ok: false, error: 'Couldn’t reach Lumio. Check your internet connection.' };
    if (!r.ok) return { ok: false, error: r.data?.error || 'That didn’t send. Try again.' };
    w.feedback = null;
    return { ok: true };
  }
}

module.exports = { Help, buildReport, systemInfo, versionInfo, helpCenterUrl, releaseNotesUrl, MAX_DESCRIPTION };
