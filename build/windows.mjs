// Windows packages, built on Windows (the release workflow's Windows job):
// - the setup program (NSIS, build/windows/installer.nsi): what the website
//   offers and what installed copies update with;
// - the Microsoft Store package (MSIX, build/windows/AppxManifest.xml). Its
//   identity comes from Partner Center (STORE_IDENTITY_NAME, STORE_PUBLISHER,
//   STORE_PUBLISHER_NAME); Microsoft signs it after Store certification.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function find(candidates) {
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return null;
}

function makensis() {
  const fromPath = (() => { try { return execFileSync('where', ['makensis'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim(); } catch { return null; } })();
  const exe = find([fromPath, 'C:\\Program Files (x86)\\NSIS\\makensis.exe', 'C:\\Program Files\\NSIS\\makensis.exe']);
  if (!exe) throw new Error('NSIS (makensis) is not installed. On the build machine: choco install nsis');
  return exe;
}

// The newest Windows SDK's makeappx.exe.
function makeappx() {
  const kits = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  if (!fs.existsSync(kits)) throw new Error('The Windows SDK (makeappx) is not installed.');
  const versions = fs.readdirSync(kits).filter((v) => /^10\./.test(v)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).reverse();
  const exe = find(versions.map((v) => path.join(kits, v, 'x64', 'makeappx.exe')));
  if (!exe) throw new Error('makeappx.exe was not found in the Windows SDK.');
  return exe;
}

// folder: the packaged app (the folder with Lumio Browser.exe).
export function buildSetup(folder, version, outFile) {
  fs.rmSync(outFile, { force: true });
  execFileSync(makensis(), [
    '/V2',
    `/DVERSION=${version}`,
    `/DSOURCE=${folder}`,
    `/DOUTFILE=${outFile}`,
    `/DICON=${path.join(root, 'build', 'icon.ico')}`,
    path.join(here, 'windows', 'installer.nsi'),
  ], { stdio: 'inherit' });
  return outFile;
}

export function storeIdentity(env = process.env) {
  const id = { name: env.STORE_IDENTITY_NAME, publisher: env.STORE_PUBLISHER, publisherName: env.STORE_PUBLISHER_NAME };
  return id.name && id.publisher && id.publisherName ? id : null;
}

const xml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function msixManifest(version, identity) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`MSIX needs a plain version, not ${version}`);
  return fs.readFileSync(path.join(here, 'windows', 'AppxManifest.xml'), 'utf8')
    .replace('{{IDENTITY_NAME}}', xml(identity.name))
    .replace('{{PUBLISHER}}', xml(identity.publisher))
    .replace('{{PUBLISHER_NAME}}', xml(identity.publisherName))
    .replace('{{VERSION}}', version);
}

export function buildMsix(folder, version, identity, outFile) {
  const layout = path.join(path.dirname(outFile), 'msix-layout');
  fs.rmSync(layout, { recursive: true, force: true });
  fs.mkdirSync(path.join(layout, 'assets'), { recursive: true });
  fs.cpSync(folder, path.join(layout, 'app'), { recursive: true });
  for (const f of fs.readdirSync(path.join(here, 'windows', 'store-assets'))) fs.copyFileSync(path.join(here, 'windows', 'store-assets', f), path.join(layout, 'assets', f));
  fs.writeFileSync(path.join(layout, 'AppxManifest.xml'), msixManifest(version, identity));
  fs.rmSync(outFile, { force: true });
  execFileSync(makeappx(), ['pack', '/o', '/d', layout, '/p', outFile], { stdio: 'inherit' });
  fs.rmSync(layout, { recursive: true, force: true });
  return outFile;
}
