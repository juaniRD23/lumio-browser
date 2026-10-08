// lumio://credits (main/credits.js, main/protocol.js): the third-party
// packages Lumio ships with their licenses (not the tools that build and test
// it), and Chromium's notices as Electron ships them, restyled for Lumio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { credits, packages, electronFile, chromiumCreditsHtml } = require('../main/credits.js');
const { resolveFile, PAGE_HOSTS } = require('../main/protocol.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('the packages Lumio ships, theirs too, each with its license; not the build and test tools', () => {
  const list = packages();
  const names = list.map((p) => p.name);
  for (const dep of Object.keys(pkg.dependencies)) assert.ok(names.includes(dep), `${dep} is listed`);
  for (const dev of Object.keys(pkg.devDependencies)) assert.equal(names.includes(dev), false, `${dev} (a tool) isn't`);
  assert.ok(names.includes('ms'), 'a dependency of a dependency (debug › ms)');
  assert.equal(new Set(names).size, names.length, 'each once');
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), 'by name');
  const marked = list.find((p) => p.name === 'marked');
  assert.equal(marked.version, JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/marked/package.json'), 'utf8')).version);
  assert.equal(marked.license, 'MIT');
  assert.match(marked.text, /Permission is hereby granted/);
  assert.equal(marked.url, 'https://marked.js.org', 'its homepage');
  assert.equal(list.find((p) => p.name === 'electron-chrome-web-store').url, 'https://github.com/samuelmaddock/electron-browser-shell', 'or its repository');
  for (const p of list) assert.ok(p.license, `${p.name} has a license`);
  // A package whose license is "SEE LICENSE IN …" shows its files.
  const ext = list.find((p) => p.name === 'electron-chrome-extensions');
  assert.equal(ext.license, 'See license');
  assert.match(ext.text, /GNU GENERAL PUBLIC LICENSE/);
});

test('the page’s data: Chromium and Electron, the files Lumio carries; nothing about Lumio’s own code', () => {
  const c = credits();
  for (const key of ['version', 'license', 'source', 'licenseText']) assert.equal(key in c, false, `no ${key} for Lumio itself`);
  assert.equal(c.electron.license, 'MIT');
  assert.match(c.electron.text, /Copyright \(c\) Electron contributors/, 'from the Electron in node_modules when running from source');
  assert.equal(c.chromium.available, true);
  for (const name of ['PDF.js', 'pdfmake', 'docx', 'PptxGenJS', 'Geist and Geist Mono', 'Instrument Serif']) assert.ok(c.bundled.some((b) => b.name === name && b.license && /^https:/.test(b.url)), name);
  // Everything a page can be given goes through IPC: plain data only.
  assert.deepEqual(JSON.parse(JSON.stringify(c)), c);
});

test('lumio://credits/chromium.html is Chromium’s notices file, with chrome://credits’ styles swapped for Lumio’s', () => {
  const file = resolveFile(new URL('lumio://credits/chromium.html'), PAGE_HOSTS);
  assert.equal(file, electronFile('LICENSES.chromium.html'));
  assert.ok(file && fs.existsSync(file));
  assert.ok(PAGE_HOSTS.has('credits'));
  assert.equal(resolveFile(new URL('lumio://credits/'), PAGE_HOSTS), path.join(ROOT, 'renderer', 'pages', 'credits.html'));
  assert.notEqual(resolveFile(new URL('lumio://settings/chromium.html'), PAGE_HOSTS), file, 'only under credits');

  const head = fs.readFileSync(file, 'utf8').slice(0, 4000);
  assert.match(head, /chrome:\/\/credits\/credits\.css/, 'the file as Electron ships it');
  const out = chromiumCreditsHtml(head + '</body></html>');
  assert.doesNotMatch(out, /chrome:\/\//, 'nothing the page can’t load');
  assert.match(out, /<link rel="stylesheet" href="credits-chromium\.css">\n<\/head>/);
  assert.match(out, /class="product"/, 'the notices themselves are kept');
  assert.ok(fs.existsSync(path.join(ROOT, 'renderer', 'pages', 'credits-chromium.css')));
});

// The app's pages, windows, menus, Spanish text and app metadata make no
// licensing claims about Lumio itself and don't point to its code.
// (Third-party notices, like Chromium's file and the packages' licenses, are
// shown as they come.)
test('the app makes no licensing claims about Lumio and doesn’t link to its code', () => {
  const files = ['main/menu.js', 'main/menu-extras.js', 'renderer/assets/i18n/es.js', 'build/package.mjs', 'build/windows/installer.nsi'];
  for (const dir of ['renderer/pages', 'renderer/ui']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) if (/\.(html|m?js)$/.test(f)) files.push(`${dir}/${f}`);
  }
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(text, /open[- ]source|free software|software libre|código abierto|General Public License|\bGPL\b/i, `${f} makes a licensing claim about Lumio`);
    assert.doesNotMatch(text, /github\.com\/juaniRD23/i, `${f} links to Lumio’s code`);
  }
});
