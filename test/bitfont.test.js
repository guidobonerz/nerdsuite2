import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildBitmapFont, glyphContours } from '../public/js/bitfont.js';

// a reader of what buildBitmapFont writes: the tables, the cmap, the outlines of the glyphs
function readFont(buf) {
  const v = new DataView(buf);
  const n = v.getUint16(4);
  const tables = {};
  for (let k = 0; k < n; k++) {
    const at = 12 + k * 16;
    const tag = String.fromCharCode(...new Uint8Array(buf, at, 4));
    tables[tag] = { sum: v.getUint32(at + 4), offset: v.getUint32(at + 8), length: v.getUint32(at + 12) };
  }
  const sum = (o, l) => { let s = 0; for (let i = 0; i < l; i += 4) s = (s + (i + 4 <= buf.byteLength ? v.getUint32(o + i) : 0)) >>> 0; return s; };
  const head = tables.head.offset, maxp = tables.maxp.offset, loca = tables.loca.offset, glyf = tables.glyf.offset, cmap = tables.cmap.offset;
  const numGlyphs = v.getUint16(maxp + 4);
  const sub = cmap + v.getUint32(cmap + 8), segX2 = v.getUint16(sub + 6);
  const glyphOf = code => {
    for (let s = 0; s < segX2 / 2; s++) {
      const end = v.getUint16(sub + 14 + s * 2), start = v.getUint16(sub + 16 + segX2 + s * 2), delta = v.getUint16(sub + 16 + segX2 * 2 + s * 2);
      if (code >= start && code <= end) return (code + delta) & 0xffff;
    }
    return 0;
  };
  const contours = g => {
    const a = v.getUint32(loca + g * 4), b = v.getUint32(loca + g * 4 + 4);
    if (a === b) return [];
    let p = glyf + a;
    const nc = v.getInt16(p);
    p += 10;
    const ends = [];
    for (let k = 0; k < nc; k++) { ends.push(v.getUint16(p)); p += 2; }
    p += 2 + v.getUint16(p);
    const np = ends.at(-1) + 1;
    p += np;                                        // the flags: all 0x01
    const xs = [], ys = [];
    let x = 0, y = 0;
    for (let k = 0; k < np; k++) { x += v.getInt16(p); p += 2; xs.push(x); }
    for (let k = 0; k < np; k++) { y += v.getInt16(p); p += 2; ys.push(y); }
    const out = [];
    let from = 0;
    for (const e of ends) { out.push(xs.slice(from, e + 1).map((xx, k) => [xx, ys[from + k]])); from = e + 1; }
    return out;
  };
  return { tables, sum, head, numGlyphs, glyphOf, contours, unitsPerEm: v.getUint16(head + 18) };
}

// the winding number of a point: the pixels the outline fills (nonzero)
const winding = (cs, px, py) => {
  let w = 0;
  for (const c of cs) for (let k = 0; k < c.length; k++) {
    const [x1, y1] = c[k], [x2, y2] = c[(k + 1) % c.length];
    const cross = (x2 - x1) * (py - y1) - (px - x1) * (y2 - y1);
    if (y1 <= py) { if (y2 > py && cross > 0) w++; } else if (y2 <= py && cross < 0) w--;
  }
  return w;
};
const area = c => c.reduce((s, [x1, y1], k) => { const [x2, y2] = c[(k + 1) % c.length]; return s + x1 * y2 - x2 * y1; }, 0) / 2;

test('glyphContours: a box with a hole, clockwise outside, the other way round inside', () => {
  const ring = [0xff, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0xff];
  const cs = glyphContours(ring);
  assert.equal(cs.length, 2);
  assert.deepEqual(cs.map(c => c.length), [4, 4]);
  const [outer, inner] = [...cs].sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)));
  assert.ok(area(outer) < 0, 'outer clockwise');
  assert.ok(area(inner) > 0, 'hole counter-clockwise');
  assert.deepEqual(glyphContours(new Uint8Array(8)), []);
});

test('buildBitmapFont: the tables, their checksums, the cmap and every glyph of a charset', () => {
  const data = new Uint8Array(readFileSync(new URL('../examples/demo/gfx/charset/chars.chr', import.meta.url))).slice(0, 2048);
  const font = readFont(buildBitmapFont(data, { ascent: 1.1, descent: 0.3 }));
  assert.deepEqual(Object.keys(font.tables), ['OS/2', 'cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post']);
  for (const [tag, t] of Object.entries(font.tables)) {
    if (tag !== 'head') assert.equal(font.sum(t.offset, t.length), t.sum, `checksum of ${tag}`);
  }
  assert.equal(font.numGlyphs, 257);
  assert.equal(font.unitsPerEm, 2048);
  assert.equal(font.glyphOf(0xee00), 1);
  assert.equal(font.glyphOf(0xeeff), 256);
  assert.equal(font.glyphOf(0x41), 0);
  // the outlines fill the pixels of the charset, and nothing else
  const px = 256;
  const bottom = Math.round(((1.1 - 0.3) / 2 - 0.5) * 2048);
  for (let c = 0; c < 256; c++) {
    const cs = font.contours(c + 1);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const set = (data[c * 8 + y] >> (7 - x) & 1) === 1;
      const filled = winding(cs, x * px + px / 2, bottom + (7 - y) * px + px / 2) !== 0;
      assert.equal(filled, set, `char ${c} pixel ${x},${y}`);
    }
  }
});

test('buildBitmapFont: the whole font sums up to the magic of head', () => {
  const buf = buildBitmapFont(new Uint8Array(2048).fill(0x55));
  const v = new DataView(buf);
  let s = 0;
  for (let i = 0; i < buf.byteLength; i += 4) s = (s + v.getUint32(i)) >>> 0;
  assert.equal(buf.byteLength % 4, 0);
  assert.equal(s, 0xb1b0afba);
});
