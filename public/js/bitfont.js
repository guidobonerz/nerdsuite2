// bitfont.js - a charset of the project (8x8 pixels, 8 bytes a character, bit 7 the left pixel) as a
// TrueType font: the code editor draws the bytes of BASIC strings with it as it draws them with the C64
// font (codeeditor.js setCustomGlyphs, the PETSCII panel). Character n is U+EE00 + n (the place of the
// screen codes of the C64 font); every glyph is 1 em wide and 1 em high, a pixel 1/8 em.
//
//   buildBitmapFont(bytes, { name, ascent, descent }) -> ArrayBuffer (a .ttf)
//     ascent, descent: the line of the font in em; the glyphs are centred in it
//
// The outline of a glyph is the border of its pixels: every edge of a set pixel that no other set pixel
// shares, chained into closed contours (clockwise around the pixels, a hole the other way round).

const UNITS = 2048, PX = UNITS / 8, FIRST = 0xee00;

// the contours of a glyph: [[[x, y], ...]] in units, y up, from its 8 bytes; bottom: y of its lowest row
export function glyphContours(rows, bottom = 0) {
  const on = (x, y) => x >= 0 && x < 8 && y >= 0 && y < 8 && (rows[y] >> (7 - x) & 1) === 1;
  const edges = new Map();             // 'x,y' of a start -> [[x, y] of the end]  (in pixel corners, y down)
  const add = (a, b) => { const k = `${a[0]},${a[1]}`; (edges.get(k) ?? edges.set(k, []).get(k)).push(b); };
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (!on(x, y)) continue;
      // clockwise on the screen with y up = these, with y down: top left -> top right -> ... (each side
      // only where the neighbour is not set)
      if (!on(x, y - 1)) add([x, y], [x + 1, y]);
      if (!on(x + 1, y)) add([x + 1, y], [x + 1, y + 1]);
      if (!on(x, y + 1)) add([x + 1, y + 1], [x, y + 1]);
      if (!on(x - 1, y)) add([x, y + 1], [x, y]);
    }
  }
  const contours = [];
  for (;;) {
    const startKey = edges.keys().next().value;
    if (startKey == null) break;
    const pts = [];
    let key = startKey;
    for (;;) {
      const list = edges.get(key);
      if (!list) break;
      const next = list.pop();
      if (!list.length) edges.delete(key);
      pts.push(key.split(',').map(Number));
      key = `${next[0]},${next[1]}`;
      if (key === startKey) break;
    }
    // no points in the middle of a straight side
    const n = pts.length;
    const corners = pts.filter((p, i) => {
      const a = pts[(i + n - 1) % n], b = pts[(i + 1) % n];
      return (b[0] - a[0]) * (p[1] - a[1]) !== (b[1] - a[1]) * (p[0] - a[0]);
    });
    // y down in pixels -> y up in units: the glyph looks the same, so its contours stay clockwise
    contours.push(corners.map(([x, y]) => [x * PX, bottom + (8 - y) * PX]));
  }
  return contours;
}

// --- the tables -------------------------------------------------------------------------------------------

class Out {
  constructor() { this.bytes = []; }
  u8(v) { this.bytes.push(v & 0xff); return this; }
  u16(v) { return this.u8(v >> 8).u8(v); }
  i16(v) { return this.u16(v < 0 ? v + 0x10000 : v); }
  u32(v) { return this.u16(v >>> 16).u16(v & 0xffff); }
  tag(s) { for (const c of s) this.u8(c.charCodeAt(0)); return this; }
  zeros(n) { for (let k = 0; k < n; k++) this.u8(0); return this; }
  pad() { while (this.bytes.length % 4) this.u8(0); return this; }
  get length() { return this.bytes.length; }
}

function checksum(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) sum = (sum + ((bytes[i] << 24) | ((bytes[i + 1] ?? 0) << 16) | ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0))) >>> 0;
  return sum;
}

export function buildBitmapFont(data, { name = 'PETSCII Custom', ascent = 1, descent = 0, count = 256 } = {}) {
  const asc = Math.round(ascent * UNITS), desc = Math.round(descent * UNITS);
  // the glyph in the middle of the line
  const bottom = Math.round(((ascent - descent) / 2 - 0.5) * UNITS);
  const numGlyphs = count + 1;                         // .notdef, then the characters

  // glyf and loca
  const glyf = new Out(), loca = [0, 0];               // .notdef: empty
  const boxes = [{ xMin: 0, yMin: 0, xMax: 0, yMax: 0, empty: true }];
  let maxPoints = 0, maxContours = 0;
  for (let c = 0; c < count; c++) {
    const contours = glyphContours(data.subarray(c * 8, c * 8 + 8), bottom);
    if (contours.length) {
      const all = contours.flat();
      const box = { xMin: Math.min(...all.map(p => p[0])), yMin: Math.min(...all.map(p => p[1])), xMax: Math.max(...all.map(p => p[0])), yMax: Math.max(...all.map(p => p[1])) };
      boxes.push(box);
      glyf.i16(contours.length).i16(box.xMin).i16(box.yMin).i16(box.xMax).i16(box.yMax);
      let end = -1;
      for (const ct of contours) { end += ct.length; glyf.u16(end); }
      glyf.u16(0);                                      // no instructions
      for (let k = 0; k < all.length; k++) glyf.u8(0x01);   // on the curve, x and y as words
      let px = 0, py = 0;
      for (const [x] of all) { glyf.i16(x - px); px = x; }
      for (const [, y] of all) { glyf.i16(y - py); py = y; }
      glyf.pad();
      maxPoints = Math.max(maxPoints, all.length);
      maxContours = Math.max(maxContours, contours.length);
    } else boxes.push({ xMin: 0, yMin: 0, xMax: 0, yMax: 0, empty: true });
    loca.push(glyf.length);
  }
  const drawn = boxes.filter(b => !b.empty);
  const fontBox = drawn.length
    ? { xMin: Math.min(...drawn.map(b => b.xMin)), yMin: Math.min(...drawn.map(b => b.yMin)), xMax: Math.max(...drawn.map(b => b.xMax)), yMax: Math.max(...drawn.map(b => b.yMax)) }
    : { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };

  const locaT = new Out();
  for (const o of loca) locaT.u32(o);

  const head = new Out().u32(0x00010000).u32(0x00010000).u32(0).u32(0x5f0f3cf5).u16(0x000b).u16(UNITS)
    .zeros(16)                                          // created, modified
    .i16(fontBox.xMin).i16(fontBox.yMin).i16(fontBox.xMax).i16(fontBox.yMax)
    .u16(0).u16(8).i16(2).i16(1).i16(0);                // macStyle, lowestRecPPEM, direction, long loca, glyph format

  const hhea = new Out().u32(0x00010000).i16(asc).i16(-desc).i16(0).u16(UNITS)
    .i16(fontBox.xMin).i16(UNITS - fontBox.xMax).i16(fontBox.xMax)
    .i16(1).i16(0).i16(0).zeros(8).i16(0).u16(numGlyphs);

  const hmtx = new Out();
  for (const b of boxes) hmtx.u16(UNITS).i16(b.xMin);

  const maxp = new Out().u32(0x00010000).u16(numGlyphs).u16(maxPoints).u16(maxContours).u16(0).u16(0)
    .u16(2).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0);

  // cmap: format 4, U+EE00.. -> glyph 1.., and the end segment
  const segs = [{ start: FIRST, end: FIRST + count - 1, delta: (1 - FIRST) & 0xffff }, { start: 0xffff, end: 0xffff, delta: 1 }];
  const segX2 = segs.length * 2;
  const entrySel = Math.floor(Math.log2(segs.length));
  const sub = new Out().u16(4).u16(16 + segs.length * 8).u16(0).u16(segX2).u16(2 ** entrySel * 2).u16(entrySel).u16(segX2 - 2 ** entrySel * 2);
  for (const s of segs) sub.u16(s.end);
  sub.u16(0);
  for (const s of segs) sub.u16(s.start);
  for (const s of segs) sub.u16(s.delta);
  for (const s of segs) sub.u16(0);                     // idRangeOffset
  const cmap = new Out().u16(0).u16(1).u16(3).u16(1).u32(12);
  cmap.bytes.push(...sub.bytes);

  const os2 = new Out().u16(4).i16(UNITS).u16(400).u16(5).u16(0)
    .i16(UNITS / 2).i16(UNITS / 2).i16(0).i16(UNITS / 4).i16(UNITS / 2).i16(UNITS / 2).i16(0).i16(UNITS / 2).i16(PX).i16(UNITS / 2)
    .i16(0).zeros(10)                                   // family class, panose
    .u32(0).u32(0x10000000).u32(0).u32(0)                // unicode ranges: bit 60, the private use area
    .tag('NERD').u16(0x0040).u16(FIRST).u16(FIRST + count - 1)
    .i16(asc).i16(-desc).i16(0).u16(Math.max(asc, fontBox.yMax, 0)).u16(Math.max(desc, -fontBox.yMin, 0))
    .u32(1).u32(0).i16(UNITS / 2).i16(UNITS).u16(0).u16(32).u16(1);

  // name: the family, the style, the full name, the PostScript name (UTF-16)
  const names = [[1, name], [2, 'Regular'], [3, `${name} Regular`], [4, name], [6, name.replace(/[^A-Za-z0-9-]/g, '')]];
  const strings = names.map(([, s]) => [...s].flatMap(ch => [ch.charCodeAt(0) >> 8, ch.charCodeAt(0) & 0xff]));
  const nameT = new Out().u16(0).u16(names.length).u16(6 + names.length * 12);
  let at = 0;
  names.forEach(([id], k) => { nameT.u16(3).u16(1).u16(0x409).u16(id).u16(strings[k].length).u16(at); at += strings[k].length; });
  for (const s of strings) nameT.bytes.push(...s);

  const post = new Out().u32(0x00030000).u32(0).i16(-PX).i16(PX / 2).u32(1).u32(0).u32(0).u32(0).u32(0);

  const tables = [['OS/2', os2], ['cmap', cmap], ['glyf', glyf], ['head', head], ['hhea', hhea], ['hmtx', hmtx], ['loca', locaT], ['maxp', maxp], ['name', nameT], ['post', post]];
  const font = new Out();
  const entry = Math.floor(Math.log2(tables.length));
  font.u32(0x00010000).u16(tables.length).u16(2 ** entry * 16).u16(entry).u16(tables.length * 16 - 2 ** entry * 16);
  let offset = 12 + tables.length * 16;
  const placed = tables.map(([tag, t]) => {
    const p = { tag, t, offset, length: t.length, sum: checksum(t.bytes) };
    offset += Math.ceil(t.length / 4) * 4;
    return p;
  });
  for (const p of placed) font.tag(p.tag).u32(p.sum).u32(p.offset).u32(p.length);
  for (const p of placed) { font.bytes.push(...p.t.bytes); font.pad(); }
  // head.checkSumAdjustment: the whole font sums up to 0xb1b0afba
  const adjust = (0xb1b0afba - checksum(font.bytes)) >>> 0;
  const headAt = placed.find(p => p.tag === 'head').offset + 8;
  font.bytes[headAt] = adjust >>> 24; font.bytes[headAt + 1] = adjust >>> 16 & 0xff; font.bytes[headAt + 2] = adjust >>> 8 & 0xff; font.bytes[headAt + 3] = adjust & 0xff;
  return new Uint8Array(font.bytes).buffer;
}
