// tileset.js - tilesets: tiles of 2 x 2 or 3 x 3 chars a place's screen is painted with
//
// A tileset file (.til) holds tiles of one size, each its chars and their colors, and whether it
// is multicolor: its cells then have the colors 8-15 (a multicolor place shows them multicolor)
// or hires 0-7. A tileset is bound to a charset: a .chr (its path relative to the folder of the
// .til) or the ROM set of the game (''); the places painted with it take that charset.
//
//   .til  "YTIL" 1, the size (2 or 3), flags (1: multicolor), a count byte, then per tile
//         size*size screen codes and size*size colors (0-15), row by row
//         "YTIL" 2 the same with the charset after the flags: a length byte and the path
//         (a tileset of the ROM set stays version 1, byte for byte)
//
// A place painted with tiles names its tileset (screen { tiles "FILE.til" }); the tile map is in
// its .gfx (gfxfile.js, version 2): the tile number of every size x size cell, NO_TILE where its
// chars are its own. The chars of the screen hold the tiles expanded, so the compiler and the
// engine see an ordinary screen; the editor expands them again when a tile changes.
//
// Files are read from the project into a cache keyed by their project path, like the charsets
// (chr.js): the tile editor changes the cached tileset, Save writes the file.

import { withTag, readTag } from './filetag.js';
import { readBinary, writeBinary, hasFile, onProjectOpen } from './project.js';
import { charsetKey, normalize, relativePath, scriptRelative } from './chr.js';
import { petsciiChar, colorDigit } from './petscii.js';
import { symbols, getAttr, placeRows, newId, screensOf } from './adv.js';
import { placeWidth } from './advgen.js';

export const TILE_SIZES = [2, 3];
export const NO_TILE = 0xff;
export const MAX_TILES = 255;
const MAGIC = 'YTIL', VERSION = 1, WITH_CHARSET = 2, MULTICOLOR = 1;

// --- the file ---------------------------------------------------------------------------

// a tile of size x size spaces: in the text color, light grey in multicolor (white | 8)
export const blankTile = (size, multicolor) => ({
  chars: Array(size * size).fill(32), colors: Array(size * size).fill(multicolor ? 9 : 1),
});
export const newTileset = (size, multicolor, charset = '') => ({ size, multicolor: !!multicolor, charset, tiles: [blankTile(size, multicolor)] });

export function encodeTileset(ts) {
  return withTag(tilesetBytes(ts));
}
function tilesetBytes(ts) {
  const n = ts.size * ts.size;
  const out = [...MAGIC].map(c => c.charCodeAt(0));
  const chr = [...(ts.charset ?? '')].map(c => c.charCodeAt(0) & 0xff);
  out.push(chr.length ? WITH_CHARSET : VERSION, ts.size, ts.multicolor ? MULTICOLOR : 0);
  if (chr.length) out.push(chr.length, ...chr);
  out.push(ts.tiles.length);
  for (const t of ts.tiles) {
    for (let k = 0; k < n; k++) out.push(t.chars[k] & 0xff);
    for (let k = 0; k < n; k++) out.push(t.colors[k] & 0x7f);          // the TED's colours too
  }
  return Uint8Array.from(out);
}

export function decodeTileset(data, what = 'tileset') {
  data = readTag(data).data;              // the tag of the editor that wrote it (filetag.js)
  let p = 0;
  const byte = () => {
    if (p >= data.length) throw new Error(`${what}: the file ends too early`);
    return data[p++];
  };
  if (String.fromCharCode(...data.slice(0, 4)) !== MAGIC) throw new Error(`${what}: not a ${MAGIC} file`);
  p = 4;
  const v = byte();
  if (v !== VERSION && v !== WITH_CHARSET) throw new Error(`${what}: version ${v}, the editor reads ${VERSION} to ${WITH_CHARSET}`);
  const size = byte(), flags = byte();
  const charset = v === WITH_CHARSET ? String.fromCharCode(...Array.from({ length: byte() }, byte)) : '';
  const count = byte();
  if (!TILE_SIZES.includes(size)) throw new Error(`${what}: tiles of ${size} x ${size} chars, not 2 x 2 or 3 x 3`);
  const n = size * size, tiles = [];
  for (let t = 0; t < count; t++) {
    const chars = Array.from({ length: n }, byte);
    tiles.push({ chars, colors: Array.from({ length: n }, () => byte() & 0x7f) });
  }
  return { size, multicolor: !!(flags & MULTICOLOR), charset, tiles };
}

// a first tileset: a wall, a floor and an empty tile (STARTER), like the chars of a new place
// (advgen.js: newPlace) - in multicolor their colors are 8-15
export const STARTER = { wall: 0, floor: 1, empty: 2 };
export function starterTileset(size, multicolor, charset = '') {
  const n = size * size, c = v => (multicolor ? v | 8 : v);
  const tile = (code, color) => ({ chars: Array(n).fill(code), colors: Array(n).fill(c(color)) });
  return { size, multicolor: !!multicolor, charset, tiles: [tile(160, 11), tile(102, 9), tile(32, 1)] };
}

// the map of a new place painted with the starter tiles: walls around, a floor below
export function starterTilemap(size, width, rows) {
  const m = newTilemap(size, width, rows), floor = Math.ceil(m.h * 2 / 3);
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      m.cells[y * m.w + x] = y >= floor ? STARTER.floor : y === 0 || x === 0 || x === m.w - 1 ? STARTER.wall : STARTER.empty;
    }
  }
  return m;
}

// --- the tile map of a place --------------------------------------------------------------

// how many tiles of size cover a screen of width x rows chars: the last ones may reach beyond it
export const tilemapSize = (size, width, rows) => ({ w: Math.ceil(width / size), h: Math.ceil(rows / size) });
export function newTilemap(size, width, rows) {
  const { w, h } = tilemapSize(size, width, rows);
  return { size, w, h, cells: Array(w * h).fill(NO_TILE) };
}

// the map for a screen of width x rows: what it had stays where it was
export function fitTilemap(map, width, rows) {
  const { w, h } = tilemapSize(map.size, width, rows);
  if (w === map.w && h === map.h) return map;
  const cells = Array(w * h).fill(NO_TILE);
  for (let y = 0; y < Math.min(h, map.h); y++) for (let x = 0; x < Math.min(w, map.w); x++) cells[y * w + x] = map.cells[y * map.w + x];
  return { ...map, w, h, cells };
}

// the chars and colors of tile t at the top left (x, y) of the screen (cells {c, r, code, color}),
// inside width x rows
export function tileCells(ts, t, x, y, width, rows) {
  const tile = ts.tiles[t], n = ts.size, out = [];
  if (!tile) return out;
  for (let dy = 0; dy < n; dy++) {
    for (let dx = 0; dx < n; dx++) {
      if (x + dx < width && y + dy < rows) out.push({ c: x + dx, r: y + dy, code: tile.chars[dy * n + dx], color: tile.colors[dy * n + dx] });
    }
  }
  return out;
}

// the tiles of the map into the lines and colors of background node bg (a screen of width x rows):
// a cell of the map without a tile, or with a number the tileset does not have, keeps its chars.
// True when a char or a color changed
export function expandTiles(bg, map, ts, width, rows, charset) {
  if (!map || !ts || ts.size !== map.size) return false;
  const lines = bg.lines.map(l => [...l]), colors = (bg.colors ?? bg.lines.map(l => '.'.repeat([...l].length))).map(l => [...l]);
  const space = petsciiChar(32, charset);
  let changed = false;
  for (let ty = 0; ty < map.h; ty++) {
    for (let tx = 0; tx < map.w; tx++) {
      const t = map.cells[ty * map.w + tx];
      if (t === NO_TILE || !ts.tiles[t]) continue;
      for (const { c, r, code, color } of tileCells(ts, t, tx * ts.size, ty * ts.size, width, rows)) {
        while (lines.length <= r) lines.push([]);
        while (colors.length <= r) colors.push([]);
        while (lines[r].length <= c) lines[r].push(space);
        while (colors[r].length <= c) colors[r].push('.');
        const ch = petsciiChar(code, charset), d = colorDigit(color);
        if (lines[r][c] !== ch || colors[r][c] !== d) { lines[r][c] = ch; colors[r][c] = d; changed = true; }
      }
    }
  }
  if (changed) {
    bg.lines = lines.map(l => l.join(''));
    bg.colors = colors.map(l => l.join(''));
  }
  return changed;
}

// the screens painted with tiles: [screen, background node, tileset file]
export function tilePlaces(game) {
  const out = [];
  for (const r of screensOf(game)) {
    const file = getAttr(r, 'tiles'), bg = r.members.find(m => m.kind === 'background');
    if (file && bg?.tiles) out.push([r, bg, file]);
  }
  return out;
}

// place r takes the charset chrKey (a project path, null the ROM set) - the one of its tileset -
// as its 'charset' attribute. True when it changed
export function bindCharset(r, chrKey) {
  const i = r.members.findIndex(m => m.kind === 'attr' && m.key === 'charset');
  if (!chrKey) {
    if (i < 0) return false;
    r.members.splice(i, 1);
    return true;
  }
  if (i >= 0) {
    if (charsetKey(r.members[i].str ?? '') === chrKey) return false;
    r.members[i].str = scriptRelative(chrKey);
    return true;
  }
  const at = r.members.reduce((a, m, k) => (m.kind === 'attr' ? k + 1 : a), 0);
  r.members.splice(at, 0, { id: newId(), kind: 'attr', key: 'charset', str: scriptRelative(chrKey) });
  return true;
}

// the tiles expanded again into every place painted with them (of the tileset key only, else of
// all), and the places take the charset of their tileset: it may have changed. True when a
// screen changed
export function syncTiles(game, key = null) {
  const S = symbols(game), consts = Object.fromEntries(S.consts.map(c => [c.name, c.value]));
  let changed = false;
  for (const [r, bg, file] of tilePlaces(game)) {
    if (key && tilesetKey(file) !== key) continue;
    const ts = tilesetData(file);
    if (!ts) continue;
    if (bindCharset(r, tilesetCharset(tilesetKey(file), ts))) changed = true;
    if (expandTiles(bg, bg.tiles, ts, placeWidth(r, consts), placeRows(r, game), S.charset)) changed = true;
  }
  return changed;
}

// --- the cache of the project's tilesets ---------------------------------------------------------

const cache = new Map();          // project path -> tileset
const state = new Map();          // project path -> 'ok' | 'missing' | 'error'
const errors = new Map();         // project path -> why it cannot be read
const dirty = new Set();
const listeners = new Set();
let timer = 0;

export function onTilesetChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
// many changes while drawing, one notification
function notify() {
  clearTimeout(timer);
  timer = setTimeout(() => listeners.forEach(fn => fn()), 60);
}

function load(key) {
  try {
    if (!hasFile(key)) state.set(key, 'missing');
    else { cache.set(key, decodeTileset(readBinary(key), key)); state.set(key, 'ok'); }
  } catch (e) {
    state.set(key, 'error');
    errors.set(key, e.message);
  }
}

onProjectOpen(() => {
  cache.clear();
  state.clear();
  errors.clear();
  dirty.clear();
  notify();
});

// the tileset of a project path, null when the file is missing or broken
export function tilesetByKey(key) {
  if (!key) return null;
  if (!state.has(key)) load(key);
  return cache.get(key) ?? null;
}
// the tileset a place names (a path relative to the script, like a charset)
export const tilesetKey = file => charsetKey(file);
export const tilesetData = file => (file ? tilesetByKey(tilesetKey(file)) : null);
// the charset of the tileset of project path key: the project path of its .chr, null the ROM set
const folderOf = key => key.slice(0, key.lastIndexOf('/') + 1);
export const tilesetCharset = (key, ts = tilesetByKey(key)) => (ts?.charset ? normalize(folderOf(key) + ts.charset) : null);
// a charset (project path, null the ROM set) as the tileset of key names it
export const charsetOfTileset = (key, chrKey) => (chrKey ? relativePath(folderOf(key), chrKey) : '');
export const tilesetState = key => state.get(key) ?? 'missing';
export const tilesetError = key => errors.get(key) ?? null;

export function setTileset(key, ts) {
  cache.set(key, ts);
  state.set(key, 'ok');
  dirty.add(key);
  notify();
}
export const isTilesetDirty = key => dirty.has(key);
export const dirtyTilesets = () => [...dirty];

export function saveTileset(key) {
  writeBinary(key, encodeTileset(cache.get(key)));
  dirty.delete(key);
  notify();
}

// forget unsaved changes and read the file again
export function reloadTileset(key) {
  cache.delete(key);
  state.delete(key);
  dirty.delete(key);
  load(key);
  notify();
}

// the tilesets read or made in this session, saved or not (a new one is no project file yet)
export const knownTilesets = () => [...cache.keys()];
