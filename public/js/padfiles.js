// padfiles.js - the project files of CharPad (.ctm) and SpritePad (.spd) by Subchrist Software,
// read for the Import of the screen, char and sprite editors. Only the reading: what becomes of
// them is in screen.js (a CharPad map: the screen of a place, its charset and colors) and
// sprites.js (SpritePad sprites: a costume).
//
// .ctm 'CTM' 8 (CharPad 2.x / Pro): a header of 14 bytes - display mode (0 text hires, 1 text
//   multicolor, 2 text ECM, 3 bitmap hires, 4 bitmap multicolor), the color method (0 global,
//   1 per tile, 2 per char), flags (bit 0: tiles), the colors $d021, $d022, $d023, $d024 and the
//   base colors of the chars (3) - then blocks, each after a marker of two bytes ($da $bN), in
//   this order: the chars (their count - 1 as a word, 8 bytes each), their materials (a byte
//   each), with the color method 'per char' their colors (a byte each, 2 / 3 in the bitmap
//   modes), with tiles: the tiles (their count - 1 as a word, width, height, then the char of
//   every cell as a word), with 'per tile' their colors, their tags (a byte each) and their
//   names (each ended by 0); last the map: width and height as words, a word per cell - a char,
//   with tiles a tile.
// .spd 'SPD' 5 (SpritePad 2.x / Pro), also 4: a header of 20 bytes - flags, the sprites and the
//   tiles (words), the sprite and tile animations, the tile width and height, the colors (the
//   background, multicolor 1 = $d025, multicolor 2 = $d026), the overlay distance of the
//   sprites and of the tiles (words) - then the sprites, 64 bytes each: 63 of the image, then
//   their attributes (bits 0-3 the sprite color, bit 4 overlay: the sprite the overlay distance
//   further is drawn over it, bit 7 multicolor). After them the tiles: per tile width * height
//   sprite numbers (words). The animations after those are not read.
// .spd 1 (SpritePad 1.x): 9 bytes - 'SPD', 1, the sprites - 1, the animations - 1, the colors.
//
// The layouts follow the readers of Oscar64 (#embed) and of the c64lib retro build tool, checked
// against files of CharPad and SpritePad.

const word = (d, at) => d[at] | d[at + 1] << 8;

// a reader that fails with the name of the file when it runs out of bytes
function cursor(d, what) {
  let at = 0;
  const need = n => { if (at + n > d.length) throw new Error(`${what}: the file ends early (byte ${at} of ${d.length}, ${n} more needed)`); };
  return {
    get at() { return at; },
    byte() { need(1); return d[at++]; },
    word() { need(2); const v = word(d, at); at += 2; return v; },
    bytes(n) { need(n); const v = d.subarray(at, at + n); at += n; return v; },
    marker() { need(2); if (d[at] !== 0xda || (d[at + 1] & 0xf0) !== 0xb0) throw new Error(`${what}: no block marker at byte ${at}`); at += 2; },
    string() { let s = ''; for (;;) { const c = this.byte(); if (!c) return s; s += String.fromCharCode(c); } },
  };
}

export const CTM_MODES = ['text hires', 'text multicolor', 'text ECM', 'bitmap hires', 'bitmap multicolor'];

// a CharPad project: { mode, method, colors: { bg, mc1, mc2, bg4, chars: [3] }, chars: Uint8Array
// (8 bytes each), count, charColors (a color per char, or null), tiles: { w, h, cells: [[char
// codes]], colors } or null, map: { w, h, cells: Uint16Array } }
export function parseCtm(bytes, what = 'CharPad file') {
  const d = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (String.fromCharCode(d[0], d[1], d[2]) !== 'CTM') throw new Error(`${what}: not a CharPad file (no 'CTM' at its start)`);
  const version = d[3];
  if (version !== 8) throw new Error(`${what}: CharPad file version ${version} - only version 8 (CharPad 2.x / Pro) is read; save it again in CharPad`);
  const r = cursor(d, what);
  r.bytes(4);
  const mode = r.byte(), method = r.byte(), flags = r.byte();
  const c = r.bytes(7);
  const colors = { bg: c[0], mc1: c[1], mc2: c[2], bg4: c[3], chars: [c[4], c[5], c[6]] };
  const perColor = mode === 3 ? 2 : mode === 4 ? 3 : 1;
  r.marker();
  const count = r.word() + 1;
  const chars = r.bytes(count * 8);
  r.marker();
  const materials = r.bytes(count);
  let charColors = null;
  if (method === 2) {
    r.marker();
    const raw = r.bytes(count * perColor);
    charColors = Array.from({ length: count }, (_, k) => raw[k * perColor] & 15);
  }
  let tiles = null;
  if (flags & 1) {
    r.marker();
    const n = r.word() + 1, w = r.byte(), h = r.byte();
    const cells = Array.from({ length: n }, () => Array.from({ length: w * h }, () => r.word()));
    let tileColors = null;
    if (method === 1) {
      r.marker();
      const raw = r.bytes(n * perColor);
      tileColors = Array.from({ length: n }, (_, k) => raw[k * perColor] & 15);
    }
    r.marker();
    r.bytes(n);                                   // tags
    r.marker();
    for (let k = 0; k < n; k++) r.string();       // names
    tiles = { w, h, cells, colors: tileColors };
  }
  r.marker();
  const mw = r.word(), mh = r.word();
  const cells = new Uint16Array(mw * mh);
  for (let k = 0; k < cells.length; k++) cells[k] = r.word();
  return { version, mode, method, flags, colors, count, chars, materials, charColors, tiles, map: { w: mw, h: mh, cells } };
}

// the map of a CharPad project as a screen: { w, h, chars, colors } in screen codes and colors
// (0-15; bit 3 a multicolor char in multicolor mode), tiles expanded into their chars
export function ctmScreen(p) {
  const { map, tiles } = p;
  const tw = tiles?.w ?? 1, th = tiles?.h ?? 1, w = map.w * tw, h = map.h * th;
  const chars = new Uint8Array(w * h), colors = new Uint8Array(w * h);
  for (let y = 0; y < map.h; y++) {
    for (let x = 0; x < map.w; x++) {
      const v = map.cells[y * map.w + x];
      for (let j = 0; j < th; j++) {
        for (let i = 0; i < tw; i++) {
          const ch = tiles ? tiles.cells[v]?.[j * tw + i] ?? 0 : v, at = (y * th + j) * w + x * tw + i;
          chars[at] = ch & 0xff;
          colors[at] = p.method === 2 ? p.charColors[ch] ?? 0 : p.method === 1 ? tiles?.colors?.[v] ?? 0 : p.colors.chars[0] & 15;
        }
      }
    }
  }
  return { w, h, chars, colors };
}

// a SpritePad project: { version, colors: { bg, mc1, mc2 }, sprites: [{ data (64 bytes), color,
// multicolor, overlay }], overlay (the distance of an overlay sprite), tiles: { w, h, list: [[sprite
// numbers]] } or null, anims (how many the file has: not read) }
export function parseSpd(bytes, what = 'SpritePad file') {
  const d = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (String.fromCharCode(d[0], d[1], d[2]) !== 'SPD') throw new Error(`${what}: not a SpritePad file (no 'SPD' at its start)`);
  const version = d[3], r = cursor(d, what);
  r.bytes(4);
  let n, tilesN = 0, tw = 0, th = 0, anims, colors, overlay = 1;
  if (version === 4 || version === 5) {
    r.byte();                                     // flags
    n = r.word();
    tilesN = r.word();
    anims = r.byte();
    r.byte();                                     // tile animations
    tw = r.byte();
    th = r.byte();
    colors = { bg: r.byte() & 15, mc1: r.byte() & 15, mc2: r.byte() & 15 };
    overlay = r.word() || 1;
    r.word();                                     // the overlay distance of the tiles
  } else if (version === 1) {
    n = r.byte() + 1;
    anims = r.byte() + 1;
    colors = { bg: r.byte() & 15, mc1: r.byte() & 15, mc2: r.byte() & 15 };
  } else {
    throw new Error(`${what}: SpritePad file version ${version} - versions 1, 4 and 5 are read; save it again in SpritePad`);
  }
  const sprites = Array.from({ length: n }, () => {
    const data = r.bytes(64), attr = data[63];
    return { data, color: attr & 15, multicolor: !!(attr & 0x80), overlay: !!(attr & 0x10) };
  });
  let tiles = null;
  if (tilesN && tw && th) {
    tiles = { w: tw, h: th, list: Array.from({ length: tilesN }, () => Array.from({ length: tw * th }, () => r.word())) };
  }
  return { version, colors, sprites, overlay, tiles, anims };
}
