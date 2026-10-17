// Draws Lumio Browser's icons from the SVGs next to this file, without
// Electron: Quick Look (qlmanage) renders each SVG at 1024 px once as it is
// (on white) and once over black, and the two pictures give back its real
// transparency; sips makes the smaller sizes and iconutil the .icns. macOS
// only. Run: npm run icon
//
//   icon.svg        icon-1024.png, icon.icns, icon.ico (Windows) and the
//                   Microsoft Store tiles in windows/store-assets/
//   icon-small.svg  the 16 and 32 px slots (16@2x too) of icon.icns and
//                   icon.ico: a bigger mark with a thicker ring, which still
//                   reads at that size
//   icon-beta.svg   icon-beta-1024.png, icon-beta.icns (Lumio Beta: the same
//                   icon with the orange BETA pill)
//
// The iPhone and iPad icon is drawn by ios/scripts/make-app-icon.swift.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const SIZE = 1024;

// ---------------------------------------------------------------- PNG
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
// PNG's row filters: what each byte is predicted from (a = left, b = up,
// c = up-left).
function predict(f, a, b, c) {
  switch (f) {
    case 1: return a;
    case 2: return b;
    case 3: return (a + b) >> 1;
    case 4: {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    default: return 0;
  }
}

// 8-bit RGBA pixels → PNG bytes. Each row takes the filter that leaves the
// smallest numbers (the usual heuristic), so the files stay small.
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const out = Buffer.alloc((stride + 1) * height);
  const zero = Buffer.alloc(stride);
  const line = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const cur = rgba.subarray(y * stride, (y + 1) * stride);
    const up = y ? rgba.subarray((y - 1) * stride, y * stride) : zero;
    const row = y * (stride + 1);
    let bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const v = (cur[x] - predict(f, x >= 4 ? cur[x - 4] : 0, up[x], x >= 4 ? up[x - 4] : 0)) & 255;
        line[x] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) { bestSum = sum; out[row] = f; line.copy(out, row + 1); }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(out, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// PNG bytes (8-bit gray, gray + alpha, RGB or RGBA, not interlaced) → RGBA.
function decodePng(buf) {
  let p = 8;
  let width = 0;
  let height = 0;
  let type = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const name = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (name === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      type = data[9];
      if (data[8] !== 8 || data[12]) throw new Error('only 8-bit, non-interlaced PNGs');
    } else if (name === 'IDAT') idat.push(data);
    else if (name === 'IEND') break;
    p += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (!ch) throw new Error(`PNG color type ${type}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const rgba = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) line[x] = (line[x] + predict(f, x >= ch ? line[x - ch] : 0, prev[x], x >= ch ? prev[x - ch] : 0)) & 255;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const i = x * ch;
      if (ch >= 3) { rgba[o] = line[i]; rgba[o + 1] = line[i + 1]; rgba[o + 2] = line[i + 2]; } else rgba[o] = rgba[o + 1] = rgba[o + 2] = line[i];
      rgba[o + 3] = ch === 4 ? line[i + 3] : ch === 2 ? line[i + 1] : 255;
    }
    prev = line;
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------- drawing
let tmp = ''; // a fresh temporary folder for each run

// An SVG at 1024 × 1024, as a PNG file in the temporary folder. Quick Look
// paints on white, so a second copy gets a black backdrop: where the two
// differ, the icon is see-through (alpha = 1 − (white − black)).
function render(svgFile) {
  const name = path.basename(svgFile, '.svg');
  const svg = fs.readFileSync(svgFile, 'utf8').replace(/<svg([^>]*?)\swidth="[^"]*"\s+height="[^"]*"/, `<svg$1 width="${SIZE}" height="${SIZE}"`);
  const open = svg.indexOf('>', svg.indexOf('<svg')) + 1;
  const white = path.join(tmp, `${name}.white.svg`);
  const black = path.join(tmp, `${name}.black.svg`);
  fs.writeFileSync(white, svg);
  fs.writeFileSync(black, `${svg.slice(0, open)}<rect x="-5000" y="-5000" width="10000" height="10000" fill="#000"/>${svg.slice(open)}`);
  execFileSync('qlmanage', ['-t', '-s', String(SIZE), '-o', tmp, white, black], { stdio: 'ignore' });
  const w = decodePng(fs.readFileSync(`${white}.png`));
  const k = decodePng(fs.readFileSync(`${black}.png`));
  for (const pic of [w, k]) if (pic.width !== SIZE || pic.height !== SIZE) throw new Error(`Quick Look drew ${name} at ${pic.width}×${pic.height}`);
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  for (let o = 0; o < rgba.length; o += 4) {
    const diff = w.rgba[o] - k.rgba[o] + w.rgba[o + 1] - k.rgba[o + 1] + w.rgba[o + 2] - k.rgba[o + 2];
    const alpha = Math.max(0, Math.min(1, 1 - diff / 765));
    for (let c = 0; c < 3; c++) rgba[o + c] = alpha > 0.002 ? Math.min(255, Math.round(k.rgba[o + c] / alpha)) : 0;
    rgba[o + 3] = Math.round(alpha * 255);
  }
  const file = path.join(tmp, `${name}.png`);
  fs.writeFileSync(file, encodePng(SIZE, SIZE, rgba));
  return file;
}

// A square copy of `png` at `size` px (sips, like macOS's own tools).
function scaled(png, size, out = path.join(tmp, `${path.basename(png, '.png')}-${size}.png`)) {
  execFileSync('sips', ['-z', String(size), String(size), png, '--out', out], { stdio: 'ignore' });
  return out;
}

// The .icns: 16, 16@2x and 32 from `small` (the small art, if the icon has one).
function icns(big, small, out) {
  const set = path.join(tmp, `${path.basename(out, '.icns')}.iconset`);
  fs.mkdirSync(set);
  for (const size of [16, 32, 128, 256, 512]) {
    scaled(size <= 32 ? small : big, size, path.join(set, `icon_${size}x${size}.png`));
    scaled(size === 16 ? small : big, size * 2, path.join(set, `icon_${size}x${size}@2x.png`));
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', out]);
  console.log(`wrote ${path.relative(process.cwd(), out)}`);
}

// Windows .ico: PNG images at the standard sizes (Vista and later read them).
function ico(big, small, out) {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = sizes.map((n) => fs.readFileSync(scaled(n <= 32 ? small : big, n)));
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // an icon
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((n, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(n >= 256 ? 0 : n, e);
    header.writeUInt8(n >= 256 ? 0 : n, e + 1);
    header.writeUInt16LE(1, e + 4); // color planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(pngs[i].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  fs.writeFileSync(out, Buffer.concat([header, ...pngs]));
  console.log(`wrote ${path.relative(process.cwd(), out)}`);
}

// The Microsoft Store tiles: the icon at `size` px, centered on a transparent
// width × height canvas.
function tile(big, size, width, height, out) {
  const icon = decodePng(fs.readFileSync(scaled(big, size)));
  const rgba = Buffer.alloc(width * height * 4);
  const left = Math.round((width - size) / 2);
  const top = Math.round((height - size) / 2);
  for (let y = 0; y < size; y++) icon.rgba.copy(rgba, ((top + y) * width + left) * 4, y * size * 4, (y + 1) * size * 4);
  fs.writeFileSync(out, encodePng(width, height, rgba));
}

function main() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-icon-'));
  try {
    const big = render(path.join(HERE, 'icon.svg'));
    const small = render(path.join(HERE, 'icon-small.svg'));
    const beta = render(path.join(HERE, 'icon-beta.svg'));

    fs.copyFileSync(big, path.join(HERE, 'icon-1024.png'));
    icns(big, small, path.join(HERE, 'icon.icns'));
    ico(big, small, path.join(HERE, 'icon.ico'));

    // Lumio Beta has no small art: its pill is what tells it apart, even at 16 px.
    fs.copyFileSync(beta, path.join(HERE, 'icon-beta-1024.png'));
    icns(beta, beta, path.join(HERE, 'icon-beta.icns'));

    const store = path.join(HERE, 'windows', 'store-assets');
    tile(big, 100, 150, 150, path.join(store, 'Square150x150Logo.png'));
    tile(big, 200, 300, 300, path.join(store, 'Square150x150Logo.scale-200.png'));
    tile(big, 96, 310, 150, path.join(store, 'Wide310x150Logo.png'));
    tile(big, 50, 50, 50, path.join(store, 'StoreLogo.png'));
    tile(big, 44, 44, 44, path.join(store, 'Square44x44Logo.png'));
    tile(big, 44, 44, 44, path.join(store, 'Square44x44Logo.targetsize-44_altform-unplated.png'));
    console.log(`wrote ${path.relative(process.cwd(), store)}/*.png`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { encodePng, decodePng };
if (require.main === module) main();
