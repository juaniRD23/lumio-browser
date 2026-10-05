// lumio://credits (main/credits.js, main/protocol.js): the open-source
// packages Lumio ships with their licenses (not the tools that build and test
// it), Lumio's own license, and Chromium's notices as Electron ships them,
// restyled for Lumio.
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

test('the page’s data: Lumio’s own license and source, Chromium and Electron, the files Lumio carries', () => {
  const c = credits();
  assert.equal(c.version, pkg.version);
  assert.equal(c.license, 'GPL-3.0-or-later');
  assert.equal(c.source, 'https://github.com/juaniRD23/lumio-browser');
  assert.match(c.licenseText, /GNU GENERAL PUBLIC LICENSE\s+Version 3/);
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
