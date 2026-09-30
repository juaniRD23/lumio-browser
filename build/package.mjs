// Packages Lumio Browser with @electron/packager. Builds have no developer
// certificate: the Mac app is signed ad hoc, and the Windows app is unsigned.
//   node build/package.mjs             → this Mac's .app in dist/
//   node build/package.mjs --install   → also copy it into /Applications
//   node build/package.mjs --release   → dist/release/: Mac DMGs (Apple silicon
//                                        and Intel) and a Windows x64 ZIP
import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const dist = path.join(root, 'dist');
const release = path.join(dist, 'release');
const arg = (name) => process.argv.includes(name);

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
      NSMicrophoneUsageDescription: 'Websites you allow can use your microphone.',
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

async function buildMac(arch) {
  const chip = arch === 'x64' ? 'x86_64' : 'arm64';
  execFileSync('sh', [path.join(root, 'native', 'build.sh')], { env: { ...process.env, ARCH: chip }, stdio: 'inherit' });
  const [out] = await packager(macOptions(arch, path.join(root, 'native', 'bin', chip, 'lumio-helper')));
  return adhocSign(path.join(out, 'Lumio Browser.app'));
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
  execFileSync('hdiutil', ['create', '-volname', 'Lumio Browser', '-srcfolder', stage, '-ov', '-format', 'UDZO', file], { stdio: 'ignore' });
  fs.rmSync(stage, { recursive: true, force: true });
  return file;
}

function zip(folder, name) {
  const file = path.join(release, name);
  fs.rmSync(file, { force: true });
  execFileSync('zip', ['-r', '-q', '-X', '-y', file, path.basename(folder)], { cwd: path.dirname(folder) });
  return file;
}

if (arg('--release')) {
  fs.mkdirSync(release, { recursive: true });
  const files = [];
  for (const arch of ['arm64', 'x64']) files.push(dmg(await buildMac(arch), arch));
  files.push(zip(await buildWindows('x64'), 'Lumio-Browser-windows-x64.zip'));
  for (const f of files) console.log(`${path.relative(root, f)}  ${(fs.statSync(f).size / 1e6).toFixed(1)} MB`);
} else {
  const helper = path.join(root, 'native', 'bin', 'lumio-helper');
  if (!fs.existsSync(helper)) throw new Error('Build the Mac helper first: npm run native');
  const [out] = await packager(macOptions(process.arch, helper));
  const app = adhocSign(path.join(out, 'Lumio Browser.app'));
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
