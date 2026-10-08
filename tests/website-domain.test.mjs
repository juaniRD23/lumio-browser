// The website (website/public) is served by the lumio Worker at lumio-co.online and,
// for older apps, still at lumio.gw607953.workers.dev. Its pages name only
// lumio-co.online, keep in-site links relative (so the same files work on every host),
// and give the public contact address instead of "reply to your Stripe receipt".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = fileURLToPath(new URL('../website/public/', import.meta.url));
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
// Our own files; vendor/ is third-party code.
const files = fs.readdirSync(PUBLIC).filter((f) => /\.(html|js|css|webmanifest)$/.test(f));
const pages = files.filter((f) => f.endsWith('.html'));

test('the website names lumio-co.online, not the old hosts or a personal email', () => {
  assert.ok(pages.length >= 8, 'found the website pages');
  for (const f of files) {
    const text = read(f);
    assert.doesNotMatch(text, /lumio-usa\.online/, `${f} still names lumio-usa.online`);
    assert.doesNotMatch(text, /gw607953/, `${f} still names a workers.dev host`);
    assert.doesNotMatch(text, /@gmail\.com/i, `${f} shows a personal email address`);
  }
  for (const f of pages) {
    const html = read(f);
    for (const [, addr] of html.matchAll(/mailto:([^"?]+)/g)) assert.match(addr, /^(support|hello)@lumio-co\.online$/, `${f} emails ${addr}`);
    assert.doesNotMatch(html, /<a\b[^>]*href="https?:\/\/(www\.)?lumio-co\.online/, `${f}: in-site links stay relative`);
  }
});

test('privacy and terms give support@lumio-co.online as the contact', () => {
  for (const f of ['privacy.html', 'terms.html']) {
    const contact = /<h2>Contact<\/h2>\s*<p>([\s\S]*?)<\/p>/.exec(read(f))?.[1];
    assert.ok(contact, `${f} has a Contact section`);
    assert.match(contact, /<a href="mailto:support@lumio-co\.online">support@lumio-co\.online<\/a>/, f);
    assert.doesNotMatch(contact, /Stripe receipt/, `${f}: Stripe receipt replies go to Fifty Sites, not Lumio support`);
    assert.match(contact, /href="\/support"/, `${f} points to the Support page`);
  }
  assert.match(read('terms.html'), /the website at lumio-co\.online,/);
});

test('the Support page (App Store Support URL) has the addresses, account deletion and the legal pages', () => {
  const html = read('support.html');
  assert.match(html, /<title>Support · Lumio<\/title>/);
  assert.match(html, /<a href="mailto:support@lumio-co\.online">support@lumio-co\.online<\/a>/);
  assert.match(html, /<a href="mailto:hello@lumio-co\.online">hello@lumio-co\.online<\/a>/);
  assert.match(html, /<h2>Delete your account<\/h2>/);
  assert.match(html, /Settings › your account › Delete Account/, 'the same steps the Privacy Policy gives');
  assert.match(read('privacy.html'), /Settings › your account › Delete Account/);
  assert.match(html, /href="\/privacy"/);
  assert.match(html, /href="\/terms"/);
});

test('the home page is canonical on lumio-co.online and links to Support', () => {
  const html = read('index.html');
  assert.match(html, /<link rel="canonical" href="https:\/\/lumio-co\.online\/">/);
  assert.match(html, /<meta property="og:url" content="https:\/\/lumio-co\.online\/">/);
  const img = /<meta property="og:image" content="([^"]+)">/.exec(html)?.[1];
  assert.match(img ?? '', /^https:\/\/lumio-co\.online\//, 'og:image is an absolute URL on lumio-co.online');
  assert.ok(fs.existsSync(path.join(PUBLIC, new URL(img).pathname)), `${img} is in website/public`);
  const footer = /<footer[\s\S]*?<\/footer>/.exec(html)?.[0] ?? '';
  for (const p of ['/terms', '/privacy', '/support']) assert.match(footer, new RegExp(`<a href="${p}">`), `the footer links to ${p}`);
  assert.match(html, /<b>lumio-co\.online\/companion<\/b>/);
  assert.match(html, /<a href="\/chat">lumio-co\.online\/chat<\/a>/);
});

test('the website makes no licensing claims about Lumio; GitHub is only the DMG downloads and the version check', () => {
  for (const f of files) {
    const text = read(f);
    assert.doesNotMatch(text, /open[- ]source|free software|\bGNU\b|\bGPL\b|General Public License/i, `${f} makes a licensing claim about Lumio`);
    for (const [url] of text.matchAll(/https?:\/\/(?:api\.)?github\.com[^\s"'`)<]*/g)) {
      assert.match(url, /^https:\/\/(github\.com\/juaniRD23\/lumio-browser\/releases\/latest\/download\/[\w.-]+\.dmg|api\.github\.com\/repos\/juaniRD23\/lumio-browser\/releases\/latest)$/, `${f} links to ${url}`);
    }
  }
});
