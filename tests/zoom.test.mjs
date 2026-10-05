// Page zoom like Chrome's (main/zoom.js): the preset steps, a default for
// every site, and a level per site that's kept for next time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const zoom = require('../main/zoom.js');
const { Store } = require('../main/store.js');

const fresh = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-zoom-')), null);

test('zooming walks Chrome’s steps and stops at the ends', () => {
  const ins = [];
  for (let p = 100; ins.length < 10; ) { p = zoom.stepZoom(p, 1); ins.push(p); }
  assert.deepEqual(ins, [110, 125, 150, 175, 200, 250, 300, 400, 500, 500]);
  const outs = [];
  for (let p = 100; outs.length < 8; ) { p = zoom.stepZoom(p, -1); outs.push(p); }
  assert.deepEqual(outs, [90, 80, 75, 67, 50, 33, 25, 25]);
  // From an odd level (an older version's 109%), the next step is the next preset.
  assert.equal(zoom.stepZoom(109, 1), 110);
  assert.equal(zoom.stepZoom(109, -1), 100);
  // 0 goes back to the default, whatever it is.
  assert.equal(zoom.stepZoom(175, 0, 125), 125);
  // A third and two thirds are exact factors.
  assert.equal(zoom.factorOf(33), 1 / 3);
  assert.equal(zoom.percentOf(zoom.factorOf(67)), 67);
  assert.equal(zoom.percentOf(1.1000000000000003), 110);
});

test('a level belongs to the host name; only web pages are kept', () => {
  assert.equal(zoom.siteKey('https://www.Example.com:8443/a?b#c'), 'www.example.com');
  assert.equal(zoom.siteKey('http://localhost:3000/'), 'localhost');
  for (const url of ['lumio://settings/', 'file:///tmp/a.html', 'about:blank', 'not a url', '']) assert.equal(zoom.siteKey(url), null, url);
  // Within a session Chromium shares a level by host, files by their address.
  assert.equal(zoom.zoomKey('https://example.com/a'), zoom.zoomKey('https://example.com/b#x'));
  assert.notEqual(zoom.zoomKey('https://example.com/'), zoom.zoomKey('http://example.com/'));
  assert.equal(zoom.zoomKey('file:///tmp/a.html#top'), 'file:///tmp/a.html');
});

test('levels are remembered per site, and the default needs no entry', () => {
  const s = fresh();
  assert.equal(zoom.defaultZoom(s.settings), 100);
  assert.equal(zoom.zoomFor(s.settings, 'https://news.example/'), 100);
  assert.equal(zoom.rememberZoom(s, 'https://news.example/story', 125), true);
  assert.equal(zoom.zoomFor(s.settings, 'https://news.example/other'), 125);
  assert.equal(zoom.zoomFor(s.settings, 'https://elsewhere.example/'), 100);
  assert.equal(zoom.rememberZoom(s, 'https://news.example/', 125), false, 'unchanged');
  assert.equal(zoom.rememberZoom(s, 'lumio://settings/', 150), false, 'internal pages aren’t kept');
  assert.equal(zoom.rememberZoom(s, 'https://news.example/', 123), false, 'only presets');
  // Back to the default: the site is no longer listed.
  zoom.rememberZoom(s, 'https://news.example/', 100);
  assert.deepEqual(s.settings.zoomLevels, {});

  // A different default applies to every other site; a site at that level isn't an exception.
  s.setSetting('defaultZoom', 110);
  zoom.rememberZoom(s, 'https://a.example/', 90);
  zoom.rememberZoom(s, 'https://b.example/', 110);
  assert.equal(zoom.zoomFor(s.settings, 'https://c.example/'), 110);
  assert.deepEqual(zoom.zoomList(s.settings), [{ host: 'a.example', percent: 90 }]);
  assert.equal(zoom.forgetZoom(s, 'a.example'), true);
  assert.equal(zoom.forgetZoom(s, 'a.example'), false);
  assert.equal(zoom.zoomFor(s.settings, 'https://a.example/'), 110);
  // A bad default from an old or synced file falls back to 100%.
  s.setSetting('defaultZoom', 'huge');
  assert.equal(zoom.defaultZoom(s.settings), 100);
});

test('the site list is sorted and stays a sensible size', () => {
  const s = fresh();
  for (let i = 0; i < 510; i++) zoom.rememberZoom(s, `https://site${String(i).padStart(3, '0')}.example/`, 150);
  const list = zoom.zoomList(s.settings);
  assert.equal(list.length, 500);
  assert.equal(list[0].host, 'site010.example', 'the oldest went first');
  assert.ok(list.every((z, i) => i === 0 || list[i - 1].host < z.host));
  // A level zoomed again counts as new.
  zoom.rememberZoom(s, 'https://site010.example/', 175);
  zoom.rememberZoom(s, 'https://new.example/', 175);
  assert.ok(zoom.zoomList(s.settings).some((z) => z.host === 'site010.example'));
});
