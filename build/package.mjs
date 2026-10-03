// Packages Lumio Browser with @electron/packager.
// Mac signing: release builds on GitHub are signed with a Developer ID (the
// workflow imports the certificate and sets MACOS_SIGN_IDENTITY) with the
// hardened runtime, then notarized by Apple and stapled when the App Store
// Connect key is set (APPLE_API_KEY_PATH, APPLE_API_KEY_ID, APPLE_API_ISSUER).
// Without them (local builds) the Mac app is signed ad hoc. The Windows app
// is unsigned.
//   node build/package.mjs             → this Mac's .app in dist/
//   node build/package.mjs --install   → also copy it into /Applications
//   node build/package.mjs --release   → dist/release/: Mac DMGs (Apple silicon
//                                        and Intel) and a Windows x64 ZIP
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';
import { sign as osxSign } from '@electron/osx-sign';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const dist = path.join(root, 'dist');
const release = path.join(dist, 'release');
const arg = (name) => process.argv.includes(name);

const SIGN_ID = process.env.MACOS_SIGN_IDENTITY || '';
const NOTARY = process.env.APPLE_API_KEY_PATH && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER
  ? ['--key', process.env.APPLE_API_KEY_PATH, '--key-id', process.env.APPLE_API_KEY_ID, '--issuer', process.env.APPLE_API_ISSUER]
  : null;
const HELPER_ID = 'online.lumio-usa.browser.helper';

const common = {
  dir: root,
  name: 'Lumio Browser',
  executableName: 'Lumio Browser',
  out: dist,
  overwrite: true,
  asar: true,
  prune: true,
  appVersion: pkg.version,
  buildVersion: pkg.version,
  appCopyright: 'Lumio · GPL-3.0',
  ignore: [
    /^\/dist($|\/)/,
    /^\/tests($|\/)/,
    /^\/scripts($|\/)/,
    /^\/native($|\/)/,
    /^\/build($|\/)/,
    /^\/website($|\/)/,
    /^\/server($|\/)/,
    /^\/mobile($|\/)/,
    /\.DS_Store$/,
  ],
};

// macOS: the Swift helper for that chip ships in Contents/Resources.
function macOptions(arch, helper) {
  return {
    ...common,
    platform: 'darwin',
    arch,
    icon: path.join(root, 'build', 'icon.icns'),
    appBundleId: 'online.lumio-usa.browser',
    appCategoryType: 'public.app-category.productivity',
    extraResource: [helper],
    protocols: [{ name: 'Web page', schemes: ['http', 'https'] }],
    extendInfo: {
      LSMinimumSystemVersion: '14.0',
      NSAppleEventsUsageDescription: 'Lumio uses AppleScript when you ask it to work with other apps.',
      NSCameraUsageDescription: 'Websites you allow can use your camera.',
      NSMicrophoneUsageDescription: 'Lumio’s voice mode and websites you allow can use your microphone.',
      NSLocationWhenInUseUsageDescription: 'Websites you allow can see your location.',
      CFBundleDocumentTypes: [
        { CFBundleTypeName: 'HTML document', CFBundleTypeRole: 'Viewer', LSItemContentTypes: ['public.html', 'public.xhtml'] },
      ],
    },
  };
}

// Packaging renames the app and rewrites its Info.plist, which breaks
// Electron's own ad-hoc signature, and macOS calls a downloaded app with a
// broken signature "damaged". Re-sign everything ad hoc, helper first.
function adhocSign(app) {
  const helper = path.join(app, 'Contents', 'Resources', 'lumio-helper');
  if (fs.existsSync(helper)) execFileSync('codesign', ['--force', '--sign', '-', '--identifier', 'online.lumio-usa.browser.helper', helper]);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app]);
  execFileSync('codesign', ['--verify', '--deep', '--strict', app]);
  return app;
}

// Developer ID: every binary with the hardened runtime and a secure
// timestamp. The app gets build/entitlements.mac.plist; Electron's helper
// apps keep @electron/osx-sign's Chromium defaults; Lumio's Swift helper
// needs none and keeps its own identifier (macOS ties Accessibility and
// Screen Recording permission to it).
async function developerIdSign(app) {
  const keychain = process.env.MACOS_SIGN_KEYCHAIN ? ['--keychain', process.env.MACOS_SIGN_KEYCHAIN] : [];
  // Lumio's helper sits in Resources, which signing tools don't always walk.
  const helper = path.join(app, 'Contents', 'Resources', 'lumio-helper');
  if (fs.existsSync(helper)) {
    execFileSync('codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', SIGN_ID, ...keychain, '--identifier', HELPER_ID, helper], { stdio: 'inherit' });
  }
  await osxSign({
    app,
    identity: SIGN_ID,
    platform: 'darwin',
    keychain: process.env.MACOS_SIGN_KEYCHAIN || undefined,
    preAutoEntitlements: false,
    optionsForFile: (file) => {
      if (path.resolve(file) === path.resolve(app)) return { hardenedRuntime: true, entitlements: path.join(root, 'build', 'entitlements.mac.plist') };
      if (path.basename(file) === 'lumio-helper') return { hardenedRuntime: true, entitlements: [], additionalArguments: ['--identifier', HELPER_ID] };
      return { hardenedRuntime: true };
    },
  });
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
  return app;
}

// Sends a .zip or .dmg to Apple's notary service and waits for the verdict.
function notarize(file) {
  console.log(`Notarizing ${path.basename(file)}…`);
  const out = execFileSync('xcrun', ['notarytool', 'submit', file, ...NOTARY, '--wait', '--timeout', '45m', '--output-format', 'json'], { encoding: 'utf8' });
  const res = JSON.parse(out.slice(out.indexOf('{')));
  if (res.status !== 'Accepted') {
    let log = '';
    try { log = execFileSync('xcrun', ['notarytool', 'log', res.id, ...NOTARY], { encoding: 'utf8' }); } catch { /* no log yet */ }
    throw new Error(`Apple didn't notarize ${path.basename(file)} (${res.status}).\n${log}`);
  }
  console.log(`  ✓ notarized (${res.id})`);
}

// Signed and notarized, with the ticket stapled to the app itself so it opens
// without warnings even offline.
async function signApp(app) {
  if (!SIGN_ID) return adhocSign(app);
  await developerIdSign(app);
  if (NOTARY) {
    const zipFile = `${app}.zip`;
    execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zipFile]);
    try { notarize(zipFile); } finally { fs.rmSync(zipFile, { force: true }); }
    execFileSync('xcrun', ['stapler', 'staple', app], { stdio: 'inherit' });
    execFileSync('spctl', ['--assess', '--type', 'execute', '--verbose=2', app], { stdio: 'inherit' });
  }
  return app;
}

async function buildMac(arch) {
  const chip = arch === 'x64' ? 'x86_64' : 'arm64';
  execFileSync('sh', [path.join(root, 'native', 'build.sh')], { env: { ...process.env, ARCH: chip }, stdio: 'inherit' });
  const [out] = await packager(macOptions(arch, path.join(root, 'native', 'bin', chip, 'lumio-helper')));
  return signApp(path.join(out, 'Lumio Browser.app'));
}

// Windows: the PowerShell helper ships next to the app's resources.
async function buildWindows(arch = 'x64') {
  const [out] = await packager({
    ...common,
    platform: 'win32',
    arch,
    icon: path.join(root, 'build', 'icon.ico'),
    extraResource: [path.join(root, 'native', 'windows', 'lumio-helper.ps1')],
    win32metadata: {
      CompanyName: 'Lumio',
      ProductName: 'Lumio Browser',
      FileDescription: 'Lumio Browser',
      OriginalFilename: 'Lumio Browser.exe',
      InternalName: 'Lumio Browser',
    },
  });
  return out;
}

function dmg(app, arch) {
  const stage = fs.mkdtempSync(path.join(dist, 'dmg-'));
  execFileSync('ditto', [app, path.join(stage, 'Lumio Browser.app')]);
  fs.symlinkSync('/Applications', path.join(stage, 'Applications'));
  // No version in the name, so /releases/latest/download/<name> links stay valid.
  const file = path.join(release, `Lumio-Browser-mac-${arch === 'x64' ? 'intel' : 'apple-silicon'}.dmg`);
  // hdiutil sometimes fails with "Resource busy" while macOS (Spotlight,
  // XProtect) is still scanning the new files, mostly on CI: try a few times.
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync('hdiutil', ['create', '-volname', 'Lumio Browser', '-srcfolder', stage, '-ov', '-format', 'UDZO', file], { stdio: ['ignore', 'ignore', 'pipe'] });
      break;
    } catch (err) {
      const why = String(err.stderr || err.message).trim();
      if (attempt >= 5) throw new Error(`hdiutil couldn't make ${path.basename(file)}: ${why}`);
      console.log(`hdiutil failed (${why}); trying again in ${attempt * 5} s`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 5000);
    }
  }
  fs.rmSync(stage, { recursive: true, force: true });
  // Developer ID builds: the disk image is signed and notarized too.
  if (SIGN_ID) execFileSync('codesign', ['--force', '--sign', SIGN_ID, '--timestamp', ...(process.env.MACOS_SIGN_KEYCHAIN ? ['--keychain', process.env.MACOS_SIGN_KEYCHAIN] : []), file], { stdio: 'inherit' });
  if (SIGN_ID && NOTARY) {
    notarize(file);
    execFileSync('xcrun', ['stapler', 'staple', file], { stdio: 'inherit' });
    execFileSync('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', file], { stdio: 'inherit' });
  }
  return file;
}

function zip(folder, name) {
  const file = path.join(release, name);
  fs.rmSync(file, { force: true });
  // Windows' own tar (bsdtar). In Git Bash, plain "tar" is GNU tar, which reads "D:" as a host name.
  if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', file, '-C', path.dirname(folder), path.basename(folder)]);
  else execFileSync('zip', ['-r', '-q', '-X', '-y', file, path.basename(folder)], { cwd: path.dirname(folder) });
  return file;
}

if (arg('--release')) {
  // --mac: the Mac disk images only; --windows: the Windows packages only
  // (the setup program and Store package need Windows). Neither: both.
  fs.mkdirSync(release, { recursive: true });
  const files = [];
  if (!arg('--windows')) for (const arch of ['arm64', 'x64']) files.push(dmg(await buildMac(arch), arch));
  if (!arg('--mac')) {
    const folder = await buildWindows('x64');
    files.push(zip(folder, 'Lumio-Browser-windows-x64.zip')); // for copies installed from the zip
    if (process.platform === 'win32') {
      const win = await import('./windows.mjs');
      files.push(win.buildSetup(folder, pkg.version, path.join(release, 'Lumio-Browser-Setup-windows-x64.exe')));
      const identity = win.storeIdentity();
      if (identity) files.push(win.buildMsix(folder, pkg.version, identity, path.join(release, 'Lumio-Browser-windows-x64.msix')));
      else console.log('No Microsoft Store identity (STORE_IDENTITY_NAME, STORE_PUBLISHER, STORE_PUBLISHER_NAME): no Store package this time.');
    }
  }
  for (const f of files) console.log(`${path.relative(root, f)}  ${(fs.statSync(f).size / 1e6).toFixed(1)} MB`);
} else {
  const helper = path.join(root, 'native', 'bin', 'lumio-helper');
  if (!fs.existsSync(helper)) throw new Error('Build the Mac helper first: npm run native');
  const [out] = await packager(macOptions(process.arch, helper));
  const app = await signApp(path.join(out, 'Lumio Browser.app'));
  console.log('Built', app);
  if (arg('--install')) {
    const running = (() => {
      try { execFileSync('pgrep', ['-f', '/Applications/Lumio Browser.app/Contents/MacOS/Lumio Browser$']); return true; } catch { return false; }
    })();
    if (running) {
      console.error('Lumio Browser is running. Quit it, then run: npm run install:app');
      process.exit(1);
    }
    const dest = '/Applications/Lumio Browser.app';
    fs.rmSync(dest, { recursive: true, force: true });
    execFileSync('ditto', [app, dest]);
    console.log('Installed', dest);
  }
}
