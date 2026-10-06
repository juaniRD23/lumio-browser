// The computer-control glow goes only on the screens the AI looks at or acts
// on (main/ai/screen-aura.js pickDisplays), not on every screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const electronPath = require.resolve('electron');
require.cache[electronPath] ??= { id: electronPath, filename: electronPath, loaded: true, exports: {} };
const { pickDisplays } = require('../main/ai/screen-aura.js');

// Two screens side by side: the main one (id 1) at x 0–1512, an external one
// (id 2) to its left at x -1920–0.
const displays = [
  { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 } },
  { id: 2, bounds: { x: -1920, y: 0, width: 1920, height: 1080 } },
];
const nearest = (p) => (p.x < 0 ? 2 : 1);
const env = (extra = {}) => ({ cursor: { x: 700, y: 400 }, displays, primaryId: 1, nearest, ...extra });
// A screenshot of the external screen, scaled down to 1440 px wide.
const lastShot = { bounds: displays[1].bounds, width: 1440, height: 810 };

test('a screenshot lights up only the screen it captures', () => {
  assert.deepEqual(pickDisplays('computer_screenshot', {}, env()), [1], 'the one under the mouse by default');
  assert.deepEqual(pickDisplays('computer_screenshot', { display: 'cursor' }, env({ cursor: { x: -500, y: 300 } })), [2]);
  assert.deepEqual(pickDisplays('computer_screenshot', { display: 'main' }, env({ cursor: { x: -500, y: 300 } })), [1]);
  assert.deepEqual(pickDisplays('computer_screenshot', { display: '2' }, env()), [2], 'a display number from an earlier screenshot');
  assert.deepEqual(pickDisplays('computer_screenshot', { display: '99' }, env()), [1], 'an unknown number falls back to the mouse');
});

test('clicks, moves and scrolls light up the screen under their point; a drag, both ends', () => {
  assert.deepEqual(pickDisplays('computer_click', { x: 100, y: 100 }, env({ lastShot })), [2]);
  assert.deepEqual(pickDisplays('computer_move', { x: 1400, y: 800 }, env({ lastShot })), [2]);
  assert.deepEqual(pickDisplays('computer_scroll', { x: 10, y: 10, direction: 'down' }, env({ lastShot })), [2]);
  const mainShot = { bounds: displays[0].bounds, width: 1440, height: 935 };
  assert.deepEqual(pickDisplays('computer_click', { x: 100, y: 100 }, env({ lastShot: mainShot })), [1]);
  assert.deepEqual(pickDisplays('computer_drag', { from_x: 10, from_y: 10, to_x: 20, to_y: 20 }, env({ lastShot })), [2], 'one screen, listed once');
  assert.deepEqual(pickDisplays('computer_click', { x: 100, y: 100 }, env()), [1], 'no screenshot yet: the screen under the mouse');
});

test('typing, keys and apps light up the screen under the mouse only', () => {
  for (const name of ['computer_type', 'computer_key', 'open_app', 'run_applescript']) {
    assert.deepEqual(pickDisplays(name, { text: 'hi' }, env({ lastShot, cursor: { x: 300, y: 300 } })), [1], name);
  }
});
