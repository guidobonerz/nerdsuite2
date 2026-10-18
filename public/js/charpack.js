// charpack.js - the chars a pixel painted onto a place screen needs (screenpaint.js): a cell whose
// pixels change gets the char with its new 8 bytes - a char the charset already has (the
// duplicate reused), its own char changed in place when no other cell shows it, else a free
// char; none free: the charset is full. Pure logic, no DOM: the screen editor and the tests use it.
//
// The use of a charset is counted over every place that names it (its background, its patches)
// and every tileset bound to it, with the glyph index of a cell: the screen code, or in extended
// color mode its lower 6 bits (64 glyphs, bits 6-7 pick the background). The space (32) is
// always counted as used: the editor pads short lines with it.

import { symbols, getAttr } from './adv.js';
import { linesToMap } from './gfxfile.js';
import { charsetKey } from './chr.js';
import { tilesetByKey, tilesetKey, tilesetCharset } from './tileset.js';

export const SPACE = 32;

// the 8 bytes of a glyph
export const glyphBytes = (data, code) => data.subarray(code * 8, code * 8 + 8);
export const sameGlyph = (a, b) => a.length === 8 && b.length === 8 && a.every((v, k) => v === b[k]);

// the first char of data with these bytes, below limit (256, or 64 in extended color mode), else -1
export function findGlyph(data, bytes, limit = 256) {
  outer: for (let code = 0; code < limit; code++) {
    for (let k = 0; k < 8; k++) if (data[code * 8 + k] !== bytes[k]) continue outer;
    return code;
  }
  return -1;
}

// how often every glyph of the charset at key is shown: Map code -> count, over the backgrounds
// and patches of the places with that charset and the tiles of the tilesets bound to it. The
// space counts once more than anything: it is never free.
export function usedCounts(game, key) {
  const counts = new Map();
  const add = code => counts.set(code, (counts.get(code) ?? 0) + 1);
  add(SPACE);
  if (!game) return counts;
  const S = symbols(game);
  const seenTilesets = new Set();
  for (const r of S.allPlaces ?? S.places) {
    const file = getAttr(r, 'charset');
    const tiles = getAttr(r, 'tiles');
    const own = file && charsetKey(file) === key;
    // a place painted with tiles of a tileset bound to the charset shows its chars too
    let viaTiles = false;
    if (tiles) {
      const tk = tilesetKey(tiles), ts = tilesetByKey(tk);
      if (ts && tilesetCharset(tk, ts) === key) {
        viaTiles = true;
        if (!seenTilesets.has(tk)) { seenTilesets.add(tk); for (const t of ts.tiles) t.chars.forEach(add); }
      }
    }
    if (!own && !viaTiles) continue;
    const ecm = !!getAttr(r, 'ecm');
    const mask = ecm ? 63 : 255;
    for (const m of r.members) {
      if (m.kind !== 'background' && m.kind !== 'patch') continue;
      const map = linesToMap(m.lines ?? [], m.colors, S.charset, m.kind === 'patch');
      for (let k = 0; k < map.chars.length; k++) add(map.chars[k] & mask);
    }
  }
  return counts;
}

// a packer over the charset bytes data and the counts of its use: place() gives a cell its char.
// limit: 256, or 64 in extended color mode. The counts follow every placement, so a stroke over
// many cells allocates right: a char two cells of the stroke take is shared, not written twice.
export function packer(data, counts, { limit = 256 } = {}) {
  const count = code => counts.get(code) ?? 0;
  const move = (from, to) => {
    if (from === to) return;
    if (from != null) counts.set(from, Math.max(0, count(from) - 1));
    counts.set(to, count(to) + 1);
  };
  // the highest free char: the letters at the bottom stay for the text tool as long as they can
  const free = () => { for (let c = limit - 1; c >= 0; c--) if (!count(c)) return c; return -1; };
  const freeCount = () => { let n = 0; for (let c = 0; c < limit; c++) if (!count(c)) n++; return n; };

  // the cell shows the glyph `from` (the index, without the ECM background bits) and wants bytes:
  // { code, write } - write: the 8 bytes go into data at code (done here) - or null: the charset
  // is full. A glyph nobody else shows is changed in place; else the duplicate is reused or a free
  // char is taken
  function place(from, bytes) {
    const same = findGlyph(data, bytes, limit);
    if (same >= 0) { move(from, same); return { code: same, write: false }; }
    if (from != null && from < limit && count(from) <= 1) {
      data.set(bytes, from * 8);
      return { code: from, write: true };
    }
    const code = free();
    if (code < 0) return null;
    data.set(bytes, code * 8);
    move(from, code);
    return { code, write: true };
  }
  return { place, free: freeCount, counts };
}

// the duplicates of a charset: Map code -> the lowest code with the same glyph (only codes that
// have a lower twin), below limit
export function duplicates(data, limit = 256) {
  const first = new Map(), out = new Map();
  for (let code = 0; code < limit; code++) {
    const k = Array.from(glyphBytes(data, code)).join(',');
    if (first.has(k)) out.set(code, first.get(k)); else first.set(k, code);
  }
  return out;
}

// the pixels of one cell: 8 rows of 8 bits -> bytes; px/py in the cell, hires. In multicolor a
// pixel is two bits wide: bit pairs (3 - px) at x = px >> 1
export const bitAt = (bytes, px, py) => (bytes[py] >> (7 - px)) & 1;
export function setBit(bytes, px, py, on) {
  const m = 1 << (7 - px);
  bytes[py] = on ? bytes[py] | m : bytes[py] & ~m;
}
export const pairAt = (bytes, x, py) => (bytes[py] >> (6 - 2 * x)) & 3;
export function setPair(bytes, x, py, v) {
  const sh = 6 - 2 * x;
  bytes[py] = (bytes[py] & ~(3 << sh)) | ((v & 3) << sh);
}
