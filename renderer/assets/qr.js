// A small QR code encoder (ISO/IEC 18004, byte mode, versions 1 to 40), so
// "QR code" in the Share menu works offline and never sends the address
// anywhere. It follows the spec's steps: pick the smallest version that
// fits, add Reed-Solomon error correction, place the bits, then choose the
// mask with the lowest penalty. qrMatrix() returns rows of booleans (true is
// a dark module); the overlay draws them (renderer/ui/overlay-share.js).

// Error correction codewords per block and number of blocks, by level
// (L, M, Q, H) and version (index 0 is unused). From the spec's table 9.
const ECC_PER_BLOCK = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};
const BLOCKS = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};
const FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };
export const LEVELS = ['L', 'M', 'Q', 'H'];

// ---------------------------------------------------------------- Reed-Solomon over GF(256)
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree) {
  const out = new Array(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      out[j] = gfMul(out[j], root);
      if (j + 1 < degree) out[j] ^= out[j + 1];
    }
    root = gfMul(root, 2);
  }
  return out;
}

// The error correction codewords for one block of data codewords.
export function rsRemainder(data, degree) {
  const divisor = rsDivisor(degree);
  const out = new Array(degree).fill(0);
  for (const b of data) {
    const factor = b ^ out.shift();
    out.push(0);
    divisor.forEach((coef, i) => { out[i] ^= gfMul(coef, factor); });
  }
  return out;
}

// ---------------------------------------------------------------- sizes
const rawModules = (ver) => {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
};
export const dataCodewords = (ver, ecc) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ecc][ver] * BLOCKS[ecc][ver];
const countBits = (ver) => (ver < 10 ? 8 : 16);

function alignmentPositions(ver) {
  if (ver === 1) return [];
  const count = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
  const out = [6];
  for (let pos = ver * 4 + 17 - 7; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

// ---------------------------------------------------------------- data
// The data codewords with error correction, interleaved block by block.
function codewords(bytes, ver, ecc) {
  const capacity = dataCodewords(ver, ecc);
  const bits = [];
  const put = (value, n) => { for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(0b0100, 4); // byte mode
  put(bytes.length, countBits(ver));
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capacity * 8 - bits.length)); // terminator
  put(0, (8 - (bits.length % 8)) % 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);

  const blocks = BLOCKS[ecc][ver];
  const eccLen = ECC_PER_BLOCK[ecc][ver];
  const raw = Math.floor(rawModules(ver) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLen = Math.floor(raw / blocks);
  const parts = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const len = shortLen - eccLen + (i < shortBlocks ? 0 : 1);
    const chunk = data.slice(k, k + len);
    k += len;
    parts.push({ data: chunk, ecc: rsRemainder(chunk, eccLen) });
  }
  const out = [];
  const longest = Math.max(...parts.map((p) => p.data.length));
  for (let i = 0; i < longest; i++) for (const p of parts) if (i < p.data.length) out.push(p.data[i]);
  for (let i = 0; i < eccLen; i++) for (const p of parts) out.push(p.ecc[i]);
  return out;
}

// ---------------------------------------------------------------- the grid
function makeGrid(ver) {
  const size = ver * 4 + 17;
  const dark = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, on) => { dark[y][x] = on; fixed[y][x] = true; };

  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); } // timing
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) { // finders and their separators
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const align = alignmentPositions(ver);
  align.forEach((ax, i) => align.forEach((ay, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) return; // under a finder
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  drawFormat(set, size, 'L', 0); // reserves the format areas; drawn for real after masking
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const on = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, on);
      set(b, a, on);
    }
  }
  return { size, dark, fixed, set };
}

export function formatBits(ecc, mask) {
  const data = (FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function drawFormat(set, size, ecc, mask) {
  const bits = formatBits(ecc, mask);
  const bit = (i) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true); // the dark module
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(g, mask) {
  const m = MASKS[mask];
  for (let y = 0; y < g.size; y++) for (let x = 0; x < g.size; x++) if (!g.fixed[y][x] && m(x, y)) g.dark[y][x] = !g.dark[y][x];
}

// The spec's four penalty rules: long runs, 2×2 blocks, finder look-alikes,
// and too much or too little dark.
export function penalty(dark) {
  const size = dark.length;
  let score = 0;
  const lines = [];
  for (let i = 0; i < size; i++) {
    lines.push(dark[i]);
    lines.push(dark.map((row) => row[i]));
  }
  const like = [true, false, true, true, true, false, true];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) { run++; continue; }
      if (run >= 5) score += 3 + (run - 5);
      run = 1;
    }
    for (let i = 0; i + 7 <= size; i++) {
      if (!like.every((v, k) => line[i + k] === v)) continue;
      const lightBefore = [1, 2, 3, 4].every((k) => i - k < 0 || !line[i - k]);
      const lightAfter = [0, 1, 2, 3].every((k) => i + 7 + k >= size || !line[i + 7 + k]);
      if (lightBefore || lightAfter) score += 40;
    }
  }
  let darkCount = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (dark[y][x]) darkCount++;
      if (x < size - 1 && y < size - 1 && dark[y][x] === dark[y][x + 1] && dark[y][x] === dark[y + 1][x] && dark[y][x] === dark[y + 1][x + 1]) score += 3;
    }
  }
  const total = size * size;
  score += (Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * 10;
  return score;
}

// The smallest version (and the strongest error correction at that size)
// that holds `bytes`, starting from `minEcc`; null if it's too long for a QR code.
export function chooseVersion(length, minEcc = 'M') {
  for (let ver = 1; ver <= 40; ver++) {
    const bits = 4 + countBits(ver) + length * 8;
    if (bits > dataCodewords(ver, minEcc) * 8) continue;
    let ecc = minEcc;
    for (const e of LEVELS.slice(LEVELS.indexOf(minEcc) + 1)) if (bits <= dataCodewords(ver, e) * 8) ecc = e;
    return { version: ver, ecc };
  }
  return null;
}

// text -> { size, version, ecc, mask, modules: rows of booleans }, or null
// when it's too long. ecc is the least error correction to use: a logo in
// the middle needs 'Q' or more, which the overlay asks for.
export function qrMatrix(text, { ecc: minEcc = 'M' } = {}) {
  const bytes = [...new TextEncoder().encode(String(text))];
  const pick = chooseVersion(bytes.length, minEcc);
  if (!pick) return null;
  const { version, ecc } = pick;
  const data = codewords(bytes, version, ecc);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const g = makeGrid(version);
    // Data bits go up and down two-module columns, right to left, skipping the timing column.
    let i = 0;
    for (let right = g.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < g.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const y = ((right + 1) & 2) === 0 ? g.size - 1 - vert : vert;
          if (g.fixed[y][x]) continue;
          g.dark[y][x] = i < data.length * 8 && ((data[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
    applyMask(g, mask);
    drawFormat(g.set, g.size, ecc, mask);
    const score = penalty(g.dark);
    if (!best || score < best.score) best = { score, mask, g };
  }
  return { size: best.g.size, version, ecc, mask: best.mask, modules: best.g.dark };
}
