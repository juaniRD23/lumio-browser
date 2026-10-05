// Launchers for installed web apps (main/apps.js): what Finder and the Dock
// open on the Mac. Each one runs Lumio with --lumio-app=<id>, and Lumio
// opens that app. A launcher is a tiny app in ~/Applications/Lumio Apps/
// <Name>.app with the site's icon. Its program is a two-line shell script
// that runs `open -n -b <Lumio's bundle id> --args --lumio-app=<id>`; the new
// Lumio hands the request to the one already running (the single-instance
// lock) and quits. LSUIElement keeps the script itself out of the Dock.
const fs = require('fs');
const path = require('path');

const ARG = '--lumio-app=';
const ID = /^[a-f0-9]{16}$/;

// The app a launcher asked for, from Lumio's command line.
function appIdFromArgv(argv = []) {
  const flag = argv.find((a) => typeof a === 'string' && a.startsWith(ARG));
  const id = flag ? flag.slice(ARG.length) : '';
  return ID.test(id) ? id : null;
}

// A name that's a valid file name (on any system).
function safeName(name) {
  const clean = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '');
  return clean.slice(0, 60) || 'Web app';
}

// An .icns file from PNGs keyed by size (macOS reads PNG data in these entries).
const ICNS_TYPES = { 128: 'ic07', 256: 'ic08', 512: 'ic09' };
function icns(pngs) {
  const parts = Object.entries(pngs).filter(([size]) => ICNS_TYPES[size]).map(([size, png]) => {
    const head = Buffer.alloc(8);
    head.write(ICNS_TYPES[size], 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The files of the Mac launcher, relative to <Name>.app.
// lumio: { bundleId } for the installed app, or { appBundle, appPath } for a
// development build (Electron.app running the source folder).
function macBundleFiles({ id, name, lumio, icon }) {
  const run = lumio.bundleId
    ? `/usr/bin/open -n -b ${sh(lumio.bundleId)} --args ${sh(ARG + id)}`
    : `/usr/bin/open -n -a ${sh(lumio.appBundle)} --args ${sh(lumio.appPath)} ${sh(ARG + id)}`;
  const info = {
    CFBundleExecutable: 'launch',
    CFBundleIdentifier: `${lumio.bundleId || 'online.lumio-usa.browser.dev'}.app.${id}`,
    CFBundleName: name.slice(0, 15),
    CFBundleDisplayName: name,
    CFBundleIconFile: 'app.icns',
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: '1.0',
    CFBundleVersion: '1',
    LSMinimumSystemVersion: '11.0',
    LSUIElement: true,
  };
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${Object.entries(info).map(([k, v]) => `  <key>${k}</key>\n  ${v === true ? '<true/>' : `<string>${xml(v)}</string>`}`).join('\n')}
</dict>
</plist>
`;
  return {
    'Contents/Info.plist': plist,
    'Contents/MacOS/launch': `#!/bin/sh\n# Opens the "${name.replace(/[\r\n]/g, ' ')}" web app in Lumio.\nexec ${run}\n`,
    'Contents/Resources/app.icns': icon,
  };
}

// Writes the Mac launcher; returns its path. An existing launcher for
// another app keeps its name: this one gets " 2", " 3"…
function writeMacBundle(dir, { id, name, lumio, icon, owned = () => false }) {
  fs.mkdirSync(dir, { recursive: true });
  let file = path.join(dir, `${safeName(name)}.app`);
  for (let n = 2; fs.existsSync(file) && !owned(file); n++) file = path.join(dir, `${safeName(name)} ${n}.app`);
  fs.rmSync(file, { recursive: true, force: true });
  for (const [rel, data] of Object.entries(macBundleFiles({ id, name, lumio, icon }))) {
    const target = path.join(file, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
  fs.chmodSync(path.join(file, 'Contents/MacOS/launch'), 0o755);
  return file;
}

module.exports = { ARG, appIdFromArgv, safeName, icns, macBundleFiles, writeMacBundle };
