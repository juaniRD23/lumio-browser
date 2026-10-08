// lumio://credits: the third-party software in Lumio Browser and its
// licenses, like chrome://credits. The packages come from node_modules as
// shipped (Lumio's dependencies and theirs, not the tools that build and
// test it), read from their package.json and license files, so the list is
// always what's in the app. Chromium's own list (hundreds of projects) is the
// file Electron ships, shown at lumio://credits/chromium.html.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Libraries Lumio carries as files rather than packages: Lumio Chat's file
// code (scripts/build-preload.mjs copies it into renderer/ui/web) and the fonts.
const BUNDLED = [
  { name: 'PDF.js', license: 'Apache-2.0', url: 'https://mozilla.github.io/pdf.js/' },
  { name: 'pdfmake', license: 'MIT', url: 'https://pdfmake.github.io/docs/' },
  { name: 'Roboto (in pdfmake)', license: 'Apache-2.0', url: 'https://fonts.google.com/specimen/Roboto' },
  { name: 'docx', license: 'MIT', url: 'https://docx.js.org/' },
  { name: 'PptxGenJS', license: 'MIT', url: 'https://gitbrent.github.io/PptxGenJS/' },
  { name: 'JSZip (in PptxGenJS)', license: 'MIT or GPL-3.0', url: 'https://stuk.github.io/jszip/' },
  { name: 'Geist and Geist Mono', license: 'OFL-1.1', url: 'https://github.com/vercel/geist-font' },
  { name: 'Instrument Serif', license: 'OFL-1.1', url: 'https://github.com/Instrument/instrument-serif' },
];

const LICENSE_FILE = /^(licen[cs]e|copying|notice)/i;
const MAX_TEXT = 60_000; // per package; GPL is about 35 KB

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// Where `name` resolves from `dir`, the way Node finds it, without leaving the app.
function locate(name, dir, root) {
  for (let d = dir; ; d = path.dirname(d)) {
    const found = path.join(d, 'node_modules', name);
    if (fs.existsSync(path.join(found, 'package.json'))) return found;
    if (d === root || path.dirname(d) === d) return null;
  }
}

function licenseOf(info) {
  const l = info.license ?? info.licenses;
  const name = Array.isArray(l) ? l.map((x) => x?.type || x).join(' OR ') : typeof l === 'string' ? l : l?.type || '';
  return /^SEE LICENSE/i.test(name) ? 'See license' : name;
}

function homepageOf(info) {
  const repo = typeof info.repository === 'string' ? info.repository : info.repository?.url || '';
  const url = info.homepage || repo.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^github:/, 'https://github.com/');
  return /^https?:\/\//.test(url) ? url : '';
}

// A package's license files, one after another.
function licenseText(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort(); } catch { /* none */ }
  const text = files.map((f) => {
    try { return fs.readFileSync(path.join(dir, f), 'utf8').trim(); } catch { return ''; }
  }).filter(Boolean).join('\n\n');
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '\n…' : text;
}

// Every package the app ships, once each, by name.
function packages(root = ROOT) {
  const found = new Map(); // folder -> entry
  const visit = (dir) => {
    const info = readJson(path.join(dir, 'package.json'));
    for (const name of Object.keys({ ...info?.dependencies, ...info?.optionalDependencies })) {
      const at = locate(name, dir, root);
      if (!at || found.has(at)) continue;
      const pkg = readJson(path.join(at, 'package.json')) || {};
      found.set(at, { name: pkg.name || name, version: pkg.version || '', license: licenseOf(pkg), url: homepageOf(pkg), text: licenseText(at) });
      visit(at);
    }
  };
  visit(root);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// A file Electron ships (its MIT license, Chromium's credits): inside the Mac
// app (build/package.mjs copies them), next to the program on Windows and
// Linux, or in node_modules when running from source.
function electronFile(name) {
  const places = [
    process.resourcesPath && path.join(process.resourcesPath, name),
    path.join(path.dirname(process.execPath), name),
    path.join(ROOT, 'node_modules', 'electron', 'dist', name),
  ].filter(Boolean);
  return places.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

// Chromium's credits page is made for chrome://credits: its stylesheets live
// there. Lumio's own (credits-chromium.css) takes their place.
function chromiumCreditsHtml(html) {
  return String(html)
    .replace(/<link rel="stylesheet" href="chrome:[^"]*">\s*/g, '')
    .replace(/<\/head>/i, '<link rel="stylesheet" href="credits-chromium.css">\n</head>');
}

let cached = null;
// What the credits page shows (main.js adds the Terms and Privacy addresses).
function credits() {
  if (cached) return cached;
  const electronLicense = electronFile('LICENSE');
  cached = {
    chromium: { version: process.versions.chrome || '', available: !!electronFile('LICENSES.chromium.html') },
    electron: { version: process.versions.electron || '', license: 'MIT', url: 'https://www.electronjs.org/', text: electronLicense ? fs.readFileSync(electronLicense, 'utf8').trim() : '' },
    packages: packages(),
    bundled: BUNDLED,
  };
  return cached;
}

module.exports = { credits, packages, electronFile, chromiumCreditsHtml, BUNDLED };
