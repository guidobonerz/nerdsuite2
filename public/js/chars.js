// chars.js - character editor for custom place charsets (2048 byte files)
//
// The file is edited in the charset cache (chr.js): the screen editor and the place
// previews show every change at once, Save writes the file. Multicolor is how a
// multicolor place shows a character whose cell color has bit 3: the bit pairs are
// 00 background, 01 $d022, 10 $d023, 11 the cell color 0-7 - on the VIC-20 01 the border, 10 the
// cell color, 11 the auxiliary color (video.js mcPens). A place in extended color mode
// shows only the hires characters 0-63, each on one of four backgrounds ($d021-$d024): the
// editor then offers those 64, and the background of the preview is one of the four.

import { LAYOUT } from './layout.js';
import { parseCtm, CTM_MODES } from './padfiles.js';
import { listBinaries, removeFile } from './project.js';
import { pngOf, pixelCanvas, exportName, importName, withoutLoadAddress } from './export.js';
import { symbols, getAttr, newId, COLOR_NAMES, DEFAULT_ANIM_SPEED, screensOf } from './adv.js';
import { sizePicker } from './sizes.js';
import { colorChooser } from './colorchooser.js';
import { regionOp, rectBetween, clipRect, isRotation, swapValues } from './gridops.js';
import { shadePixels } from './aa.js';
import { tools, RANGE, rotation, rangeForKey, DRAG_TOOLS, BRUSH_TOOLS, defaultBrush, brushCells, brushMax, brushTools, radiusMax, radiusTools, defaultTools, toolForKey, lineCells, dragCells as dragXY } from './drawtools.js';
import { paintArea, dragMods, dragTo, curveWaits, followCurve, DRAW_POLY, WAIT_TOOLS, waits, strokeDown, closePolygon, wheelZoom, outlineCells } from './drawtools.js';
import { PALETTE, colorIndex, drawGlyph, romCharset as romCharsetOf, romFont, placeInfo } from './c64.js';
import {
  CHARSET_SIZE, charsetKey, scriptDirectory, scriptRelative, charsetByKey, charsetState, charsetFileSize,
  setCharsetBytes, isCharsetDirty, glyphPixels, setGlyphPixels, dropCharset,
} from './chr.js';
import {
  h, dh, dom, mount, signal, icon, iconButton, button, select, checkbox, promptDialog, snackbar, slider, segmented,
  section as uiSection, sidePanel, storeVersion, confirmRemove,
} from './pui.js';
import { tr } from './i18n.js';
import { video, colorMask, mcPens, mcPair, mcCell, mcCellColor, mcNames, startColors, hasMulticolor, ATARI_REGS, antic2Text } from './video.js';
import { atariFont, FONT_SIZE } from './atarifont.js';
import { fontReady } from './romfonts.js';
import { keepUi, pick as pickUi, put as putUi } from './uistate.js';

// the tools of the charset (drawtools.js): select and draw
const TOOLS = tools(['select', ...DRAW_POLY], { erase: '§0643', pick: 'pen' });
const ZOOM = [24, 32, 40, 48, 56];
const hex2 = n => '$' + n.toString(16).padStart(2, '0');
const ROM_OVERLAY = '#ff4081';          // the ROM characters over the matrix: no C64 color
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function createCharEditor(el, store, actions, bar) {
  const st = {
    key: null, placeId: null, code: 1, tool: 'pencil', pen: 1, mode: null, colors: null, cell: 40, grid: true, brush: defaultBrush(), radius: 0,
    tile: { w: 1, h: 1 },           // drawing on W x H chars: code, code + 1 ... row by row
    inverse: false,                 // a tile of 1 x 2: its lower char in the inverse half (code + 128)
    hover: null, drag: null, clip: null, files: [],
    range: null,                    // chars marked in the grid panel: {anchor, codes}
    sel: null,                      // the range selected on the canvas: {x, y, w, h} in pixels of the tile
    swapAll: false,                 // swap colors in all 256 characters
    ecmBg: 0,                       // extended color mode: the background of the preview, 0-3 ($d021-$d024)
    // the ROM characters of the same codes, see-through over the matrix (or under its pixels):
    // what is traced is never a part of the charset. set: 'upper' or 'lower', null: the game's case
    rom: { shown: false, opacity: 0.4, front: true, set: null },
  };
  const undo = new Map(), redo = new Map();
  let ui = null;                          // what the editor draws on, made once: the canvas, its wrap, the place canvas, the grid of characters
  let views = null;                       // the mounted bar and body (pui.mount)
  const update = () => views?.forEach(v => v.update());
  // the turn of the range tool 'rotate' (drawtools.js): while it is on, the canvas shows the tile
  // turned - the range, or the whole tile - and Apply turns what apply() changes
  const rot = rotation({ preview: () => draw(), apply: t => apply('rotate', { turned: true, ...t }), refresh: () => render() });
  const statusLine = signal('');
  let hadData = false;
  let listed = false;
  let cdrag = null;                       // characters marked with the mouse: { anchor, to }

  // --- model -------------------------------------------------------------------------

  // the symbols and the place colors walk the whole script: once per change of the store, not for
  // every character and pixel a stroke draws again (placeColors is asked for each of them)
  const version = storeVersion(store);
  let symbolsAt = -1, symbolsNow = null;
  const S = () => {
    if (symbolsAt !== version.peek() || !symbolsNow) { symbolsNow = symbols(store.game); symbolsAt = version.peek(); }
    return symbolsNow;
  };
  let constsAt = -1, constsNow = null;
  const consts = () => {                         // constMap (c64.js), from the symbols above
    if (constsAt !== version.peek() || !constsNow) { constsNow = Object.fromEntries(S().consts.map(x => [x.name, x.value])); constsAt = version.peek(); }
    return constsNow;
  };
  const data = () => charsetByKey(st.key);
  const placesUsing = key => screensOf(store.game).filter(r => {
    const f = getAttr(r, 'charset');
    return f && charsetKey(f) === key;
  });

  function knownKeys() {
    const keys = new Set(st.files);
    for (const r of screensOf(store.game)) {
      const f = getAttr(r, 'charset');
      if (f) keys.add(charsetKey(f));
    }
    if (st.key) keys.add(st.key);
    return [...keys].sort();
  }

  // preview colors of the place that uses the charset
  let colorsKey = null, colorsNow = null;
  function placeColors() {
    const key = `${version.peek()}|${st.key}|${st.placeId}`;
    if (key !== colorsKey) { colorsNow = placeColorsNow(); colorsKey = key; }
    return colorsNow;
  }
  function placeColorsNow() {
    const r = placesUsing(st.key).find(x => x.id === st.placeId) ?? placesUsing(st.key)[0];
    const c = consts();
    const mc = r && getAttr(r, 'multicolor'), ecm = r && getAttr(r, 'ecm');
    return {
      bg: r ? colorIndex(getAttr(r, 'bgcolor')?.[0] ?? '0', c) : startColors().bg,
      fg: r ? colorIndex(getAttr(r, 'textcolor')?.[0] ?? '1', c, 1) : video().cells === 'vic2' ? 1 : startColors().text,
      mc1: mc ? colorIndex(mc[0], c, 8) : 8,
      mc2: mc ? colorIndex(mc[1], c, 9) : 9,
      multicolor: !!mc && !ecm,
      ecm: ecm && video().ecm ? ecm.map((v, k) => colorIndex(v, c, 2 + k)) : null,
      place: r ?? null,
    };
  }
  // bg: the background the preview draws on - in extended color mode the one of the four picked
  // (st.ecmBg); bg1: $d021
  const colors = () => {
    const c = { ...placeColors(), ...atariColors(), ...st.colors };
    return { ...c, bg1: c.bg, bg: c.ecm ? [c.bg, ...c.ecm][st.ecmBg] : c.bg };
  };
  // the Atari: the colour registers of the screen that uses the charset (c64.js placeInfo), else those the OS
  // starts with - ANTIC 2 the luminance of COLOR1 on COLOR2, ANTIC 4 COLOR4, COLOR0, COLOR1, COLOR2
  const atariColors = () => {
    if (video().cells !== 'atari') return {};
    const r = placeColors().place, regs = r ? placeInfo(store.game, r).atari.regs : ATARI_REGS;
    return multicolor() ? { bg: regs[4], mc1: regs[0], mc2: regs[1], fg: regs[2] } : { bg: regs[2], fg: antic2Text(regs) };
  };
  // extended color mode: the place of the charset uses it - hires, the chars 0-63
  const ecmMode = () => !!placeColors().ecm;
  const codeMask = () => (ecmMode() ? 63 : video().cells === 'atari' ? 127 : 255);   // an Atari font: 128 chars
  const multicolor = () => hasMulticolor() && !ecmMode() && (st.mode ?? placeColors().multicolor);
  // the pens as bit pairs of the machine (video.js mcPair): the cell colour, mc1, mc2, the background
  const pens = () => (multicolor() ? [mcPair('color'), 1, mcPair('mc2'), 0] : [1, 0]);
  const penLabel = v => (multicolor() ? { 0: 'background', 1: '§0644', [mcPair('mc2')]: '§0645', [mcPair('color')]: '§0646' } : ['background', '§0646'])[v];
  const pixelColor = v => {
    const c = colors();
    return multicolor() ? mcPens(c.bg, [c.mc1, c.mc2], c.fg)[v] : v ? c.fg : c.bg;
  };
  const glyphFg = () => (multicolor() ? mcCell(colors().fg) : colors().fg);
  const glyphMc = () => (multicolor() ? [colors().mc1, colors().mc2] : null);
  // a tile of 1 x 2 with its lower char in the other half of the charset, the inverse one: the
  // char and char + 128 (from the upper half, char - 128) - not in extended color mode (64 chars)
  const inverseTile = () => st.inverse && st.tile.w === 1 && st.tile.h === 2 && !ecmMode();
  const pairOf = code => [code, code ^ 128];
  // the chars of the tile, row by row, from the selected one
  const tileChars = () => (inverseTile() ? pairOf(st.code)
    : Array.from({ length: st.tile.w * st.tile.h }, (_, k) => (st.code + k) & codeMask()));
  // the chars of the tile as a text: '65-66', or '65 and 193' (the inverse half)
  const tileText = () => (inverseTile() ? tr('§1602', ...tileChars()) : `${st.code}-${(st.code + st.tile.w * st.tile.h - 1) & codeMask()}`);
  const charW = () => (multicolor() ? 4 : 8);

  // the pixels of the whole tile: 8 H rows, W chars of 8 (hires) or 4 (multicolor) pixels.
  // codes: the chars of the tile, row by row (a missing one stays blank); d: the bytes
  function pixels(codes = tileChars(), d = data()) {
    const { w, h: th } = st.tile, cw = charW(), mc = multicolor();
    const grid = Array.from({ length: 8 * th }, () => Array(cw * w).fill(0));
    codes.forEach((code, k) => {
      const col = k % w, row = Math.floor(k / w);
      glyphPixels(d, code, mc).forEach((line, y) => line.forEach((v, x) => { grid[row * 8 + y][col * cw + x] = v; }));
    });
    return grid;
  }

  // the tile's pixels back into its chars of bytes d
  function storeTile(d, grid, codes = tileChars()) {
    const { w } = st.tile, cw = charW();
    codes.forEach((code, k) => {
      const col = k % w, row = Math.floor(k / w);
      setGlyphPixels(d, code, grid.slice(row * 8, row * 8 + 8).map(line => line.slice(col * cw, col * cw + cw)), multicolor());
    });
  }

  function setTile(w, th) {
    if (!Number.isInteger(w) || !Number.isInteger(th) || w < 1 || th < 1 || w > 16 || th > 16) {
      return snackbar('§0647', { error: true });
    }
    st.tile = { w, h: th };
    render();
  }

  // the ROM charset of the game's case (chargen.js)
  // the Atari: the font in the order of its codes (atarifont.js), in the 2048 bytes of the editor
  const atariRom = () => { const out = new Uint8Array(CHARSET_SIZE); out.set(atariFont()); return out; };
  const romCharset = () => (video().cells === 'atari' ? atariRom() : romCharsetOf(S().charset));
  const overlaySet = () => st.rom.set ?? S().charset;

  // --- changes -----------------------------------------------------------------------

  function snapshot() {
    const d = data();
    if (!d) return;
    const list = undo.get(st.key) ?? [];
    list.push(d.slice());
    if (list.length > 200) list.shift();
    undo.set(st.key, list);
    redo.set(st.key, []);
  }

  function travel(from, to) {
    const d = data(), list = from.get(st.key);
    if (!d || !list?.length) return;
    if (!to.has(st.key)) to.set(st.key, []);
    to.get(st.key).push(d.slice());
    setCharsetBytes(st.key, list.pop());
    refresh();
  }

  function writeBytes(bytes) {
    setCharsetBytes(st.key, bytes);
    refresh();
  }

  function paintCells(cells, value) {
    const grid = pixels();
    let changed = false;
    for (const { x, y } of cells) {
      if (grid[y]?.[x] !== undefined && grid[y][x] !== value) { grid[y][x] = value; changed = true; }
    }
    if (!changed) return;
    const d = data().slice();
    storeTile(d, grid);
    setCharsetBytes(st.key, d);
    later(tileChars());
  }

  // the smooth tool: antialiasing under its brush (aa.js shadePixels) - a background pixel in a
  // corner of an edge takes the pen nearest to the mix of the drawn color and the background
  // (hires: the one pen, so mostly nothing). d.shaded: the shades of this stroke; the undo step is
  // taken with the first of them, a stroke that shades nothing leaves no empty step behind
  function smoothPixels(cells, d) {
    const grid = pixels(), [w, h] = [grid[0].length, grid.length];
    const shades = shadePixels(grid, cells, { w, h, pens: pens().filter(Boolean), colorOf: v => pixelColor(v) & colorMask(), bg: colors().bg & colorMask(), skip: d.shaded });
    if (!shades.length) return;
    if (!d.snapped) { snapshot(); d.snapped = true; }
    for (const { x, y, v } of shades) { grid[y][x] = v; d.shaded.add(y * w + x); }
    const bytes = data().slice();
    storeTile(bytes, grid);
    setCharsetBytes(st.key, bytes);
    later(tileChars());
  }

  // the bar tools: the range selected on the canvas, else the whole tile. With characters
  // marked in the grid below, they change tile by tile: every W x H of them in a row form one
  // tile (the range clipped to one tile).
  // all: every character of the charset. One undo step. more: more options of regionOp (map)
  function apply(op, { all = false, confirmed = false, ...more } = {}) {
    if (!data()) return;
    if (op === 'rotate' && !more.turned) return rot.start();   // turned in space: the section of the turn
    if (op !== 'rotate') rot.stop(false);
    if (op === 'clear' && !confirmed) {             // asks first: the range, the marked chars or the char
      const marked = markedCodes(), n = st.tile.w * st.tile.h;
      const what = st.sel ? tr('§1460', st.sel.w, st.sel.h) : marked ? tr('§1458', marked.length)
        : inverseTile() ? tr('§1603', ...tileChars()) : n > 1 ? tr('§1461', st.code, (st.code + n - 1) & codeMask()) : tr('§1459', st.code, '$' + st.code.toString(16).padStart(2, '0'));
      confirmRemove({ what, kind: 'clear:chars', verb: 'clear' }).then(ok => ok && apply(op, { all, confirmed: true, ...more }));
      return;
    }
    const mc = multicolor();
    if (isRotation(op) && mc) return snackbar('§0648', { error: true });
    const opts = { blank: 0, invert: v => (mc ? 3 - v : 1 - v), resize: !!st.sel, aspect: mc ? 2 : 1, ...more };
    const d = data().slice(), marked = all ? Array.from({ length: 256 }, (_, i) => i) : markedCodes();
    let sel = st.sel;
    if (marked) {
      const n = st.tile.w * st.tile.h;
      const one = st.sel && clipRect(st.sel, charW() * st.tile.w, 8 * st.tile.h);
      if (st.sel && !one) return snackbar('§0952', { error: true });
      if (!inverseTile() && marked.length % n) return snackbar(tr('§0953', n), { error: true });
      // every n of them a tile - with the inverse half each one, with its char + 128 below it
      const tiles = inverseTile() ? marked.map(pairOf) : Array.from({ length: marked.length / n }, (_, k) => marked.slice(k * n, k * n + n));
      for (const codes of tiles) {
        const r = regionOp(pixels(codes, d), op, one, opts);
        if (!r) return snackbar('§0649', { error: true });
        storeTile(d, r.grid, codes);
      }
    } else {
      const r = regionOp(pixels(), op, st.sel, opts);
      if (!r) return snackbar('§0649', { error: true });
      storeTile(d, r.grid);
      sel = st.sel && r.rect;
    }
    snapshot();
    st.sel = sel;
    writeBytes(d);
  }

  // swap colors, in the side panel: the pairs of multicolor pens (hires has two values: that is
  // invert). The pixels of the one pen take the other: the picture keeps its shape, the colors
  // move - in this character (the range, the marked characters) or, with the checkbox, in all 256
  function swapSection() {
    const pens = [[3, '§0637'], [1, '§0650'], [2, '§0651']];
    const swatch = v => h('span', { class: 'swap-swatch', style: { background: PALETTE[pixelColor(v) & colorMask()] } });
    const pairs = [];
    for (let i = 0; i < pens.length; i++) {
      for (let j = i + 1; j < pens.length; j++) {
        const [a, la] = pens[i], [b, lb] = pens[j];
        pairs.push(h('button', { class: 'md-chip md-chip--sm swap-pair', type: 'button', 'data-tip': tr('§0652', la, lb),
          onclick: () => apply('map', { map: swapValues(a, b), all: st.swapAll }) }, swatch(a), icon('swap_horiz'), swatch(b)));
      }
    }
    return h('div', { class: 'swap-colors' },
      h('div', { class: 'section__hint', style: { margin: '14px 0 8px' } }, st.swapAll ? '§0653' : '§0654'),
      h('div', { class: 'inline-actions' }, pairs),
      checkbox('§0655', st.swapAll, v => { st.swapAll = v; update(); }));
  }

  // the selected tile: its W x H characters from the selected one, row by row
  // Ctrl+C: the tile (its chars), or the range selected on the canvas (its pixels) - for any
  // charset
  function copyChar() {
    if (!data()) return;
    const r = st.sel;
    if (r) {
      const grid = pixels();
      st.clip = { x: r.x, y: r.y, grid: grid.slice(r.y, r.y + r.h).map(row => row.slice(r.x, r.x + r.w)), mc: multicolor() };
      snackbar(tr('§1604', r.w, r.h));
      return update();
    }
    const codes = tileChars(), d = data();
    st.clip = { w: st.tile.w, h: st.tile.h, bytes: codes.map(code => d.slice(code * 8, code * 8 + 8)) };
    snackbar(codes.length > 1 ? tr('§0656', st.tile.w, st.tile.h, codes[0], codes.at(-1)) : tr('§0657', st.code));
    update();
  }

  // Ctrl+V: the copied tile from the selected character on (the tile takes its size); a copied
  // range into the tile at the range selected now, else where it was copied from - what does not
  // fit is cut off
  function pasteChar() {
    if (!data() || !st.clip) return;
    const cl = st.clip;
    if (cl.grid) {
      if (cl.mc !== multicolor()) return snackbar(cl.mc ? '§1606' : '§1607', { error: true });
      snapshot();
      const d = data().slice(), grid = pixels(), x0 = st.sel?.x ?? cl.x, y0 = st.sel?.y ?? cl.y;
      cl.grid.forEach((row, y) => row.forEach((v, x) => { if (grid[y0 + y]?.[x0 + x] !== undefined) grid[y0 + y][x0 + x] = v; }));
      storeTile(d, grid);
      writeBytes(d);
      return snackbar(tr('§1605', cl.grid[0].length, cl.grid.length, st.code));
    }
    snapshot();
    const d = data().slice();
    const codes = tileChars();
    st.clip.bytes.forEach((b, k) => d.set(b, codes[k] * 8));
    const resized = st.tile.w !== st.clip.w || st.tile.h !== st.clip.h;
    if (resized) st.tile = { w: st.clip.w, h: st.clip.h };
    writeBytes(d);
    if (resized) render();
    if (st.clip.bytes.length > 1) snackbar(tr('§0658', st.clip.w, st.clip.h, st.code));
  }

  async function refreshFiles() {
    st.files = listBinaries().filter(f => /\.(chr|fnt|bin|raw)$/i.test(f));   // not the pictures
    listed = true;
  }

  async function createFromRom() {
    setCharsetBytes(st.key, romCharset().slice());
    render();
  }

  // imported: { bytes, name, text } - the charset of a file of this computer (importCharset)
  async function newCharset(imported = null) {
    await fontReady();                      // a copy of the machine's ROM font, not the C64's while it is on the way (romfonts.js)
    const place = st.placeId ? store.node(st.placeId) : null;
    const assign = place && !getAttr(place, 'charset');
    const known = knownKeys();
    const base = imported ? importName(imported.name, 'chars') : place?.name ?? 'chars';
    const ext = video().cells === 'atari' ? 'fnt' : 'chr';                       // an Atari font: 1024 bytes
    let path = `${scriptDirectory()}${LAYOUT.charset}/${base}.${ext}`;              // gfx/charset/ (layout.js)
    for (let k = 2; known.includes(path); k++) path = `${scriptDirectory()}${LAYOUT.charset}/${base}${k}.${ext}`;
    const v = await promptDialog({
      title: imported ? '§1006' : '§0659', icon: 'grid_view', ok: '§0124',
      text: `${imported ? imported.text : `It starts as a copy of the ${S().charset} case ROM charset.`}${assign ? ` Place ${place.name} will use it.` : ''}`,
      fields: [{ name: 'path', label: '§1263', value: path, mono: true,
        validate: p => (!/^[\w\-./]+\.(chr|fnt|bin|raw)$/i.test(p) || p.includes('..') ? '§0660'
          : known.includes(p) ? '§0208' : null) }],
    });
    if (!v) return;
    st.key = v.path;
    st.code = 1;
    st.mode = null; st.colors = null;
    setCharsetBytes(v.path, imported ? imported.bytes : romCharset().slice());
    if (assign) {
      store.mutate(() => {
        let at = 0;
        place.members.forEach((m, k) => { if (m.kind === 'attr') at = k + 1; });
        place.members.splice(at, 0, { id: newId(), kind: 'attr', key: 'charset', str: scriptRelative(v.path) });
      }, { source: 'structure' });
    }
    render();
  }

  // the trash icon of the bar: the charset leaves the project (its file, its unsaved changes, its
  // undo steps); a place that used it has no charset then - the ROM set. Asked first; not undoable
  async function deleteCharset() {
    const key = st.key;
    if (!key) return;
    const users = placesUsing(key);
    const ok = await confirmRemove({ what: tr('§1610', scriptRelative(key)), undo: false,
      detail: users.length ? tr('§1609', users.map(p => p.name).join(', ')) : null });
    if (!ok) return;
    if (users.length) {
      store.mutate(() => {
        for (const p of users) {
          const i = p.members.findIndex(m => m.kind === 'attr' && m.key === 'charset');
          if (i >= 0) p.members.splice(i, 1);
        }
      }, { source: 'structure' });
    }
    removeFile(key);
    dropCharset(key);
    undo.delete(key);
    redo.delete(key);
    st.key = null; st.mode = null; st.colors = null;
    await refreshFiles();
    st.key = knownKeys()[0] ?? null;
    st.code = 1;
    render();
  }

  // the Import button of the app bar (app.js, export.js): a charset of this computer becomes a new
  // charset file (Save writes it). 256 characters of 8 bytes, a load address before them is
  // dropped; fewer characters are the first ones, the ROM fills the rest; more: the first 256
  async function importCharset(bytes, name) {
    const d = withoutLoadAddress(bytes, 8);
    if (!d.length || d.length % 8) throw new Error(tr('§1960', bytes.length));
    const out = romCharset().slice();
    out.set(d.subarray(0, CHARSET_SIZE));
    const n = d.length / 8;
    const text = tr('§1961', name, Math.min(n, 256)) + (bytes.length !== d.length ? tr('§1962') : '')
      + (n < 256 ? tr('§1963', 256 - n) : n > 256 ? tr('§1964', n) : '.');
    await newCharset({ bytes: out, name, text });
  }
  // the chars of a CharPad project (.ctm, padfiles.js): the ROM fills the codes it has none for
  async function importCtmCharset(bytes, name) {
    const p = parseCtm(bytes, name);
    if (p.count > 256) throw new Error(tr('§1965', name, p.count));
    const out = romCharset().slice();
    out.set(p.chars.subarray(0, CHARSET_SIZE));
    await newCharset({ bytes: out, name, text: tr('§1696', name, p.count, CTM_MODES[p.mode]) });
  }
  const importFormats = () => (!store.game ? [] : [
    { label: '§1005', icon: 'grid_view', accept: '.chr,.bin,.raw,.64c', open: importCharset },
    { label: '§1691', icon: 'grid_view', accept: '.ctm', open: importCtmCharset },
  ]);

  // --- tools -------------------------------------------------------------------------

  // the cells the line, box, circle or curve tool draws for drag d
  const dragTool = () => DRAG_TOOLS.has(st.tool);
  // the grid the brush paints in (drawtools.js): the pixels of the tile, double wide in multicolor
  const brushGrid = () => ({ aspect: multicolor() ? 2 : 1, w: 8 * st.tile.w >> (multicolor() ? 1 : 0), h: 8 * st.tile.h });
  // the cells the brush paints along cells, with the tools that draw with it
  const brushed = cells => (BRUSH_TOOLS.has(st.tool) ? brushCells(cells, st.brush, brushGrid()) : cells);
  // inside the characters: the curve may reach beyond them
  const dragCells = d => {
    const cols = 8 * st.tile.w >> (multicolor() ? 1 : 0), rows = 8 * st.tile.h;
    return brushed(dragXY(st.tool, d.start, d.end, { ...d, aspect: multicolor() ? 2 : 1, radius: st.radius })).filter(p => p.x >= 0 && p.y >= 0 && p.x < cols && p.y < rows);
  };

  function floodCells(grid, start, value) {
    const from = grid[start.y][start.x];
    if (from === value) return [];
    const seen = new Set(), cells = [], stack = [start];
    while (stack.length) {
      const { x, y } = stack.pop();
      if (grid[y]?.[x] !== from || seen.has(y * 256 + x)) continue;
      seen.add(y * 256 + x);
      cells.push({ x, y });
      stack.push({ x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 });
    }
    return cells;
  }

  // --- drawing -----------------------------------------------------------------------

  function draw() {
    if (!ui?.canvas) return;
    const mc = multicolor(), k = mc ? 2 : 1, s = st.cell;
    const cv = ui.canvas;
    cv.classList.toggle('paint-canvas--brush', BRUSH_TOOLS.has(st.tool));       // the brush outline is the cursor
    const cols = 8 * st.tile.w, rows = 8 * st.tile.h;
    if (cv.width !== cols * s || cv.height !== rows * s) { cv.width = cols * s; cv.height = rows * s; }
    const ctx = cv.getContext('2d');
    ctx.fillStyle = PALETTE[colors().bg];
    ctx.fillRect(0, 0, cv.width, cv.height);
    if (!data()) return;
    const grid = rot.on ? regionOp(pixels(), 'rotate', st.sel, { blank: 0, aspect: multicolor() ? 2 : 1, ...rot.turn }).grid : pixels();
    const d = st.drag;
    if (d && dragTool()) for (const c of dragCells(d)) if (grid[c.y]?.[c.x] !== undefined) grid[c.y][c.x] = d.value;
    if (!st.rom.front) drawRomOverlay(ctx, s);
    grid.forEach((row, y) => row.forEach((v, x) => {
      if (!v) return;
      ctx.fillStyle = PALETTE[pixelColor(v) & colorMask()];
      ctx.fillRect(x * k * s, y * s, k * s, s);
    }));
    if (st.rom.front) drawRomOverlay(ctx, s);
    if (st.grid) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(128, 128, 128, .45)';
      ctx.beginPath();
      for (let x = k; x < cols; x += k) { ctx.moveTo(x * s + .5, 0); ctx.lineTo(x * s + .5, cv.height); }
      for (let y = 1; y < rows; y++) { ctx.moveTo(0, y * s + .5); ctx.lineTo(cv.width, y * s + .5); }
      ctx.stroke();
    }
    if (cols > 8 || rows > 8) {            // where one character of the tile ends and the next begins
      ctx.strokeStyle = 'rgba(255, 213, 79, .85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let x = 8; x < cols; x += 8) { ctx.moveTo(x * s, 0); ctx.lineTo(x * s, cv.height); }
      for (let y = 8; y < rows; y += 8) { ctx.moveTo(0, y * s); ctx.lineTo(cv.width, y * s); }
      ctx.stroke();
    }
    const range = d && st.tool === 'select' ? rectBetween(d.start, d.end) : st.sel;
    if (range) {
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#00e5ff';
      ctx.lineWidth = 2;
      ctx.strokeRect(range.x * k * s + 1, range.y * s + 1, range.w * k * s - 2, range.h * s - 2);
      ctx.setLineDash([]);
    }
    if (st.hover) {
      const covers = brushed([st.hover]);
      if (!d) {                               // what the brush covers
        ctx.fillStyle = 'rgba(255, 255, 255, .25)';
        covers.forEach(q => ctx.fillRect(q.x * k * s, q.y * s, k * s, s));
      }
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      outlineCells(ctx, covers, k * s, s);    // the cursor: the brush in its shape, size and pixel width
    }
  }

  // the ROM characters of the tile's codes: their set bits as hires pixels (a multicolor pixel is
  // two of them), s the size of one
  function drawRomOverlay(ctx, s) {
    if (!st.rom.shown) return;
    const rom = video().cells === 'atari' ? atariRom() : romFont(overlaySet());              // the ROM as it is (chargen.js)
    ctx.save();
    ctx.globalAlpha = st.rom.opacity;
    ctx.fillStyle = ROM_OVERLAY;
    tileChars().forEach((code, n) => {
      const x0 = (n % st.tile.w) * 8, y0 = Math.floor(n / st.tile.w) * 8;
      for (let y = 0; y < 8; y++) {
        const b = rom[code * 8 + y];
        for (let x = 0; x < 8; x++) if (b & (0x80 >> x)) ctx.fillRect((x0 + x) * s, (y0 + y) * s, s, s);
      }
    });
    ctx.restore();
  }

  function romOverlaySection() {
    const r = st.rom;
    const set = props => { Object.assign(st.rom, props); draw(); update(); };
    return section('§0728',
      iconButton(r.shown ? 'visibility' : 'visibility_off', r.shown ? '§0729' : '§0730',
        () => set({ shown: !r.shown }), 'md-icon-button--sm'),
      h('div', { class: 'section__hint', style: { margin: '0 0 6px' } },
        '§0731'),
      r.shown ? [
        slider({ label: '§0713', min: 10, max: 100, step: 5, value: Math.round(r.opacity * 100), format: v => tr('§0715', v),
          oninput: v => { st.rom.opacity = v / 100; draw(); }, onchange: v => set({ opacity: v / 100 }) }),
        h('div', { class: 'trace-row' }, segmented([
          { value: 'upper', label: '§0732', tip: '§0734' },
          { value: 'lower', label: '§0733', tip: '§0735' }],
        overlaySet(), v => set({ set: v }))),
        h('div', { class: 'trace-row' }, segmented([
          { value: 'behind', label: '§0794', tip: '§0720' },
          { value: 'front', label: '§0719', tip: '§0721' }],
        r.front ? 'front' : 'behind', v => set({ front: v === 'front' })))] : '');
  }

  // back to the ROM: the selected character - its tile, or the characters marked in the grid -, or
  // all 256 (all), from the ROM set of the section (the set of the overlay, else the game's case).
  // Asked first, one undo step
  async function resetFromRom(all = false) {
    const d = data();
    if (!d) return;
    const rom = video().cells === 'atari' ? atariRom() : romFont(overlaySet()), set = overlaySet() === 'upper' ? '§0732' : '§0733';   // the ROM as it is, without the panel glyphs
    const marked = markedCodes(), codes = all ? Array.from({ length: 256 }, (_, k) => k) : marked ?? tileChars();
    const what = all ? tr('§1520', tr(set)) : marked ? tr('§1458', marked.length)
      : codes.length > 1 ? tr('§1461', codes[0], codes.at(-1)) : tr('§1459', st.code, '$' + st.code.toString(16).padStart(2, '0'));
    if (!(await confirmRemove({ what, detail: tr('§1521', tr(set)), kind: all ? 'reset:charset' : 'reset:chars', verb: 'reset' }))) return;
    snapshot();
    const out = d.slice();
    for (const code of codes) out.set(rom.subarray(code * 8, code * 8 + 8), code * 8);
    writeBytes(out);
    snackbar(all ? tr('§1522', tr(set)) : tr('§1523', codes.length, tr(set)));
  }

  function resetSection() {
    const n = (markedCodes() ?? tileChars()).length;
    return section('§1514', null,
      h('div', { class: 'section__hint', style: { margin: '0 0 8px' } }, '§1515'),
      h('div', { class: 'trace-row' }, segmented([
        { value: 'upper', label: '§0732', tip: '§0734' },
        { value: 'lower', label: '§0733', tip: '§0735' }],
      overlaySet(), v => { st.rom.set = v; draw(); update(); })),
      h('div', { class: 'inline-actions', style: { marginTop: '10px' } },
        button(n > 1 ? tr('§1516', n) : '§1517', { icon: 'restart_alt', variant: 'tonal', onclick: () => resetFromRom(false) }),
        button('§1524', { icon: 'restart_alt', variant: 'outlined', onclick: () => resetFromRom(true) })));
  }

  function status() {
    if (!ui) return;
    const c = st.hover;
    const tile = st.tile.w * st.tile.h > 1 ? tr('§1966', st.tile.w, st.tile.h, tileText()) : '';
    const head = tr('§0661', tile, st.code, hex2(st.code), multicolor() ? 'multicolor · 4 × 8 double wide pixels' : ecmMode() ? '§1967' : 'hires · 8 × 8 pixels');
    const marked = markedCodes();
    const range = (st.sel ? ` · range ${st.sel.w} × ${st.sel.h}` : '') + (marked ? ` · ${marked.length} characters marked` : '');
    statusLine.value = c && data() ? `${head}${range} · x ${c.x}, y ${c.y} · ${penLabel(pixels()[c.y][c.x])}` : head + range;
  }

  let savedDirty = null;
  function updateSave() {                   // the Save button of the bar follows the file
    const dirty = isCharsetDirty(st.key);
    if (dirty !== savedDirty) { savedDirty = dirty; update(); }
  }

  function refresh() {
    draw();
    drawCharGrid();
    status();
    updateSave();
  }

  // while drawing: once a frame, however many pointer moves came - the canvas, the status line
  // and, of the grid, only the chars that changed (codes; none: the canvas only)
  let frame = 0, dirtyChars = new Set();
  function later(codes = []) {
    codes.forEach(c => dirtyChars.add(c));
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      const codes = dirtyChars;
      dirtyChars = new Set();
      draw();
      if (codes.size) { drawCharGrid(codes); updateSave(); }
      status();
    });
  }

  // --- input -------------------------------------------------------------------------

  // the pixel under the pointer, the nearest one of the characters outside them; free: the pixel outside as well
  function cellAt(e, free = false) {
    const r = ui.canvas.getBoundingClientRect();
    const cols = 8 * st.tile.w, rows = 8 * st.tile.h;
    const fx = Math.floor((e.clientX - r.left) / r.width * cols), fy = Math.floor((e.clientY - r.top) / r.height * rows);
    const px = free ? fx : clamp(fx, 0, cols - 1);
    return { x: multicolor() ? px >> 1 : px, y: free ? fy : clamp(fy, 0, rows - 1) };
  }

  function onDown(e) {
    if (!data()) return;
    e.preventDefault();
    ui.canvas.setPointerCapture(e.pointerId);
    ui.wrap.focus({ preventScroll: true });
    const cell = cellAt(e);
    if (waits(st.drag)) { strokeDown(st.drag, cellAt(e, true), e); draw(); return; }   // the bend of a curve, a corner of a polygon
    const value = e.button === 2 ? 0 : st.pen;
    if (st.tool === 'pick') { setPen(pixels()[cell.y][cell.x]); setTool('pencil'); return; }
    if (st.tool === 'select') { st.drag = { start: cell, end: cell }; draw(); return; }
    if (!WAIT_TOOLS.has(st.tool) && st.tool !== 'smooth') snapshot();   // the curve and the polygon when they draw, the smoother with its first shade: a stroke of nothing is no step
    if (st.tool === 'pencil') { st.drag = { last: cell, value }; paintCells(brushed([cell]), value); }
    else if (st.tool === 'smooth') { st.drag = { last: cell, shaded: new Set() }; smoothPixels(brushed([cell]), st.drag); }
    else if (dragTool()) { st.drag = { start: cell, end: cell, value, ...dragMods(e) }; draw(); }
    else if (st.tool === 'fill') paintCells(floodCells(pixels(), cell, value), value);
  }

  function onMove(e) {
    if (!ui || !data()) return;
    const cell = cellAt(e);
    const d = st.drag;
    if (d && WAIT_TOOLS.has(st.tool)) {   // beyond the characters as well: dragCells clips the curve or the polygon
      const at = cellAt(e, true), p = d.bend ?? d.end;
      st.hover = cell;
      if (at.x !== p.x || at.y !== p.y) { dragTo(d, at, e); later(); }
      return;
    }
    if (st.hover?.x === cell.x && st.hover?.y === cell.y) return;
    st.hover = cell;
    if (d && st.tool === 'pencil') { paintCells(brushed(lineCells(d.last, cell)), d.value); d.last = cell; }
    else if (d && st.tool === 'smooth') { smoothPixels(brushed(lineCells(d.last, cell)), d); d.last = cell; }
    else if (d) dragTo(d, cell, e);
    later();
  }

  function onUp() {
    const d = st.drag;
    st.drag = null;
    if (d && curveWaits(st.tool, d)) { st.drag = d; draw(); return; }
    if (d && WAIT_TOOLS.has(st.tool)) snapshot();
    if (d && dragTool()) paintCells(dragCells(d), d.value);
    if (d && st.tool === 'select') {        // a click without dragging clears the range
      st.sel = d.start.x === d.end.x && d.start.y === d.end.y ? null : rectBetween(d.start, d.end);
      status();
    }
    draw();
  }

  function onKey(e) {
    if (e.target.closest('input, select, textarea')) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const tool = toolForKey(TOOLS, key);
    const op = rangeForKey(rangeKeys(), e) ?? (key === 't' && rangeKeys().includes('rotr') ? 'rotr' : null);
    const pen = pens()[Number(e.key) - 1];
    if (mod && key === 'c') copyChar();
    else if (mod && key === 'v') pasteChar();
    else if (mod || e.altKey) return;
    else if (tool) setTool(tool);
    else if (op) apply(op);
    else if (pen !== undefined) setPen(pen);
    else if (e.key === 'Escape') cancel();
    else if (e.key === '[' || e.key === ']') setCode((st.code + (e.key === ']' ? 1 : 255)) & codeMask());
    else if (e.key === '+') zoom(1);
    else if (e.key === '-') zoom(-1);
    else return;
    e.preventDefault();
  }

  // the range tools: no rotation by 90 degrees in multicolor, its pixels are double wide (turned
  // in space they keep their proportions)
  const rangeKeys = () => (multicolor() ? RANGE.filter(k => k !== 'rotl' && k !== 'rotr') : RANGE);

  function setTool(tool) {
    if (waits(st.drag)) { st.drag = null; draw(); }   // a curve or a polygon not drawn yet is dropped
    st.tool = tool;
    update();
  }

  function setPen(v) {
    st.pen = v;
    update();
  }

  function setCode(code) {
    st.code = code & codeMask();
    refresh();
    update();
  }

  function zoom(dir) {
    const k = ZOOM.indexOf(st.cell);
    st.cell = ZOOM[clamp((k < 0 ? 2 : k) + dir, 0, ZOOM.length - 1)];
    draw();
  }

  // --- side panel ----------------------------------------------------------------------

  // --- grid panel: all 256 characters, wrapping into as many rows as needed ----------

  // all characters in one row that wraps; dragging (or shift+click) marks characters: the tools
  // of the bar then change all of them. cells: {cv, code, el} for drawCharGrid
  function charGrid(cells) {
    const items = Array.from({ length: 256 }, (_, code) => {
      const cv = dh('canvas', { width: 32, height: 32 });
      const cellEl = dh('div', { class: 'asset-cell asset-cell--char' }, cv);
      cellEl.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        cdrag = { anchor: e.shiftKey && st.range ? st.range.anchor : code, to: code };
        markCharDrag();
        window.addEventListener('pointerup', endCharDrag, { once: true });
      });
      cellEl.addEventListener('pointerenter', e => {
        if (cdrag && e.buttons & 1 && cdrag.to !== code) { cdrag.to = code; markCharDrag(); }
      });
      cells.push({ cv, code, el: cellEl });
      return cellEl;
    });
    return dh('div', { class: 'asset-grid__items' }, items);
  }

  const codesBetween = (a, b) => Array.from({ length: Math.abs(b - a) + 1 }, (_, k) => Math.min(a, b) + k);

  function markCharDrag() {
    const codes = new Set(codesBetween(cdrag.anchor, cdrag.to));
    for (const { code, el: cellEl } of ui?.cells ?? []) cellEl.classList.toggle('asset-cell--range', codes.has(code));
  }

  // the mouse is up: one character is picked, several are marked
  function endCharDrag() {
    const d = cdrag;
    cdrag = null;
    if (!d) return;
    st.range = { anchor: d.anchor, codes: codesBetween(d.anchor, d.to) };
    setCode(st.range.codes.length > 1 ? Math.min(d.anchor, d.to) : d.to);
    markCharGrid();
    update();                           // the character, and what to do with the marked ones
    update();
    ui?.wrap.focus({ preventScroll: true });
  }

  // only: the codes to draw again (their pixels changed), else all of them
  function drawCharGrid(only = null) {
    const d = data(), c = colors(), tile = new Set(tileChars());
    for (const { cv, code, el: cellEl } of ui?.cells ?? []) {
      if (only && !only.has(code)) continue;
      cellEl.style.display = code > codeMask() ? 'none' : '';     // extended color mode: only the chars 0-63 are shown
      cellEl.classList.toggle('asset-cell--selected', tile.has(code));
      const ctx = cv.getContext('2d');
      if (d) drawGlyph(ctx, d, code, 0, 0, cv.width, glyphFg(), c.bg, glyphMc());
    }
    markCharGrid();
  }

  const markedCodes = () => (st.range?.codes.length > 1 ? st.range.codes : null);

  // the marked characters
  // Escape: the curve being bent, else the range on the canvas and the characters marked in the grid
  function cancel() {
    if (rot.stop(false)) return true;
    if (waits(st.drag)) { st.drag = null; draw(); return true; }   // a curve or a polygon not drawn yet
    if (!st.sel && !st.range) return false;
    st.sel = null; st.range = null;
    markCharGrid(); draw(); status(); update();
    return true;
  }

  function markCharGrid() {
    if (cdrag) return;
    const marked = new Set(markedCodes() ?? []);
    for (const { code, el: cellEl } of ui?.cells ?? []) cellEl.classList.toggle('asset-cell--range', marked.has(code));
  }

  // the bar above the characters: how many are marked
  function gridBarView() {
    const marked = markedCodes();
    return h('div', { class: 'asset-grid__bar' }, h('div', { class: 'asset-grid__range' }, marked ? [
      icon('select_all'),
      h('span', { class: 'md-body-medium' }, tr('§0662', marked.length)),
      h('span', { class: 'md-body-small' }, '§1968'),
      iconButton('close', '§0663', () => { st.range = null; markCharGrid(); update(); }, 'md-icon-button--sm'),
    ] : h('span', { class: 'md-body-small' }, '§1969')));
  }

  const section = (title, action, ...content) => uiSection(title, content, action);


  function fileHint() {
    const state = charsetState(st.key), size = charsetFileSize(st.key);
    if (state === 'missing' && !data()) return '§0666';
    if (state === 'loading') return '§0667';
    if (state === 'error' && !data()) return '§0668';
    const parts = [size == null ? '§0669' : tr('§0670', size)];
    if (size != null && size !== CHARSET_SIZE && size !== CHARSET_SIZE + 2) parts.push(`Save writes ${CHARSET_SIZE} bytes`);
    if (isCharsetDirty(st.key)) parts.push('unsaved changes');
    return parts.join(' · ');
  }

  function sideView() {
    const d = data(), c = colors(), mc = multicolor();
    const setColor = (key, k) => { st.colors = { ...st.colors, [key]: k }; refresh(); update(); };

    // the pens and their colors: a row is the pen (the bit pattern it draws), its swatch
    // sets the preview color
    const penOf = { bg: 0, fg: mc ? mcPair('color') : 1, mc1: 1, mc2: mcPair('mc2') }, names = mcNames();
    const vic = video().cells === 'vic';
    const row = (label, k, color, disabled, tip, count = 16, stored = v => v) => ({
      label, color, count, disabled, active: !disabled && st.pen === penOf[k], onselect: () => setPen(penOf[k]),
      tip: disabled ? tip : tr('§1085', tip, pens().indexOf(penOf[k]) + 1), onpick: v => setColor(k, stored(v)),
    });
    // extended color mode: the four backgrounds, a click draws on one of them
    const ecmRows = () => [c.bg1, ...c.ecm].map((color, k) => ({
      label: tr('§1183', k + 1), color, active: st.pen === 0 && st.ecmBg === k,
      tip: tr('§0982', k + 1, 1 + k, k * 64, k * 64 + 63),
      onselect: () => { st.ecmBg = k; setPen(0); refresh(); },
      onpick: v => (k ? setColor('ecm', c.ecm.map((x, i) => (i === k - 1 ? v : x))) : setColor('bg', v)),
    }));
    const chooser = c.ecm ? colorChooser([
      ...ecmRows(),
      row('§0637', 'fg', c.fg, false, '§0673'),
    ]) : colorChooser([
      row('§0636', 'bg', c.bg, false, '§0671'),
      row('§0637', 'fg', mc ? mcCellColor(c.fg) : c.fg, false, mc ? '§0672' : '§0673',
        mc ? 'mc' : vic ? 'cell' : 16, v => (mc ? mcCell(v) : v)),
      row(vic ? names.mc1 : '§0650', 'mc1', c.mc1, !mc, mc ? (vic ? names.mc1 : video().cells === 'ted' ? names.mc1 : 'Multicolor 1 ($d022)') : '§0674', vic ? 'cell' : 16),
      row(vic ? names.mc2 : '§0651', 'mc2', c.mc2, !mc, mc ? (vic || video().cells === 'ted' ? names.mc2 : 'Multicolor 2 ($d023)') : '§0675'),
    ]);

    return [
      rot.on && section('§1731', rot.actions(), rot.view()),
      // a file without characters yet: the only way to fill it
      !d ? section('§0676', null,
        h('div', { class: 'section__hint', style: { margin: '0 0 12px' } }, fileHint()),
        button('§0677', { icon: 'auto_fix_high', variant: 'tonal', onclick: createFromRom })) : '',
      section('§0864', null,
        chooser,
        h('div', { class: 'section__hint', style: { margin: '14px 0 0' } },
          '§0954'),
        c.ecm ? h('div', { class: 'section__hint', style: { margin: '8px 0 0' } },
          '§0983') : '',
        d && mc ? swapSection() : ''),
      d ? romOverlaySection() : '',
      d ? resetSection() : '',
    ];
  }

  // --- render ----------------------------------------------------------------------------

  // what the editor draws on is made once; the views show it (pui.dom)
  function islands() {
    if (ui) return;
    const canvas = dh('canvas', { class: 'chars-canvas',
      onpointerdown: onDown, onpointermove: onMove, onpointerup: onUp, onpointercancel: onUp,
      onpointerleave: () => { st.hover = null; draw(); status(); },
      oncontextmenu: e => e.preventDefault() });
    const wrap = dh('div', { class: 'chars-wrap', tabindex: 0, onkeydown: onKey }, canvas);
    wheelZoom(wrap, () => ui?.canvas, zoom);   // the wheel zooms
    const cells = [];
    ui = { canvas, wrap, cells, grid: charGrid(cells) };
  }

  // the charset as it is edited: its 2048 bytes, or a sheet of its 256 characters in the colors
  // of the view, 16 x 16, 2 screen pixels per C64 pixel
  // what the Export button of the app bar offers here (app.js)
  function exportFormats() {
    const d = store.game && st.key ? data() : null;
    if (!d) return [];
    return [
      video().cells === 'atari'
        ? { label: 'Atari font (.fnt, 128 chars)', name: exportName(st.key, 'fnt'), description: 'Atari font', bytes: () => d.slice(0, FONT_SIZE) }
        : { label: '§0988', name: exportName(st.key, 'chr'), description: 'C64 charset', bytes: () => d.slice(0, CHARSET_SIZE) },
      { label: '§0989', icon: 'wallpaper', name: exportName(st.key, 'png'), type: 'image/png', description: 'PNG picture',
        bytes: () => pngOf(pixelCanvas(128, 128, 2, ctx => {
          for (let code = 0; code < 256; code++) drawGlyph(ctx, d, code, (code % 16) * 16, (code >> 4) * 16, 16, glyphFg(), colors().bg, glyphMc());
        })) },
    ];
  }

  function barView() {
    if (!store.game) return null;
    const mc = multicolor();
    return h('div', { class: 'screen-bar' },
      h('span', { class: 'md-title-medium' }, 'Chars'),
      h('span', { class: 'screen-bar__sep' }),
      iconButton('add', '§0679', () => newCharset()),
      st.key ? iconButton('delete', tr('§1608', scriptRelative(st.key)), deleteCharset) : '',
      st.key ? [h('span', { class: 'screen-bar__sep' }), defaultTools({
        undo: () => travel(undo, redo), redo: () => travel(redo, undo), zoom,
        grid: { on: st.grid, toggle: () => { st.grid = !st.grid; update(); draw(); } },
        multicolor: !hasMulticolor() ? undefined : { on: mc, toggle: () => { st.mode = !mc; if (!pens().includes(st.pen)) st.pen = pens()[0]; render(); },
          locked: ecmMode() ? '§0985' : null },
        clear: { tip: '§0694', run: () => apply('clear') },
      }), h('span', { class: 'screen-bar__sep' }),
      brushTools({ brush: st.brush, tool: st.tool, max: brushMax(brushGrid()), onchange: b => { st.brush = b; update(); draw(); } }),
      radiusTools({ radius: st.radius, tool: st.tool, max: radiusMax(brushGrid()), onchange: v => { st.radius = v; update(); draw(); } }),
      h('span', { class: 'screen-bar__sep' }),
      h('span', { class: 'md-body-small', 'data-tip': '§0680' }, '§0681'),
      sizePicker({ w: st.tile.w, h: st.tile.h, onchange: setTile }),
      // 1 x 2: the lower char in the inverse half of the charset instead of the next char
      st.tile.w === 1 && st.tile.h === 2 && !ecmMode() ? checkbox('§1600', st.inverse, on => { st.inverse = on; render(); }, { tip: '§1601' }) : ''] : '',
      h('div', { class: 'app-bar__spacer' }));
  }

  const StatusLine = () => h('span', { class: 'md-body-small screen-status' }, statusLine.value);

  function bodyView() {
    if (!store.game) return null;
    if (!st.key) {
      return h('div', { class: 'empty-state' }, icon('grid_view'),
        h('div', { class: 'md-title-medium' }, '§0683'),
        h('div', { class: 'md-body-medium' }, '§0684'),
        button('§0659', { icon: 'add', variant: 'filled', onclick: () => newCharset() }));
    }
    // the range tools, in the toolbox left of the canvas below the drawing tools
    const range = { keys: rangeKeys(), run: op => apply(op), tips: { rotr: '§0692' } };
    return [
      h('div', { class: 'screen-body' },
        h('div', { class: 'chars-main' },
          h('div', { class: 'chars-row' },
            h('div', { class: 'chars-block' }, paintArea({ tools: TOOLS, current: st.tool, onselect: setTool, range }, dom(ui.wrap)), h('div', { class: 'md-body-small chars-caption' }, '§1059'))),
          h('div', { class: 'screen-foot' }, h(StatusLine, {}))),
        sidePanel('Chars', sideView())),
      h('div', { class: 'asset-grid' }, gridBarView(), dom(ui.grid)),
    ];
  }

  function render() {
    if (store.game) {
      const keys = knownKeys();
      if (!st.key && keys.length) st.key = keys[0];
      st.code &= codeMask();              // extended color mode: the chars 0-63
      st.sel = clipRect(st.sel, charW() * st.tile.w, 8 * st.tile.h);
      islands();
    }
    const hadFocus = el.contains(document.activeElement);
    hadData = !!data();
    views ??= [mount(bar, barView), mount(el, bodyView)];
    update();
    if (store.game) actions.route?.();            // the address follows what is open (app.js)
    if (!store.game || !st.key) return;
    refresh();
    if (hadFocus) ui.wrap.focus({ preventScroll: true });
  }

  followCurve(() => ui, () => WAIT_TOOLS.has(st.tool) && waits(st.drag), onMove, onDown,
    () => { if (closePolygon(st.drag)) onUp(); });   // Enter: the polygon closes and draws

  store.on((type, detail) => {
    if (type === 'load') { st.key = null; st.placeId = null; st.mode = null; st.colors = null; st.range = null; listed = false; }
    if (el.hidden) return;
    if (type === 'load') render();
    else if (type === 'change') {
      if (detail.source === 'chars') return;                    // the speed slider is dragged
      if (detail.source !== 'charset') render();
      else if (ui && hadData !== !!data()) render();
      else update();
    }
  });

  // what a reload keeps (uistate.js): the char drawn on, the tools, the pens, the zoom, the ROM overlay
  const KEEP = ['code', 'tool', 'pen', 'cell', 'grid', 'brush', 'radius', 'tile', 'inverse', 'ecmBg', 'rom'];
  keepUi('chars', { save: () => pickUi(st, KEEP), load(s) { putUi(st, s, KEEP); if (!el.hidden) render(); } });

  return {
    cancel,
    importFormats,
    current: () => st.key,                       // the charset open: its path in the project
    selectKey(key) { if (key !== st.key) { st.key = key; st.mode = null; st.colors = null; } },
    select(file, placeId) {
      st.placeId = placeId ?? null;
      if (file) { st.key = charsetKey(file); st.mode = null; st.colors = null; }
    },
    open() {
      render();
      if (!listed) refreshFiles().then(render);
      ui?.wrap.focus({ preventScroll: true });
    },
    exportFormats,
    undo: () => travel(undo, redo),
    redo: () => travel(redo, undo),
    copy: copyChar, paste: pasteChar,
    render,
  };
}
