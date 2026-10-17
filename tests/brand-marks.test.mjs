// Lumio Browser's mark is the Lumio ring and dot with a pointer inside the
// ring; Lumio AI's is the ring and dot alone. The browser's mark goes only
// where the browser names itself (its icons, its own pages, the profile
// picker, About); anything Lumio AI does keeps Lumio AI's mark, so the two
// products stay apart. Also: the icon sources carry the pointer, and the
// built icons have every size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { markSvg, browserMarkSvg, POINTER_PATH } from '../renderer/ui/icons.js';
const { encodePng, decodePng } = createRequire(import.meta.url)('../build/make-icon.cjs');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Public releases of Lumio Browser leave out the iPhone app (ios/).
const HAS_IOS = fs.existsSync(path.join(ROOT, 'ios'));
test('the browser mark is the Lumio mark with the pointer inside the ring', () => {
  assert.ok(!markSvg(18).includes(POINTER_PATH));
  for (const blue of [false, true]) {
    const mark = browserMarkSvg(28, blue);
    assert.ok(mark.startsWith(markSvg(28, blue).replace('</svg>', '')), 'the same ring and dot');
    assert.match(mark, new RegExp(`<path d="${POINTER_PATH}" fill="currentColor" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/></svg>$`));
  }
  // The pointer sits well inside the ring: the arc's center is (31.06, 32.63)
  // on the 64 grid, and its inside edge 21 − 3.5 from there.
  const points = [...POINTER_PATH.matchAll(/([\d.]+) ([\d.]+)/g)].map(([, x, y]) => [Number(x), Number(y)]);
  assert.equal(points.length, 7);
  for (const [x, y] of points) assert.ok(Math.hypot(x - 31.06, y - 32.63) < 17.5 - 4, `${x},${y} is inside the ring`);
});

test('the browser names itself with its own mark', () => {
  for (const f of ['shell.js', 'tab-rows.js', 'overlay-tabsearch.js']) {
    assert.match(read(`renderer/ui/${f}`), /internal\) return browserMarkSvg\(14\)/, `${f}: Lumio's own pages in tabs and lists`);
  }
  assert.match(read('renderer/ui/picker.js'), /\.brand \.mark'\)\.innerHTML = browserMarkSvg\(/, 'the profile picker');
  assert.match(read('renderer/ui/taskmanager.js'), /browser: browserMarkSvg\(14\), ui: browserMarkSvg\(14\), ai: markSvg\(14\)/, 'the task manager: the browser’s rows, and Lumio AI’s');
  assert.ok(read('renderer/ui/overlay-share.js').includes('new Path2D(POINTER_PATH)'), 'the QR code’s middle');
  for (const f of ['renderer/pages/welcome.js', 'renderer/pages/settings.html', 'renderer/pages/version.html']) {
    assert.ok(read(f).includes(POINTER_PATH), `${f}: the welcome page, Settings › About and lumio://version`);
  }
  const newtab = read('renderer/pages/newtab.js');
  assert.match(newtab, /\$\('#mark'\)\.innerHTML = BROWSER_MARK;/, 'the New Tab page');
  assert.match(newtab, /\$\('#ask'\)\.insertAdjacentHTML\('afterbegin', MARK\./, 'its Ask Lumio button keeps Lumio AI’s mark');
});

test('Lumio AI keeps its own mark in the browser', () => {
  for (const f of ['ai-panel.js', 'aura.js', 'side-panel.js', 'sidebar.js', 'overlay.js']) {
    const src = read(`renderer/ui/${f}`);
    assert.ok(!src.includes('browserMarkSvg') && !src.includes(POINTER_PATH), `${f} is Lumio AI’s: no browser mark`);
  }
  assert.doesNotMatch(read('renderer/ui/shell.js'), /ai-toggle[^\n]*browserMarkSvg/, 'the Lumio AI button');
});

test('the icon sources carry the pointer', () => {
  for (const f of ['build/icon.svg', 'build/icon-small.svg', 'build/icon-beta.svg']) {
    const svg = read(f);
    assert.match(svg, /<path class="lm-arc" d="M35 12a21 21 0 1 0 17 19"/, `${f}: the ring`);
    assert.match(svg, /<path class="lm-cursor" d="M[\d.L Z]+"/, `${f}: the pointer`);
  }
  assert.match(read('build/icon-beta.svg'), />BETA<\/text>/);
  if (HAS_IOS) assert.match(read('ios/scripts/make-app-icon.swift'), /\(25\.73, 21\.33\), \(25\.73, 41\.33\), \(30\.86, 36\.7\), \(33\.98, 44\.2\),\s+\(37\.48, 42\.7\), \(34\.36, 35\.33\), \(40\.73, 35\.33\)/, 'the iOS icon draws the same pointer');
});

// The .icns entries by type: 16 and 32 px are ARGB (ic04, ic05), the rest PNGs.
function icnsEntries(file) {
  const icns = fs.readFileSync(path.join(ROOT, file));
  assert.equal(icns.toString('ascii', 0, 4), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  const entries = new Map();
  for (let p = 8; p < icns.length; p += icns.readUInt32BE(p + 4)) entries.set(icns.toString('ascii', p, p + 4), icns.subarray(p + 8, p + icns.readUInt32BE(p + 4)));
  return entries;
}
const PNG_SLOTS = { ic11: 32, ic12: 64, ic07: 128, ic08: 256, ic13: 256, ic09: 512, ic14: 512, ic10: 1024 };

test('the built icons have every size (npm run icon makes them)', () => {
  for (const file of ['build/icon.icns', 'build/icon-beta.icns']) {
    const entries = icnsEntries(file);
    for (const type of ['ic04', 'ic05']) assert.ok(entries.has(type), `${file}: ${type}`);
    for (const [type, size] of Object.entries(PNG_SLOTS)) {
      const { width, height, rgba } = decodePng(entries.get(type));
      assert.deepEqual([width, height], [size, size], `${file}: ${type}`);
      assert.equal(rgba[3], 0, `${file} ${type}: a transparent corner`);
    }
  }
  for (const file of ['build/icon-1024.png', 'build/icon-beta-1024.png']) {
    const { width, height, rgba } = decodePng(fs.readFileSync(path.join(ROOT, file)));
    assert.deepEqual([width, height, rgba[3], rgba[(512 * 1024 + 512) * 4 + 3]], [1024, 1024, 0, 255], file);
  }
  // Windows: PNG images in the .ico, and the Store's tiles.
  const ico = fs.readFileSync(path.join(ROOT, 'build/icon.ico'));
  const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico[6 + 16 * i] || 256);
  assert.deepEqual(sizes, [16, 24, 32, 48, 64, 128, 256]);
  for (let i = 0; i < sizes.length; i++) {
    const e = 6 + 16 * i;
    const png = decodePng(ico.subarray(ico.readUInt32LE(e + 12), ico.readUInt32LE(e + 12) + ico.readUInt32LE(e + 8)));
    assert.deepEqual([png.width, png.height], [sizes[i], sizes[i]]);
  }
  const tiles = { 'Square150x150Logo.png': [150, 150], 'Square150x150Logo.scale-200.png': [300, 300], 'Wide310x150Logo.png': [310, 150], 'StoreLogo.png': [50, 50], 'Square44x44Logo.png': [44, 44], 'Square44x44Logo.targetsize-44_altform-unplated.png': [44, 44] };
  for (const [file, size] of Object.entries(tiles)) {
    const png = decodePng(fs.readFileSync(path.join(ROOT, 'build/windows/store-assets', file)));
    assert.deepEqual([png.width, png.height], size, file);
  }
});

test('the iPhone and iPad icon: opaque by default, the mark alone in dark and tinted', { skip: !HAS_IOS && 'the iPhone app isn’t in this copy (public releases leave out ios/)' }, () => {
  const dir = 'ios/Lumio/Resources/Assets.xcassets/AppIcon.appiconset';
  const read1024 = (f) => { const buf = fs.readFileSync(path.join(ROOT, dir, f)); return { type: buf[25], ...decodePng(buf) }; };
  const light = read1024('AppIcon-1024.png');
  assert.deepEqual([light.width, light.height, light.type], [1024, 1024, 2], 'no alpha channel: App Store Connect refuses one');
  for (const f of ['AppIcon-Dark-1024.png', 'AppIcon-Tinted-1024.png']) {
    const pic = read1024(f);
    assert.deepEqual([pic.width, pic.height, pic.rgba[3]], [1024, 1024, 0], `${f}: transparent around the mark`);
  }
});

test('make-icon’s PNG writer and reader agree', () => {
  const width = 19;
  const height = 7;
  const rgba = Buffer.alloc(width * height * 4).map((_, i) => (i * 37 + (i >> 4) * 11) & 255);
  const back = decodePng(encodePng(width, height, rgba));
  assert.deepEqual([back.width, back.height], [width, height]);
  assert.ok(back.rgba.equals(rgba));
});
