// Customize Lumio's saved choices (main/customize.js): only known values are
// kept, including ones that arrive from another device through Sync.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const customize = require('../main/customize.js');
const { SETTINGS } = require('../main/sync/adapters.js');

test('New Tab choices: defaults, checked values, and Sync carries them', () => {
  assert.deepEqual(customize.prefs({}), { background: 'none', shortcuts: true, recent: true });
  assert.deepEqual(customize.prefs({ newTab: { background: 'lava', shortcuts: 0, recent: false } }), { background: 'none', shortcuts: true, recent: false });
  assert.deepEqual(customize.patch({}, 'background', 'dusk'), { background: 'dusk', shortcuts: true, recent: true });
  assert.equal(customize.patch({}, 'background', 'javascript:'), null, 'an unknown background is ignored');
  assert.equal(customize.patch({}, 'image', 'x'), null);
  assert.equal(customize.patch({}, 'shortcuts', 0).shortcuts, false);
  assert.ok(SETTINGS.includes('newTab'));
});

test('the page’s calls: theme, color and background go to their settings; your own picture stays local', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-cz-'));
  const handlers = {};
  const settings = { profile: { theme: 'blue' }, appearance: 'system' };
  const store = { settings, setSetting: (k, v) => { settings[k] = v; } };
  const profiles = [];
  customize.register({
    internalHandle: (ch, hosts, fn) => { assert.deepEqual(hosts, ['newtab']); handlers[ch] = fn; },
    store, dir,
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/x.png'] }) },
    nativeImage: { createFromPath: () => ({ isEmpty: () => false, getSize: () => ({ width: 4000, height: 2000 }), resize: (o) => ({ toJPEG: () => Buffer.from(`jpeg ${o.width}`) }) }) },
    theme: { APPEARANCES: ['system', 'light', 'dark'], appearance: () => settings.appearance },
    setProfile: (p) => profiles.push(p),
  });
  handlers['page:customize-set']({}, 'appearance', 'dark');
  handlers['page:customize-set']({}, 'appearance', 'neon');
  assert.equal(settings.appearance, 'dark');
  handlers['page:customize-set']({}, 'theme', 'green');
  assert.deepEqual(profiles, [{ theme: 'green' }]);
  // Chosen elsewhere without the picture here: no background.
  settings.newTab = { background: 'custom' };
  assert.equal(handlers['page:customize']({}).background, 'none');
  const s = await handlers['page:customize-image']({ w: { win: null } });
  assert.equal(s.background, 'custom');
  assert.equal(fs.readFileSync(path.join(dir, 'newtab-background.jpg'), 'utf8'), 'jpeg 2560', 'scaled down to 2560 px');
  assert.match(s.image, /^data:image\/jpeg;base64,/);
  fs.rmSync(dir, { recursive: true, force: true });
});
