// gfxfile.js - the graphics files of a script (advc/adv/gfx.go has the format)
//
//   place NAME { gfx "gfx/NAME.gfx" ... patch NAME at X Y }   the screen and the patches, with colors
//   costume NAME "gfx/NAME.spr" { anim ... }                  frames, layers, mode, size, colors
//   sprite NAME "gfx/sprite_NAME.spr" [hotspot X Y]           one frame
//
// The parser reads a file into the same model an inline block gives (glyph lines, color digits,
// sprite art), so the editors do not know where the art is kept. The serializer writes it back.

import { AdvError, COLOR_NAMES, SPRITE_COLS, SPRITE_ROWS, SPRITE_BLOCK, spriteRowBytes, decodeSprite, encodeSprite, spriteWidth, fingerprint, symbols, layerMulticolor, newId, MAX_CANVAS } from './adv.js';
import { PETSCII_UPPER, PETSCII_LOWER, colorDigit, digitColor, isPetscii, screencode } from './petscii.js';
import { numValue } from './advgen.js';
import { withTag, readTag } from './filetag.js';

const VERSION = 1;
const TILE_MAPS = 2;            // a .gfx with a tile map after the patches (tileset.js)
const LOOK = 3;                 // a screen with its look after the tile map: mode, colours, charset, tileset, layers (screenLook)
const NO_COLOR = 0xff;

// where a new file goes (layout.js): a screen into gfx/screen/ (.scr), a costume and a sprite into
// gfx/sprite/ - dir: the gfx folder (gfxDir), the scripts are at the top level of the project
export const gfxDir = () => 'gfx';
export const scrPath = (place, dir = 'gfx') => `${dir}/screen/${place}.scr`;
// the directory art of a .d64: canvases of a folder of their own, the script names the one in use
// (dirart "gfx/dirart/NAME.scr")
export const dirartPath = (name, dir = 'gfx') => `${dir}/dirart/${name}.scr`;
export const isDirartFile = (path, dir = 'gfx') => path.startsWith(dir + '/dirart/') && /\.scr$/i.test(path) && !path.slice(dir.length + 8).includes('/');
export const sprPath = (costume, dir = 'gfx') => `${dir}/sprite/${costume}.spr`;
export const spritePath = (sprite, dir = 'gfx') => `${dir}/sprite/sprite_${sprite}.spr`;

// --- bytes ----------------------------------------------------------------------------

class Reader {
  constructor(data, what) { this.d = data; this.p = 0; this.what = what; }
  byte() {
    if (this.p >= this.d.length) throw new Error(`${this.what}: the file ends too early`);
    return this.d[this.p++];
  }
  bytes(n) {
    if (this.p + n > this.d.length) throw new Error(`${this.what}: the file ends too early`);
    this.p += n;
    return this.d.slice(this.p - n, this.p);
  }
  name() { return String.fromCharCode(...this.bytes(this.byte())); }
  // the magic and the version, which must be VERSION up to newest
  head(magic, newest = VERSION) {
    if (String.fromCharCode(...this.bytes(4)) !== magic) throw new Error(`${this.what}: not a ${magic} file`);
    const v = this.byte();
    if (v < VERSION || v > newest) throw new Error(`${this.what}: version ${v}, the editor reads ${VERSION}${newest > VERSION ? ' to ' + newest : ''}`);
    return v;
  }
  map() {
    const w = this.byte(), h = this.byte(), flags = this.byte();
    const chars = this.bytes(w * h);
    return { w, h, chars, colors: flags & 1 ? this.bytes(w * h) : null };
  }
}

class Out {
  constructor() { this.a = []; }
  byte(...v) { for (const b of v) this.a.push(b & 0xff); }
  bytes(d) { for (const b of d) this.a.push(b); }
  name(s) {
    if (!/^[\x20-\x7e]{0,255}$/.test(s)) throw new Error(`'${s}' cannot be a name in a graphics file`);
    this.byte(s.length, ...[...s].map(c => c.charCodeAt(0)));
  }
  map(m) {
    this.byte(m.w, m.h, m.colors ? 1 : 0);
    this.bytes(m.chars);
    if (m.colors) this.bytes(m.colors);
  }
  done() { return Uint8Array.from(this.a); }
}

// --- screens ----------------------------------------------------------------------------

export function decodeScreen(data, what = 'screen') {
  const r = new Reader(readTag(data).data, what);   // the tag of the editor that wrote it: off first (filetag.js)
  const v = r.head('YSCR', LOOK);
  const screen = r.map();
  const patches = new Map();
  for (let n = r.byte(); n > 0; n--) {
    const name = r.name();
    patches.set(name, r.map());
  }
  let tiles = null;                    // version 2: the tile map, {size, w, h, cells} (tileset.js)
  if (v >= TILE_MAPS) {
    const size = r.byte(), w = r.byte(), h = r.byte();
    tiles = { size, w, h, cells: [...r.bytes(w * h)] };
    if (!size) tiles = null;                   // version 3 without a tile map
  }
  // version 3: the look of a screen - multicolor (bit 0) or extended colour mode (bit 1), its colours
  // (the TED's up to 127), its charset file (empty: the ROM font), its tileset file (empty: none) and
  // where its layers are (the patches above: name, column, row)
  let look = null;
  if (v >= LOOK) {
    const flags = r.byte(), [bg, border, text, mc1, mc2, e1, e2, e3] = [...r.bytes(8)];
    look = { bg, border, text, multicolor: flags & 1 ? [mc1, mc2] : null, ecm: flags & 2 ? [e1, e2, e3] : null, charset: r.name() || null, tiles: r.name() || null, patches: [] };
    for (let n = r.byte(); n > 0; n--) look.patches.push({ name: r.name(), col: r.byte(), row: r.byte() });
    // the colour registers of an Atari screen (COLOR0-COLOR4), when the file has them
    look.registers = r.p < r.d.length ? [...r.bytes(r.byte())] : null;
    if (!look.registers?.length) look.registers = null;
  }
  return { screen, patches, tiles, look };
}

// a screen with a look is version 3, with a tile map version 2, without either version 1 as before
export function encodeScreen({ screen, patches, tiles = null, look = null }) {
  const o = new Out();
  o.byte(...[...'YSCR'].map(c => c.charCodeAt(0)), look ? LOOK : tiles ? TILE_MAPS : VERSION);
  o.map(screen);
  o.byte(patches.size);
  for (const [name, m] of patches) { o.name(name); o.map(m); }
  if (tiles) { o.byte(tiles.size, tiles.w, tiles.h); o.bytes(tiles.cells); } else if (look) o.byte(0, 0, 0);
  if (look) {
    const [mc1, mc2] = look.multicolor ?? [0, 0], [e1, e2, e3] = look.ecm ?? [0, 0, 0];
    o.byte((look.multicolor ? 1 : 0) | (look.ecm ? 2 : 0), look.bg ?? 0, look.border ?? 0, look.text ?? 1, mc1, mc2, e1, e2, e3);
    o.name(look.charset ?? '');
    o.name(look.tiles ?? '');
    const at = look.patches ?? [];
    o.byte(at.length);
    for (const p of at) { o.name(p.name); o.byte(p.col, p.row); }
    const regs = look.registers ?? [];
    o.byte(regs.length);
    o.bytes(regs.map(v => v & 0x7f));
  }
  return withTag(o.done());
}

// the look of a screen from its attributes (bgcolor, border, textcolor, multicolor, ecm, charset, tiles) and
// its layers, null when it has none: a screen without them is written as before
const NAMED = Object.fromEntries(COLOR_NAMES.map((n, k) => [n, k]));
const colorOf = v => NAMED[String(v).toLowerCase()] ?? (numValue(v, {}) ?? 0) & 0x7f;
export const LOOK_ATTRS = ['bgcolor', 'border', 'textcolor', 'multicolor', 'ecm', 'charset', 'tiles', 'registers'];
export function screenLook(place) {
  const attr = key => place.members.find(x => x.kind === 'attr' && x.key === key);
  const patches = place.members.filter(m => m.kind === 'patch');
  if (!LOOK_ATTRS.some(attr) && !patches.length) return null;
  const one = (key, d) => (attr(key) ? colorOf(attr(key).values[0]) : d);
  const str = key => attr(key)?.str ?? attr(key)?.values?.[0] ?? null;
  return { bg: one('bgcolor', 0), border: one('border', 0), text: one('textcolor', 1),
    multicolor: attr('multicolor')?.values.map(colorOf) ?? null, ecm: attr('ecm')?.values.map(colorOf) ?? null, charset: str('charset'), tiles: str('tiles'),
    registers: attr('registers')?.values.map(colorOf) ?? null,
    patches: patches.map(p => ({ name: p.name, col: (numValue(p.col, {}) ?? 0) & 0xff, row: (numValue(p.row, {}) ?? 0) & 0xff })) };
}
// the attributes of a look, as the screen editor writes them
export function lookAttrs(look) {
  if (!look) return [];
  const name = k => (k < 16 ? COLOR_NAMES[k] : String(k));
  const a = (key, values) => ({ id: newId(), kind: 'attr', key, values });
  return [a('bgcolor', [name(look.bg)]), a('border', [name(look.border)]), a('textcolor', [name(look.text)]),
    ...(look.multicolor ? [a('multicolor', look.multicolor.map(name))] : []), ...(look.ecm ? [a('ecm', look.ecm.map(name))] : []),
    ...(look.registers ? [a('registers', look.registers.map(String))] : []),
    ...(look.charset ? [{ id: newId(), kind: 'attr', key: 'charset', str: look.charset }] : []),
    ...(look.tiles ? [{ id: newId(), kind: 'attr', key: 'tiles', str: look.tiles }] : [])];
}

// the layers of a screen file (the patches of the file at the places of its look)
const layersOf = (file, look, charset) => (look?.patches ?? []).filter(p => file.patches.has(p.name)).map(p => ({
  id: newId(), kind: 'patch', name: p.name, col: p.col, row: p.row, ...mapToLines(file.patches.get(p.name), charset) }));

// a place of a project of before (place NAME { screen { ... gfx "FILE" } patch ... }) as a screen: its size
// the size of its map, its look and its layers - the parts of the adventure game (objects, walk areas, the
// conditions of the layers) are left out. Its file: gfx/screen/NAME.scr, NAME the name of its old file
export function placeToScreen(place, game) {
  const bg = place.members.find(m => m.kind === 'background');
  const lines = bg?.lines ?? [];
  const cols = Math.max(1, ...lines.map(l => [...l].length)), rows = Math.max(1, lines.length);
  const name = bg?.file ? canvasName(bg.file).replace(/\.gfx$/i, '') : place.name;
  const { file, _form, ...background } = bg ?? { id: newId(), kind: 'background', lines: [], colors: null };
  return { id: place.id, kind: 'place', keyword: 'place', name, canvas: { cols: Math.min(cols, MAX_CANVAS), rows: Math.min(rows, MAX_CANVAS) }, _noActors: true,
    members: [
      ...place.members.filter(m => m.kind === 'attr' && LOOK_ATTRS.includes(m.key)),
      { ...background, colors: background.colors ?? Array(rows).fill('.'.repeat(cols)) },
      ...place.members.filter(m => m.kind === 'patch').map(({ cond, _form: f, ...p }) => ({ ...p, col: numValue(p.col, {}) ?? 0, row: numValue(p.row, {}) ?? 0 })),
    ] };
}

// a map of the file as model lines: glyphs of the game's character set, color digits ('.': the
// text color of the place)
export function mapToLines(m, charset = 'lower') {
  const base = charset === 'upper' ? PETSCII_UPPER : PETSCII_LOWER;
  const lines = [], colors = m.colors ? [] : null;
  for (let y = 0; y < m.h; y++) {
    let l = '', c = '';
    for (let x = 0; x < m.w; x++) {
      l += String.fromCharCode(base + m.chars[y * m.w + x]);
      if (m.colors) { const v = m.colors[y * m.w + x]; c += v === NO_COLOR ? '.' : colorDigit(v); }
    }
    lines.push(l);
    if (colors) colors.push(c);
  }
  return { lines, colors };
}

// model lines as a map of the file. Text characters are resolved as the compiler does; a cell
// keeps the text color of the place (no color) unless a digit gives one.
// patch: trailing empty lines do not count, like in the compiler
export function linesToMap(lines, colorLines, charset, patch = false) {
  let h = lines.length;
  if (patch) while (h > 0 && lines[h - 1] === '') h--;
  const w = Math.max(0, ...lines.slice(0, h).map(l => [...l].length));
  const chars = new Uint8Array(w * h), colors = new Uint8Array(w * h).fill(NO_COLOR);
  let colored = false;
  for (let y = 0; y < h; y++) {
    const text = [...lines[y]], ctext = [...(colorLines?.[y] ?? '')];
    for (let x = 0; x < w; x++) {
      const ch = text[x] ?? ' ';
      let color = NO_COLOR;
      const code = isPetscii(ch) ? ch.charCodeAt(0) & 0xff : screencode(ch, charset);
      const d = ctext[x] ? digitColor(ctext[x]) : -1;
      if (d >= 0) color = d;
      chars[y * w + x] = code;
      colors[y * w + x] = color;
      if (color !== NO_COLOR) colored = true;
    }
  }
  return { w, h, chars, colors: colored || colorLines ? colors : null };
}

// --- sprites ----------------------------------------------------------------------------

// art of sw x sh sprites -> sw*sh sprite blocks, part by part, row by row - the blocks of the machine (adv.js
// SPRITE_BLOCK: the C64's 64 bytes, an Atari player's 16)
function artToBlocks(lines, multicolor, sw, sh) {
  const grid = decodeSprite(lines, multicolor, sw, sh);
  const pw = spriteWidth(multicolor), rb = spriteRowBytes();
  const out = new Uint8Array(sw * sh * SPRITE_BLOCK);
  for (let py = 0; py < sh; py++) {
    for (let px = 0; px < sw; px++) {
      const at = (py * sw + px) * SPRITE_BLOCK;
      for (let y = 0; y < SPRITE_ROWS; y++) {
        for (let x = 0; x < pw; x++) {
          const v = grid[py * SPRITE_ROWS + y][px * pw + x];
          if (multicolor) out[at + y * rb + (x >> 2)] |= v << (6 - 2 * (x & 3));
          else if (v) out[at + y * rb + (x >> 3)] |= 0x80 >> (x & 7);
        }
      }
    }
  }
  return out;
}

// the art of sw x sh sprites as C64 sprite blocks of 64 bytes (63 and a pad byte): an export
// (sprites.js) that other tools read
export const spriteBlocks = (lines, multicolor, sw = 1, sh = 1) => artToBlocks(lines, multicolor, sw, sh);

// C64 sprite blocks of sw x sh sprites (64 bytes each, part by part, row by row) -> art lines: an import (sprites.js)
export function blocksToArt(data, multicolor, sw, sh) {
  const pw = spriteWidth(multicolor), rb = spriteRowBytes();
  const grid = Array.from({ length: SPRITE_ROWS * sh }, (_, y) => Array.from({ length: pw * sw }, (_, x) => {
    const at = ((Math.floor(y / SPRITE_ROWS) * sw) + Math.floor(x / pw)) * SPRITE_BLOCK + (y % SPRITE_ROWS) * rb;
    const px = x % pw;
    return multicolor ? (data[at + (px >> 2)] >> (6 - 2 * (px & 3))) & 3 : (data[at + (px >> 3)] & (0x80 >> (px & 7)) ? 2 : 0);
  }));
  return encodeSprite(grid, multicolor);
}

// version 2: a sprite of another size than the C64's - its columns and rows after the mode (an Atari player)
const SPRITE_SIZE = 2;
export function decodeSprites(data, what = 'sprites') {
  const r = new Reader(readTag(data).data, what);
  const v = r.head('YSPR', SPRITE_SIZE);
  const flags = r.byte();
  const [cols, rows] = v >= SPRITE_SIZE ? [r.byte(), r.byte()] : [24, 21];
  if (cols !== SPRITE_COLS || rows !== SPRITE_ROWS) throw new Error(`${what}: sprites of ${cols} x ${rows} pixels - this machine's are ${SPRITE_COLS} x ${SPRITE_ROWS}`);
  const s = { multicolor: !!(flags & 1), w: r.byte(), h: r.byte(), colors: [], frames: [], layers: [] };
  for (let n = r.byte(); n > 0; n--) s.colors.push(r.byte());
  const frames = () => {
    const out = [];
    for (let n = r.byte(); n > 0; n--) {
      const name = r.name();
      const flags = r.byte();
      out.push({ name, default: !!(flags & 1), data: r.bytes(s.w * s.h * SPRITE_BLOCK) });
    }
    return out;
  };
  s.frames = frames();
  for (let n = r.byte(); n > 0; n--) {
    const name = r.name();
    const flags = r.byte(), color = r.byte();
    s.layers.push({ name, overlay: !!(flags & 1), multicolor: !!(flags & 2), color: flags & 4 ? color : null, frames: frames() });
  }
  return s;
}

export function encodeSprites(s) {
  const o = new Out();
  const c64 = SPRITE_COLS === 24 && SPRITE_ROWS === 21;                  // the C64's: version 1 as before
  o.byte(...[...'YSPR'].map(c => c.charCodeAt(0)), c64 ? VERSION : SPRITE_SIZE, s.multicolor ? 1 : 0, ...(c64 ? [] : [SPRITE_COLS, SPRITE_ROWS]), s.w, s.h, s.colors.length, ...s.colors);
  const frames = list => {
    o.byte(list.length);
    for (const f of list) { o.name(f.name); o.byte(f.default ? 1 : 0); o.bytes(f.data); }
  };
  frames(s.frames);
  o.byte(s.layers.length);
  for (const l of s.layers) {
    o.name(l.name);
    o.byte((l.overlay ? 1 : 0) | (l.multicolor ? 2 : 0) | (l.color != null ? 4 : 0), l.color ?? 0);
    frames(l.frames);
  }
  return withTag(o.done());
}

const colorName = v => (v < 16 ? COLOR_NAMES[v] : String(v & 0x7f));   // a number beyond the C64's 16 (video.js)

// a costume node of the model from its file
export function costumeFromFile(n, data) {
  const s = decodeSprites(data, n.file);
  if (s.multicolor) n.multicolor = true;
  if (s.w !== 1 || s.h !== 1) n.size = [String(s.w), String(s.h)];
  if (s.colors.length) n.colors = s.colors.map(colorName);
  n.frames = s.frames.map(f => ({ name: f.name, ...(f.default ? { default: true } : {}), lines: blocksToArt(f.data, s.multicolor, s.w, s.h) }));
  // (a layer keeps the file's old overlay flag, so an unchanged file is written back as it was)
  n.layers = s.layers.map(l => ({ name: l.name, multicolor: !!l.multicolor, ...(l.overlay ? { overlay: true } : {}),
    ...(l.color != null ? { color: colorName(l.color) } : {}), frames: l.frames.map(f => ({ name: f.name, lines: blocksToArt(f.data, l.multicolor, s.w, s.h) })) }));
}

export function costumeToFile(n, consts) {
  const num = (v, what) => {
    const x = numValue(v, consts);
    if (x == null) throw new Error(`costume '${n.name}': ${what} '${v}' is not a number`);
    return x;
  };
  const [w, h] = n.size ? n.size.map(v => num(v, 'size')) : [1, 1];
  return encodeSprites({
    multicolor: !!n.multicolor, w, h,
    colors: (n.colors ?? []).map(v => num(v, 'color') & 0x7f),
    frames: n.frames.map(f => ({ name: f.name, default: !!f.default, data: artToBlocks(f.lines, !!n.multicolor, w, h) })),
    layers: n.layers.map(l => ({ name: l.name, overlay: !!l.overlay, multicolor: layerMulticolor(n, l),
      color: l.color != null ? num(l.color, 'color') & 0x7f : null,
      frames: l.frames.map(f => ({ name: f.name, data: artToBlocks(f.lines, layerMulticolor(n, l), w, h) })) })),
  });
}

export function spriteFromFile(n, data) {
  const s = decodeSprites(data, n.file);
  if (s.frames.length !== 1 || s.w !== 1 || s.h !== 1) throw new Error(`${n.file}: a sprite file holds one frame of one sprite`);
  if (s.multicolor) n.multicolor = true; else delete n.multicolor;
  n.lines = blocksToArt(s.frames[0].data, s.multicolor, 1, 1);
}

export const spriteToFile = n => encodeSprites({ multicolor: !!n.multicolor, w: 1, h: 1, colors: [],
  frames: [{ name: n.name, default: true, data: artToBlocks(n.lines, !!n.multicolor, 1, 1) }], layers: [] });

// the screen file of a place: its background and its patches
export function placeToFile(place, charset) {
  const bg = place.members.find(m => m.kind === 'background');
  const patches = new Map();
  for (const p of place.members.filter(m => m.kind === 'patch')) patches.set(p.name, linesToMap(p.lines, p.colors, charset, true));
  return encodeScreen({ screen: linesToMap(bg.lines, bg.colors, charset), patches, tiles: bg.tiles ?? null, look: place.canvas ? screenLook(place) : null });
}

// --- the model and the files ------------------------------------------------------------------

// the graphics files a script names, as written in it (relative to the script)
const REF_RE = /^[ \t]*(?:gfx[ \t]+"([^"\n]+)"|costume[ \t]+\w+[ \t]+"([^"\n]+)"|sprite[ \t]+\w+(?:[ \t]+multicolor)?[ \t]+"([^"\n]+)"|dirart[ \t]+"([^"\n]+)")/gm;
export function gfxRefs(text) {
  return [...new Set([...text.matchAll(REF_RE)].map(m => m[1] ?? m[2] ?? m[3] ?? m[4]))];
}

// resolveGfx: the art of the files (files: Map path -> bytes) into the nodes that name them. A
// node read from a file counts as unchanged: its fingerprint is taken again, so an untouched node
// is written back from its source
export function resolveGfx(game, files) {
  const charset = symbols(game).charset;
  const data = (path, line) => {
    const d = files?.get(path);
    if (!d) throw new AdvError(`cannot read '${path}'`, line);
    return d;
  };
  const guard = (line, fn) => {
    try { fn(); } catch (e) { throw e instanceof AdvError ? e : new AdvError(e.message, line); }
  };
  const again = n => { if (n.fp != null) n.fp = fingerprint(n); };
  const visit = items => {
    for (const n of items) {
      if (n.kind === 'place') {
        visit(n.members);
        const bg = n.members.find(m => m.kind === 'background' && m._form === 'file');
        let screen = null;
        if (bg) guard(bg.line, () => { screen = decodeScreen(data(bg.file, bg.line), bg.file); Object.assign(bg, mapToLines(screen.screen, charset)); if (screen.tiles) bg.tiles = screen.tiles; });
        for (const p of n.members.filter(m => m.kind === 'patch' && m._form === 'file')) {
          if (!screen) throw new AdvError(`patch '${p.name}' has no data, and place '${n.name}' has no 'gfx' file`, p.line);
          const m = screen.patches.get(p.name);
          if (!m) throw new AdvError(`patch '${p.name}' is not in '${bg.file}'`, p.line);
          Object.assign(p, mapToLines(m, charset));
          again(p);
        }
        if (bg) { again(bg); again(n); }
      } else if (n.kind === 'costume' && n._form === 'file') {
        guard(n.line, () => costumeFromFile(n, data(n.file, n.line)));
        again(n);
      } else if (n.kind === 'sprite' && n._form === 'file') {
        guard(n.line, () => spriteFromFile(n, data(n.file, n.line)));
        again(n);
      }
    }
  };
  visit(game.items);
  return game;
}

// --- canvases ------------------------------------------------------------------------------
// A canvas is a screen of a size of its own, 1-255 x 1-255 chars, to paint and to save - no place
// of the game. It is a .scr file of the screen folder that no place writes, named by its file
// (game.canvases: place-like nodes { canvas: { cols, rows }, members: [background] }, which the
// screen editor paints like a place). The compiler never sees them.

export const isScreenFile = (path, dir = 'gfx') => path.startsWith(dir + '/screen/') && /\.scr$/i.test(path) && !path.slice(dir.length + 8).includes('/');
export const canvasName = path => path.slice(path.lastIndexOf('/') + 1).replace(/\.scr$/i, '');

// a new canvas: cols x rows of spaces in the text color. dirart: the directory art of a .d64 (the
// script names it: dirart "gfx/screen/NAME.scr") - always in the upper case / graphics charset,
// the one LIST shows file names in, whatever the game's is (canvas.charset)
export function newCanvas(name, cols, rows, charset = 'lower', { dirart = false } = {}) {
  if (dirart) charset = 'upper';
  const space = String.fromCharCode((charset === 'upper' ? PETSCII_UPPER : PETSCII_LOWER) + 32);
  return { id: newId(), kind: 'place', keyword: 'place', name, canvas: { cols, rows, ...(dirart ? { charset, dirart: true } : {}) }, _noActors: true, members: [
    { id: newId(), kind: 'background', lines: Array(rows).fill(space.repeat(cols)), colors: Array(rows).fill('.'.repeat(cols)) }] };
}

// the canvases of the files: the screen files no place of the game writes, and the directory art
// (one that cannot be read is left out - its file stays as it is)
export function canvasesFrom(game, files, dir = 'gfx') {
  const S = symbols(game), placed = new Set(gameFiles(game, dir).files.keys());
  const out = [];
  for (const [path, data] of files) {
    const dirart = isDirartFile(path, dir);
    if (!dirart && (!isScreenFile(path, dir) || placed.has(path))) continue;
    try {
      const decoded = decodeScreen(data, path), { screen, look } = decoded;
      if (!screen.w || !screen.h || screen.w > MAX_CANVAS || screen.h > MAX_CANVAS) continue;
      const c = newCanvas(canvasName(path), screen.w, screen.h, S.charset, { dirart });
      Object.assign(c.members[0], mapToLines(screen, c.canvas.charset ?? S.charset));
      c.members[0].colors ??= Array(screen.h).fill('.'.repeat(screen.w));
      if (decoded.tiles) c.members[0].tiles = decoded.tiles;             // painted with tiles
      c.members.unshift(...lookAttrs(look));                         // its mode and colours (version 3), before its background
      c.members.push(...layersOf(decoded, look, c.canvas.charset ?? S.charset));   // and its layers after it
      out.push(c);
    } catch { /* not a screen the editor reads */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// the file of a canvas: in the screen folder, the directory art in its own
export const canvasPath = (c, dir = 'gfx') => (c.canvas.dirart ? dirartPath(c.name, dir) : scrPath(c.name, dir));

// the directory art the script names (dirart "..."), null without one or when there is no such canvas
export const dirartCanvas = (game, dir = 'gfx') => {
  const path = symbols(game).dirart;
  return path ? (game.canvases ?? []).find(c => c.canvas.dirart && dirartPath(c.name, dir) === path) ?? null : null;
};

// the files of the canvases, Map path -> bytes
export function canvasFiles(game, dir = 'gfx') {
  const charset = symbols(game).charset;
  return new Map((game.canvases ?? []).map(c => [canvasPath(c, dir), placeToFile(c, c.canvas.charset ?? charset)]));
}

// gameFiles: every graphics file of the game, Map path -> bytes; what cannot be written is in errors
export function gameFiles(game, dir = 'gfx') {
  const S = symbols(game);
  const consts = Object.fromEntries(S.consts.map(c => [c.name, c.value]));
  const files = new Map(), errors = [];
  const put = (n, path, fn) => {
    try { files.set(path, fn()); } catch (e) { errors.push({ id: n.id, msg: e.message }); }
  };
  for (const r of S.allPlaces) {
    const bg = r.members.find(m => m.kind === 'background');
    if (bg) put(r, bg.file ?? scrPath(r.name, dir), () => placeToFile(r, S.charset));
  }
  for (const c of S.costumes) put(c, c.file ?? sprPath(c.name, dir), () => costumeToFile(c, consts));
  for (const sp of S.sprites) put(sp, sp.file ?? spritePath(sp.name, dir), () => spriteToFile(sp));
  const art = dirartCanvas(game, dir);                   // the directory art in use: the compiler reads it
  if (art) put(art, dirartPath(art.name, dir), () => placeToFile(art, 'upper'));
  return { files, errors };
}
