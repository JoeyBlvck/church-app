// Minimal, dependency-free QR code encoder — vendored rather than imported from npm because the
// client has no build step (plain HTML/JS modules, see README's "Architecture" section) and can't
// pull in an installed package at runtime. Deliberately narrow scope, enough for a short check-in
// URL and nothing more:
//   - Byte mode only (our text is a URL — mixed-case, punctuation — not the restricted 45-char
//     QR "alphanumeric" set).
//   - Error-correction level L only (lowest, ~7% recovery) — fine for a symbol shown on a screen
//     or freshly printed, not one expected to get scratched or dirty; buys more character capacity
//     per version than a higher level would.
//   - Versions 1-6 only (up to 134 bytes) — versions 7+ require an extra 18-bit "version
//     information" block encoded into the symbol (versions 1-6 don't need one; a decoder infers
//     the version from the symbol's size alone), which this encoder doesn't implement. 134 bytes
//     is comfortably more than any check-in URL this app generates.
//   - Always uses mask pattern 0 rather than evaluating all 8 and scoring them for readability —
//     that scoring only matters for resilience against real-world scan noise (glare, skew, low
//     contrast on a damaged print); a mask is still required by the spec, and any valid one
//     decodes correctly on a clean, screen-rendered or freshly-printed code.
//
// Implements ISO/IEC 18004 closely enough to produce a compliant symbol. Verified by round-tripping
// generated symbols (rendered to a bitmap) through an independent decoder (OpenCV's QRCodeDetector)
// across versions 1-6 and the exact byte-length boundaries between them — see the PR/commit notes
// for how, since this can't be re-verified by eye the way most of this codebase can.

const VERSION_INFO = {
  1: { total: 26, ecPerBlock: 7, blocks: 1 },
  2: { total: 44, ecPerBlock: 10, blocks: 1 },
  3: { total: 70, ecPerBlock: 15, blocks: 1 },
  4: { total: 100, ecPerBlock: 20, blocks: 1 },
  5: { total: 134, ecPerBlock: 26, blocks: 1 },
  6: { total: 172, ecPerBlock: 18, blocks: 2 },
};
const REMAINDER_BITS = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7 };
const ALIGNMENT_COORDS = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] };

function dataCapacityBytes(v) {
  const { total, ecPerBlock, blocks } = VERSION_INFO[v];
  const dataCodewords = total - ecPerBlock * blocks;
  const overheadBits = 4 + 8; // mode indicator + byte-mode character-count indicator (versions 1-9)
  return Math.floor((dataCodewords * 8 - overheadBits) / 8);
}

function pickVersion(byteLen) {
  for (let v = 1; v <= 6; v++) if (byteLen <= dataCapacityBytes(v)) return v;
  throw new Error(`That's too much text for this QR code (max ${dataCapacityBytes(6)} bytes, got ${byteLen}).`);
}

// ---- GF(256) tables for Reed-Solomon, QR's field (primitive polynomial x^8+x^4+x^3+x^2+1 = 0x11D) ----
const GF_EXP = new Array(512);
const GF_LOG = new Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();
const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];

// The generator polynomial is product_{i=0}^{degree-1} (x + alpha^i), coefficients low-degree-first.
// Each factor's "x" term shifts every existing coefficient up one degree; its "alpha^i" term scales
// every existing coefficient in place.
function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], GF_EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly;
}

function rsEncode(dataBytes, ecCount) {
  const genHighFirst = rsGeneratorPoly(ecCount).slice().reverse(); // now highest-degree coefficient first
  const msg = dataBytes.concat(new Array(ecCount).fill(0));
  for (let i = 0; i < dataBytes.length; i++) {
    const coef = msg[i];
    if (coef === 0) continue;
    for (let j = 0; j < genHighFirst.length; j++) msg[i + j] ^= gfMul(genHighFirst[j], coef);
  }
  return msg.slice(dataBytes.length);
}

function bitsForBytes(bytes) {
  const bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  return bits;
}

function buildCodewordBits(text, version) {
  const bytes = Array.from(new TextEncoder().encode(text));
  const { total, ecPerBlock, blocks } = VERSION_INFO[version];
  const dataCodewordsTotal = total - ecPerBlock * blocks;

  let bits = [0, 1, 0, 0]; // byte-mode indicator
  for (let i = 7; i >= 0; i--) bits.push((bytes.length >> i) & 1); // 8-bit character count (versions 1-9)
  bits = bits.concat(bitsForBytes(bytes));

  const maxBits = dataCodewordsTotal * 8;
  for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0); // terminator (up to 4 bits)
  while (bits.length % 8 !== 0) bits.push(0); // pad to a byte boundary
  const padBytes = [0xec, 0x11];
  for (let pi = 0; bits.length < maxBits; pi++) bits = bits.concat(bitsForBytes([padBytes[pi % 2]]));

  const dataCodewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    dataCodewords.push(byte);
  }

  // Split into equal-size blocks (versions 1-6 never need uneven block sizes) and Reed-Solomon
  // encode each, then interleave data codewords across blocks, then EC codewords across blocks —
  // this interleaving is what lets a real decoder survive a burst of damage hitting one small
  // area of the symbol, spreading each block's bytes across the whole thing instead of clustering.
  const perBlock = dataCodewords.length / blocks;
  const dataBlocks = [], ecBlocks = [];
  for (let b = 0; b < blocks; b++) {
    const block = dataCodewords.slice(b * perBlock, (b + 1) * perBlock);
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, ecPerBlock));
  }
  const finalCodewords = [];
  for (let i = 0; i < perBlock; i++) for (const block of dataBlocks) finalCodewords.push(block[i]);
  for (let i = 0; i < ecPerBlock; i++) for (const block of ecBlocks) finalCodewords.push(block[i]);

  const finalBits = bitsForBytes(finalCodewords);
  for (let i = 0; i < (REMAINDER_BITS[version] ?? 0); i++) finalBits.push(0);
  return finalBits;
}

// ---- matrix (module grid) construction ----
function makeMatrix(version) {
  const size = version * 4 + 17;
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
  const dark = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (r, c, v) => { if (r >= 0 && r < size && c >= 0 && c < size) { dark[r][c] = v; isFunction[r][c] = true; } };

  function placeFinder(r0, c0) {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const inner = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      if (!inner) { setFn(r0 + r, c0 + c, false); continue; } // 1-module white separator ring
      const onBorder = r === 0 || r === 6 || c === 0 || c === 6;
      const onCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      setFn(r0 + r, c0 + c, onBorder || onCore);
    }
  }
  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); } // timing patterns

  const coords = ALIGNMENT_COORDS[version];
  if (coords.length) {
    const first = coords[0], last = coords[coords.length - 1];
    for (const r of coords) for (const c of coords) {
      if ((r === first && c === first) || (r === first && c === last) || (r === last && c === first)) continue; // overlaps a finder pattern
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) setFn(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }
  }

  setFn(4 * version + 9, 8, true); // the one always-dark module (same row as the 2nd format-info copy's column-8 strip, one row above it — see the reservation below)

  // Reserve format-info areas (values filled in later by placeFormatInfo, once the mask is chosen).
  for (let i = 0; i <= 8; i++) { if (!isFunction[6][i]) setFn(6, i, false); if (!isFunction[8][i]) setFn(8, i, false); if (!isFunction[i][8]) setFn(i, 8, false); }
  for (let i = 0; i < 8; i++) setFn(8, size - 1 - i, false); // 2nd copy, bits 0-7: row 8, rightmost 8 columns
  for (let i = 0; i < 7; i++) setFn(size - 1 - i, 8, false); // 2nd copy, bits 8-14: column 8, bottom 7 rows (the 8th row up is the dark module above, not format info)
  setFn(8, 8, false);

  return { size, isFunction, dark };
}

// Places data bits in the standard boustrophedon: two-column swaths from the bottom-right corner,
// alternating upward/downward, skipping the vertical timing column — and applies mask pattern 0
// ((row + col) % 2 === 0) to every non-function module as it goes.
function placeData(matrix, bits) {
  const { size, isFunction, dark } = matrix;
  let bitIndex = 0;
  const nextBit = () => (bitIndex < bits.length ? bits[bitIndex++] : 0);
  let col = size - 1, dir = -1;
  while (col > 0) {
    if (col === 6) col--;
    for (let i = 0; i < size; i++) {
      const row = dir === -1 ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (isFunction[row][c]) continue;
        const bit = nextBit();
        dark[row][c] = (((row + c) % 2 === 0) ? (bit ^ 1) : bit) === 1;
      }
    }
    col -= 2;
    dir = -dir;
  }
}

// BCH(15,5) error-correction for the 15-bit format-info field (2-bit EC level + 3-bit mask index),
// XORed with the fixed mask 101010000010010 — both straight from the spec (Annex C).
function bchFormatBits(level2, mask3) {
  const data = (level2 << 3) | mask3;
  let rem = data << 10;
  const gen = 0b10100110111;
  for (let i = 4; i >= 0; i--) if (rem & (1 << (i + 10))) rem ^= gen << i;
  const masked = ((data << 10) | rem) ^ 0b101010000010010;
  const out = [];
  for (let i = 14; i >= 0; i--) out.push((masked >> i) & 1);
  return out;
}

function placeFormatInfo(matrix, level2, mask3) {
  const { size, dark } = matrix;
  const bits = bchFormatBits(level2, mask3);
  for (let i = 0; i < 6; i++) dark[8][i] = !!bits[i];
  dark[8][7] = !!bits[6]; dark[8][8] = !!bits[7]; dark[7][8] = !!bits[8];
  for (let i = 9; i < 15; i++) dark[14 - i][8] = !!bits[i];
  for (let i = 0; i < 8; i++) dark[8][size - 1 - i] = !!bits[i];
  for (let i = 8; i < 15; i++) dark[size - 15 + i][8] = !!bits[i];
}

// Returns { size, dark }: dark is a size×size array of booleans (true = a dark/black module).
export function buildQrMatrix(text) {
  const version = pickVersion(Array.from(new TextEncoder().encode(text)).length);
  const matrix = makeMatrix(version);
  placeData(matrix, buildCodewordBits(text, version));
  placeFormatInfo(matrix, 0b01, 0b000); // error-correction level L, mask pattern 0
  return { size: matrix.size, dark: matrix.dark };
}

// Draws the QR code onto a <canvas>, sized to `moduleSize` CSS pixels per module plus a 4-module
// quiet zone on every side (the minimum the spec calls for — most scanners need it to distinguish
// the symbol from its surroundings).
export function renderQrToCanvas(canvas, text, { moduleSize = 8 } = {}) {
  const { size, dark } = buildQrMatrix(text);
  const quiet = 4;
  const px = (size + quiet * 2) * moduleSize;
  canvas.width = px; canvas.height = px;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#000';
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (dark[r][c]) ctx.fillRect((c + quiet) * moduleSize, (r + quiet) * moduleSize, moduleSize, moduleSize);
  return canvas;
}

// A standalone SVG string of the same symbol — used for "download as image" (an <img>/<a download>
// can't point at a live <canvas>, but a data: URI of this SVG works, and also prints crisply at
// any size since it's vector).
export function qrToSvgString(text, { moduleSize = 8 } = {}) {
  const { size, dark } = buildQrMatrix(text);
  const quiet = 4;
  const px = (size + quiet * 2) * moduleSize;
  let rects = '';
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (dark[r][c]) rects += `<rect x="${(c + quiet) * moduleSize}" y="${(r + quiet) * moduleSize}" width="${moduleSize}" height="${moduleSize}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${px} ${px}" width="${px}" height="${px}"><rect width="${px}" height="${px}" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
}
