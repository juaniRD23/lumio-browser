// DRM builds (Widevine), for Netflix, Spotify, Disney+ and other protected
// streams. Stock Electron can't play them, so a DRM build packages castlabs'
// Electron for Content Security (ECS) instead, the same Electron with
// Widevine support, and VMP-signs it with castlabs' EVS service, without
// which most services refuse to play or drop to low quality.
// It's off unless LUMIO_DRM=1, or on CI when the EVS secrets are set, so a
// normal build stays exactly as it was. docs/drm.md has the owner's one-time
// steps. package.json keeps stock Electron: a DRM build swaps it in
// node_modules only (npm ci puts stock Electron back). DRM builds are Mac only,
// like Lumio while Windows is paused.
//   node build/drm.mjs --status            → what a build would do here
//   node build/drm.mjs --install-electron  → swap in the matching castlabs Electron
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CASTLABS_REPO = 'https://github.com/castlabs/electron-releases';
// Where castlabs' release zips live, in the form @electron/get expects (it
// adds v<version>/electron-v<version>-<platform>-<arch>.zip).
export const CASTLABS_MIRROR = `${CASTLABS_REPO}/releases/download/`;

const ON = ['1', 'true', 'yes'];
const OFF = ['0', 'false', 'no'];

// Is this a DRM build? LUMIO_DRM=1 turns it on and LUMIO_DRM=0 off; without
// either, CI builds turn it on when the EVS sign-in is there.
export function drmSwitch(env = {}) {
  const v = String(env.LUMIO_DRM ?? '').trim().toLowerCase();
  if (ON.includes(v)) return { on: true, why: 'LUMIO_DRM=1' };
  if (OFF.includes(v)) return { on: false, why: 'LUMIO_DRM=0' };
  if (env.CI && env.EVS_ACCOUNT_NAME && env.EVS_PASSWD) return { on: true, why: 'CI with the EVS secrets' };
  return { on: false, why: 'LUMIO_DRM isn’t set' };
}

const plain = (v) => String(v || '').trim().replace(/^[\^~=v]+/, '');
const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+([0-9A-Za-z.-]+))?$/.exec(plain(v));
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '', build: m[5] || '' } : null;
};
export const isCastlabs = (version) => parse(version)?.build === 'wvcus';

// The castlabs release to use for the app's Electron (package.json): the same
// version when castlabs built it, otherwise their newest stable release of the
// same major (castlabs builds about once a month, not every Electron release).
export function castlabsTag(appElectron, tags) {
  const want = parse(appElectron);
  if (!want) return null;
  const releases = tags.map((t) => ({ tag: t, v: parse(t) }))
    .filter(({ tag, v }) => tag.startsWith('v') && v && v.build === 'wvcus' && !v.pre && v.major === want.major)
    .sort((a, b) => b.v.minor - a.v.minor || b.v.patch - a.v.patch);
  const exact = releases.find(({ v }) => v.minor === want.minor && v.patch === want.patch);
  const pick = exact || releases[0];
  return pick ? { tag: pick.tag, version: pick.tag.slice(1), source: `${CASTLABS_REPO}#${pick.tag}`, exact: !!exact } : null;
}

// What happens to the Mac app after packaging, in order. castlabs' VMP
// signature goes on BEFORE code signing, which seals it in (on Windows it
// would go after code signing instead: docs/drm.md).
export function signingSteps({ drm = false, signId = '', notary = false }) {
  return [drm && 'vmp-sign', signId ? 'developer-id-sign' : 'ad-hoc-sign', signId && notary && 'notarize'].filter(Boolean);
}

// Everything a build needs to know, from the environment, the installed
// Electron ({ version, checksums } from node_modules/electron) and whether it
// also packages for Windows. A DRM build with stock Electron fails here, so it
// can never quietly ship without Widevine.
// No extra entitlements: Google signs the Widevine module, and macOS lets a
// differently signed library load only where library validation is off. Like
// Chrome, that's just the Plugin helper Chromium loads it in, which
// @electron/osx-sign already signs that way (tests/drm.test.mjs checks it).
export function buildPlan({ env = {}, appElectron, installed, windows = false }) {
  const sw = drmSwitch(env);
  if (sw.on && windows) {
    // castlabs' Windows build needs its own VMP signing step (after code
    // signing), which waits until Windows builds come back.
    throw new Error('DRM builds are Mac only for now: use --release --mac.');
  }
  const signId = env.MACOS_SIGN_IDENTITY || '';
  const notary = !!(env.APPLE_API_KEY_PATH && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER);
  const plan = {
    drm: sw.on,
    why: sw.why,
    electron: installed?.version || null,
    packager: {}, // extra @electron/packager options
    mac: signingSteps({ drm: sw.on, signId, notary }),
  };
  const want = parse(appElectron);
  if (!sw.on) {
    // castlabs' Electron left in node_modules by an earlier DRM build: package
    // stock Electron anyway (@electron/packager would take the installed one).
    if (installed && isCastlabs(installed.version) && want) plan.packager = { electronVersion: `${want.major}.${want.minor}.${want.patch}${want.pre}` };
    return plan;
  }
  if (!installed || !isCastlabs(installed.version)) {
    throw new Error(`A DRM build needs castlabs' Electron, but node_modules has ${installed ? `stock Electron ${installed.version}` : 'no Electron'}. Run: node build/drm.mjs --install-electron`);
  }
  if (!want || parse(installed.version).major !== want.major) {
    // The same major is the same Chromium and Node: what the app is tested on.
    throw new Error(`castlabs Electron ${installed.version} doesn't match the app's Electron ${appElectron}. Run: node build/drm.mjs --install-electron`);
  }
  plan.packager = {
    electronVersion: installed.version,
    download: { mirrorOptions: { mirror: CASTLABS_MIRROR }, ...(installed.checksums ? { checksums: installed.checksums } : {}) },
    // Packaging would otherwise write an asar digest into Electron Framework.
    // EVS signs castlabs' binaries only as castlabs built them (their FAQ on
    // fuses), and Electron runs fine without the digest: it only matters with
    // the asar-integrity fuse, which Lumio doesn't turn on.
    asarIntegrityDigest: false,
  };
  return plan;
}

// castlabs' EVS command that VMP-signs the packaged app: dir is the folder
// the .app is in (not the app itself), name the app's name in it. Streaming
// signatures (the default) are the right kind since ECS 42 dropped offline
// licenses. On CI it never stops to ask for a password; the workflow signs in
// first.
export function vmpCommand({ env = {}, dir, name }) {
  return [env.EVS_PYTHON || 'python3', ['-m', 'castlabs_evs.vmp', ...(env.CI ? ['--no-ask'] : []), 'sign-pkg', '--name-hint', name, dir]];
}

// ---------------------------------------------------------------- on this machine
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function installedElectron(dir = root) {
  try {
    const base = path.join(dir, 'node_modules', 'electron');
    const { version } = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
    let checksums = null;
    try { checksums = JSON.parse(fs.readFileSync(path.join(base, 'checksums.json'), 'utf8')); } catch { /* @electron/get then reads SHASUMS256.txt */ }
    return { version, checksums };
  } catch {
    return null;
  }
}

export const appElectron = (dir = root) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).devDependencies.electron;

// castlabs' release tags, straight from their repository (no GitHub API limits).
function castlabsTags() {
  const out = execFileSync('git', ['ls-remote', '--tags', '--refs', CASTLABS_REPO], { encoding: 'utf8' });
  return out.split('\n').map((l) => l.split('refs/tags/')[1]).filter(Boolean);
}

// Swaps node_modules/electron for the matching castlabs build, without
// touching package.json or package-lock.json. Does nothing if it's there.
export function ensureCastlabsElectron() {
  const pick = castlabsTag(appElectron(), castlabsTags());
  if (!pick) throw new Error(`castlabs has no Electron ${parse(appElectron())?.major}.x release yet: see ${CASTLABS_REPO}/releases`);
  if (installedElectron()?.version === pick.version) return pick;
  if (!pick.exact) console.log(`castlabs has no build of Electron ${plain(appElectron())}; using ${pick.version}, the newest of that major.`);
  console.log(`Installing castlabs Electron ${pick.version} (${pick.source})…`);
  execFileSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', pick.source], { cwd: root, stdio: 'inherit' });
  const now = installedElectron();
  if (now?.version !== pick.version) throw new Error(`npm didn't install castlabs Electron ${pick.version} (node_modules has ${now?.version || 'none'}).`);
  return pick;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--install-electron')) {
    const pick = ensureCastlabsElectron();
    console.log(`node_modules/electron is castlabs Electron ${pick.version}. Run npm ci to go back to stock Electron.`);
  } else {
    const installed = installedElectron();
    const sw = drmSwitch(process.env);
    console.log(`DRM build: ${sw.on ? 'yes' : 'no'} (${sw.why})`);
    console.log(`Electron in node_modules: ${installed?.version || 'none'}${installed && isCastlabs(installed.version) ? ' (castlabs)' : ''}; package.json wants ${appElectron()}`);
    try {
      const plan = buildPlan({ env: process.env, appElectron: appElectron(), installed });
      console.log(`After packaging: ${plan.mac.join(' → ')}`);
    } catch (err) {
      console.log(err.message);
    }
    try {
      const pick = castlabsTag(appElectron(), castlabsTags());
      console.log(pick ? `castlabs release for it: ${pick.tag}${pick.exact ? '' : ' (not the same version: the newest of that major)'}` : 'castlabs has no release for this Electron major yet.');
    } catch { console.log('Couldn’t reach castlabs’ repository to look for a release.'); }
  }
}
