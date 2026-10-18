// tiles.js - the tile editor: the tilesets (.til, tileset.js) places are painted with
//
// A tileset is a list of tiles of 2 x 2 or 3 x 3 chars, each cell a char of the charset and its
// color. A tileset is bound to a charset (a .chr or the ROM set): the editor draws its chars, with
// the background and the multicolors of the place that uses the tileset; the places painted with
// it take its charset (tileset.js: syncTiles). A click puts the char and the color of the brush into a cell of the tile, a
// right click takes them from it. Every change goes into the tileset cache at once and the
// places painted with the tileset show it (their chars are the tiles expanded, tileset.js:
// syncTiles); Save writes the file. The tiles have an undo of their own, like the chars.

import { LAYOUT } from './layout.js';
import { listBinaries } from './project.js';
import { exportName, importName } from './export.js';
import { symbols, getAttr, PLACE_COLS, gameRows, screensOf } from './adv.js';
import { colorChooser } from './colorchooser.js';
import { defaultTools, wheelZoom } from './drawtools.js';
import { PALETTE, placeInfo, drawCell } from './c64.js';
import { scriptDirectory, charsetByKey, charsetKey, onCharsetChange } from './chr.js';
import {
  TILE_SIZES, MAX_TILES, NO_TILE, blankTile, starterTileset, encodeTileset, decodeTileset, tilesetByKey, tilesetKey, tilesetState, tilesetError,
  setTileset, isTilesetDirty, dirtyTilesets, saveTileset, onTilesetChange, syncTiles, tilePlaces, tilesetCharset, charsetOfTileset,
} from './tileset.js';
import {
  h, dh, dom, mount, signal, icon, iconButton, button, select, promptDialog, snackbar, section as uiSection, sidePanel, storeVersion,
  confirmRemove,
} from './pui.js';
import { tr } from './i18n.js';
import { video, mcCell, mcCellColor, pickerColors, hasMulticolor } from './video.js';
import { keepUi, pick as pickUi, put as putUi } from './uistate.js';

const ZOOM = [4, 6, 8, 10, 12];             // screen pixels per C64 pixel of the tile
const LIST_PX = 2;                          // of the tiles in the list
const PICK_PX = 2;                          // of the chars in the picker
const hex2 = n => '$' + n.toString(16).padStart(2, '0');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function createTileEditor(el, store, actions, bar) {
  const st = {
    key: null, placeId: null, tile: 0, code: 160, color: 1, zoom: 8, grid: true,
    hover: null, painting: false, files: [],
    drag: null,                                   // the chars of the picker a drag spans: { from, to } codes
  };
  const undo = new Map(), redo = new Map();       // per tileset: its tiles before a change
  let ui = null;                                  // the canvases, made once
  let views = null;
  const update = () => views?.forEach(v => v.update());
  const statusLine = signal('');
  const version = storeVersion(store);

  // --- model -------------------------------------------------------------------------

  const ts = () => tilesetByKey(st.key);
  const S = () => symbols(store.game);
  const placesUsing = key => tilePlaces(store.game).filter(([, , f]) => tilesetKey(f) === key).map(([r]) => r);
  // the place the tiles are shown in: the one picked, else the first that uses the tileset
  function previewPlace() {
    if (!store.game) return null;
    const using = placesUsing(st.key);
    return using.find(r => r.id === st.placeId) ?? using[0] ?? (st.placeId ? store.node(st.placeId) : null);
  }
  // how a cell is drawn: the charset of the tileset, the background and the multicolors of the
  // place (a multicolor tileset without a multicolor place shows them in grey)
  let lookKey = null, lookNow = null;
  function look() {
    const key = `${version.peek()}|${st.key}|${st.placeId}|${ts()?.multicolor}|${ts()?.charset}`;
    if (key === lookKey) return lookNow;
    const r = previewPlace(), info = r ? placeInfo(store.game, r) : null, chrKey = st.key ? tilesetCharset(st.key) : null;
    lookNow = {
      place: r,
      bg: info?.bg ?? 0,
      charset: S().charset,
      chr: chrKey ? charsetByKey(chrKey) : null,
      mc: ts()?.multicolor ? (info?.multicolor ?? [11, 12]) : null,
    };
    lookKey = key;
    return lookNow;
  }
  const multicolor = () => hasMulticolor() && !!ts()?.multicolor;
  // the brush color as the tileset keeps it: 8-15 in a multicolor tileset
  const brushColor = () => (multicolor() ? mcCell(st.color) : st.color);

  function knownKeys() {
    const keys = new Set(st.files);
    if (store.game) for (const [, , f] of tilePlaces(store.game)) keys.add(tilesetKey(f));
    for (const r of screensOf(store.game)) { const f = getAttr(r, 'tiles'); if (f) keys.add(tilesetKey(f)); }
    if (st.key) keys.add(st.key);
    return [...keys].sort();
  }
  const refreshFiles = () => { st.files = listBinaries().filter(f => /\.til$/i.test(f)); };
  // the charsets of the project a tileset can be bound to (project paths), '' the ROM set
  const charsetKeys = (...more) => [...new Set([...listBinaries().filter(f => /\.(chr|fnt|bin|raw)$/i.test(f)), ...more.filter(Boolean)])].sort();
  const charsetOptions = keys => [{ value: '', label: tr('§0852', S().charset) }, ...keys.map(k => ({ value: k, label: k }))];
  // the charset of the place of the preview: a new tileset takes it
  function placeCharsetKey() {
    const r = st.placeId ? store.node(st.placeId) : null, f = r && getAttr(r, 'charset');
    return f ? charsetKey(f) : '';
  }

  // how often each tile is in the places painted with the tileset
  function usage() {
    const n = new Map();
    for (const [r, bg, f] of store.game ? tilePlaces(store.game) : []) {
      if (tilesetKey(f) !== st.key) continue;
      for (const t of bg.tiles.cells) if (t !== NO_TILE) { const u = n.get(t) ?? { count: 0, places: new Set() }; u.count++; u.places.add(r.name); n.set(t, u); }
    }
    return n;
  }

  // --- changes -----------------------------------------------------------------------

  const copy = t => ({ ...t, tiles: t.tiles.map(x => ({ chars: [...x.chars], colors: [...x.colors] })) });
  function snapshot() {
    const t = ts();
    if (!t) return;
    const list = undo.get(st.key) ?? [];
    list.push(copy(t));
    if (list.length > 200) list.shift();
    undo.set(st.key, list);
    redo.set(st.key, []);
  }
  function travel(from, to) {
    const list = from.get(st.key);
    if (!ts() || !list?.length) return;
    if (!to.has(st.key)) to.set(st.key, []);
    to.get(st.key).push(copy(ts()));
    const t = list.pop();
    st.tile = clamp(st.tile, 0, t.tiles.length - 1);
    setTileset(st.key, t);
    render();
  }
  // a change of the tiles: into the cache, the places follow (syncTiles)
  function change(fn) {
    const t = copy(ts());
    fn(t);
    setTileset(st.key, t);
    refresh();
  }

  function paintCell(k, button) {
    const t = ts(), tile = t?.tiles[st.tile];
    if (!tile) return;
    if (button === 2) {                       // the right button takes the char and the color
      st.code = tile.chars[k];
      st.color = tile.colors[k];
      update();
      drawPicker();
      return;
    }
    if (tile.chars[k] === st.code && tile.colors[k] === brushColor()) return;
    change(x => { x.tiles[st.tile].chars[k] = st.code; x.tiles[st.tile].colors[k] = brushColor(); });
  }

  function addTile(dup = false) {
    const t = ts();
    if (!t) return;
    if (t.tiles.length >= MAX_TILES) return snackbar(tr('§1381', MAX_TILES), { error: true });
    snapshot();
    change(x => { x.tiles.push(dup ? { chars: [...x.tiles[st.tile].chars], colors: [...x.tiles[st.tile].colors] } : blankTile(x.size, x.multicolor)); });
    st.tile = ts().tiles.length - 1;
    render();
  }

  // a tile no place shows: the tiles after it move up a number, in the maps of the places too
  // (a step of the story's undo); the undo of the tiles starts anew, it would not know the maps
  async function removeTile() {
    const t = ts(), used = usage().get(st.tile);
    if (!t || t.tiles.length < 2) return;
    if (used) return snackbar(tr('§1382', st.tile, [...used.places].join(', ')), { error: true });
    const gone = st.tile;
    const after = t.tiles.length - 1 - gone;
    if (!(await confirmRemove({ what: tr('§1473', gone, st.key), detail: after ? tr('§1474', after) : null, kind: 'tile', undo: false }))) return;
    if (ts() !== t || st.tile !== gone) return;
    store.mutate(game => {
      for (const [, bg, f] of tilePlaces(game)) {
        if (tilesetKey(f) === st.key) bg.tiles.cells = bg.tiles.cells.map(c => (c !== NO_TILE && c > gone ? c - 1 : c));
      }
    }, { source: 'tiles' });
    change(x => { x.tiles.splice(gone, 1); });
    undo.delete(st.key); redo.delete(st.key);
    st.tile = clamp(gone, 0, ts().tiles.length - 1);
    render();
  }

  async function clearTile() {
    if (!ts()) return;
    const used = usage().get(st.tile);
    if (!(await confirmRemove({ what: tr('§1475', st.tile), detail: used ? tr('§1476', used.count, [...used.places].join(', ')) : null, kind: 'clear:tile', verb: 'clear' }))) return;
    snapshot();
    change(x => { x.tiles[st.tile] = blankTile(x.size, x.multicolor); });
  }

  // the charset the tileset is bound to (a project path, '' the ROM set): the places painted with
  // it follow (syncTiles)
  function setCharset(chrKey) {
    if (!ts() || (tilesetCharset(st.key) ?? '') === chrKey) return;
    snapshot();
    lookKey = null;
    change(x => { x.charset = charsetOfTileset(st.key, chrKey); });
    update();
  }

  // hires <-> multicolor: the colors of the cells move to 0-7 or 8-15
  function toggleMode() {
    if (!ts()) return;
    snapshot();
    change(x => {
      x.multicolor = !x.multicolor;
      for (const tile of x.tiles) tile.colors = tile.colors.map(c => (x.multicolor ? mcCell(c) : mcCellColor(c)));
    });
    render();
  }

  // a new tileset, of a size and a mode; imported: { tileset, name } - the tiles of a file
  async function newTileset(imported = null) {
    const known = knownKeys();
    const base = imported ? importName(imported.name, 'tiles') : 'tiles';
    const dir = `${scriptDirectory()}${LAYOUT.tiles}/`;           // gfx/tiles/ (layout.js)
    let path = `${dir}${base}.til`;
    for (let k = 2; known.includes(path); k++) path = `${dir}${base}${k}.til`;
    const chrDefault = imported?.tileset.charset ? '' : placeCharsetKey();
    const v = await promptDialog({
      title: imported ? '§1383' : '§1384', ok: '§0124',
      text: imported ? tr('§1385', imported.name, imported.tileset.tiles.length) : '§1386',
      fields: [
        { name: 'path', label: '§1263', value: path, mono: true,
          validate: p => (!/^[\w\-./]+\.til$/i.test(p) || p.includes('..') ? '§1387' : known.includes(p) ? '§0208' : null) },
        ...(imported ? [] : [
          // how many tiles of each size a screen of 40 x 17 (19: the verb coin) holds - 3 x 3 cut at its edges
          { name: 'size', label: '§1388', radios: TILE_SIZES.map(n => ({ value: String(n),
            label: tr('§1424', tr('§1375', n), Math.ceil(PLACE_COLS / n), Math.ceil(gameRows(store.game) / n), PLACE_COLS, gameRows(store.game)) })) },
          { name: 'mode', label: '§1389', radios: [{ value: 'hires', label: '§1376' }, { value: 'multicolor', label: '§1377' }] },
        ]),
        { name: 'charset', label: '§0461', value: chrDefault, options: charsetOptions(charsetKeys(chrDefault)) },
      ],
    });
    if (!v) return;
    st.key = v.path;
    st.tile = 0;
    const tiles = imported ? imported.tileset : starterTileset(Number(v.size), v.mode === 'multicolor');
    setTileset(v.path, { ...tiles, charset: charsetOfTileset(v.path, v.charset || null) });
    lookKey = null;
    render();
  }

  async function importTiles(bytes, name) {
    await newTileset({ tileset: decodeTileset(bytes, name), name });
  }
  const importFormats = () => (!store.game ? [] : [{ label: '§1390', icon: 'grid_view', accept: '.til', open: importTiles }]);
  function exportFormats() {
    const t = store.game && st.key ? ts() : null;
    return t ? [{ label: '§1391', name: exportName(st.key, 'til'), description: 'yopaca tileset', bytes: () => encodeTileset(t) }] : [];
  }

  // --- drawing -----------------------------------------------------------------------

  // the cells of a tile at x, y with p screen pixels a C64 pixel
  function drawTile(ctx, tile, n, x, y, p) {
    const l = look();
    for (let k = 0; k < n * n; k++) {
      drawCell(ctx, tile.chars[k], x + (k % n) * 8 * p, y + Math.floor(k / n) * 8 * p, 8 * p, tile.colors[k], l.bg, l.charset, l.chr, l.mc);
    }
  }

  function draw() {
    const t = ts(), cv = ui?.canvas;
    if (!t || !cv) return;
    const n = t.size, s = 8 * st.zoom, size = n * s;
    if (cv.width !== size) cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = PALETTE[look().bg];
    ctx.fillRect(0, 0, size, size);
    drawTile(ctx, t.tiles[st.tile], n, 0, 0, st.zoom);
    ctx.lineWidth = 1;
    if (st.grid) {                                  // the pixels of the chars
      ctx.strokeStyle = 'rgba(128, 128, 128, .35)';
      ctx.beginPath();
      const step = multicolor() ? 2 * st.zoom : st.zoom;
      for (let x = step; x < size; x += step) { ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, size); }
      for (let y = st.zoom; y < size; y += st.zoom) { ctx.moveTo(0, y + .5); ctx.lineTo(size, y + .5); }
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255, 213, 79, .85)';    // where one char ends and the next begins
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let k = 1; k < n; k++) { ctx.moveTo(k * s, 0); ctx.lineTo(k * s, size); ctx.moveTo(0, k * s); ctx.lineTo(size, k * s); }
    ctx.stroke();
    if (st.hover != null) {
      ctx.strokeStyle = '#fff';
      ctx.strokeRect((st.hover % n) * s + 1, Math.floor(st.hover / n) * s + 1, s - 2, s - 2);
    }
  }

  // the list of the tiles: a canvas each, the one edited marked
  function drawList() {
    const t = ts(), list = ui?.list;
    if (!t || !list) return;
    const n = t.size, px = n * 8 * LIST_PX, used = usage();
    while (list.children.length > t.tiles.length) list.lastChild.remove();
    while (list.children.length < t.tiles.length) {
      const k = list.children.length;
      const cv = dh('canvas', { width: px, height: px });
      list.append(dh('div', { class: 'asset-cell asset-cell--tile', onclick: () => { st.tile = Number(cellOf(cv)); refresh(); update(); } }, cv));
    }
    [...list.children].forEach((cellEl, k) => {
      const cv = cellEl.firstChild;
      cv.dataset.tile = k;
      if (cv.width !== px) cv.width = cv.height = px;
      drawTile(cv.getContext('2d'), t.tiles[k], n, 0, 0, LIST_PX);
      cellEl.classList.toggle('asset-cell--selected', k === st.tile);
      const u = used.get(k);
      cellEl.dataset.tip = u ? tr('§1392', k, u.count, [...u.places].join(', ')) : tr('§1393', k);
    });
  }
  const cellOf = cv => cv.dataset.tile;

  // the 256 chars of the charset, 16 x 16 in code order: a click picks the char of the brush
  const pickPx = () => 8 * PICK_PX + 2;
  function drawPicker() {
    const cv = ui?.picker;
    if (!cv) return;
    const l = look(), size = 16 * pickPx() + 2;
    if (cv.width !== size) cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size, size);
    const multi = l.mc && brushColor() & 8;
    for (let code = 0; code < 256; code++) {
      drawCell(ctx, code, 2 + (code % 16) * pickPx(), 2 + (code >> 4) * pickPx(), 8 * PICK_PX,
        multi ? brushColor() : pickerColors().fg, multi ? l.bg : pickerColors().bg, l.charset, l.chr, multi ? l.mc : null);
    }
    ctx.strokeStyle = '#ffd54f';
    ctx.lineWidth = 2;
    const b = st.drag ? spanOf(st.drag.from, st.drag.to) : { x: st.code % 16, y: st.code >> 4, w: 1, h: 1 };
    ctx.strokeRect(1 + b.x * pickPx(), 1 + b.y * pickPx(), b.w * pickPx(), b.h * pickPx());
  }
  function pickAt(e) {
    const r = ui.picker.getBoundingClientRect();
    const at = v => clamp(Math.floor((v * ui.picker.width) / (r.width * pickPx())), 0, 15);
    return at(e.clientY - r.top) * 16 + at(e.clientX - r.left);
  }
  // the rectangle of chars between two codes of the picker
  function spanOf(a, b) {
    const x = Math.min(a % 16, b % 16), y = Math.min(a >> 4, b >> 4);
    return { x, y, w: Math.abs((a % 16) - (b % 16)) + 1, h: Math.abs((a >> 4) - (b >> 4)) + 1 };
  }
  // a drag over the picker: one char picks the brush; a block of the size of the tile (2 x 2,
  // 3 x 3) or as many chars in a row (4, 9) fills the tile at once, in reading order, in the
  // color of the brush
  function pickDown(e) {
    if (e.button !== 0) return;
    ui.picker.setPointerCapture(e.pointerId);
    const c = pickAt(e);
    st.drag = { from: c, to: c };
    drawPicker();
  }
  function pickMove(e) {
    const c = pickAt(e);
    ui.picker.title = tr('§0853', c, hex2(c));
    if (!st.drag || st.drag.to === c) return;
    st.drag.to = c;
    drawPicker();
  }
  function pickUp() {
    if (!st.drag) return;
    const b = spanOf(st.drag.from, st.drag.to), t = ts();
    st.drag = null;
    st.code = b.y * 16 + b.x;
    const n = t?.size;
    if (t && b.w * b.h > 1) {
      if (b.w * b.h !== n * n) { drawPicker(); return snackbar(tr('§1419', n, n * n)); }
      const codes = [];
      for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) codes.push((b.y + y) * 16 + b.x + x);
      snapshot();
      change(x => { x.tiles[st.tile].chars = codes; x.tiles[st.tile].colors = codes.map(() => brushColor()); });
    }
    drawPicker();
  }

  function status() {
    const t = ts();
    if (!t) { statusLine.value = ''; return; }
    const tile = t.tiles[st.tile], k = st.hover;
    const head = tr('§1394', st.tile, t.tiles.length, t.size, multicolor() ? tr('§1377') : tr('§1376'));
    statusLine.value = k != null && tile ? `${head} · ${tr('§1395', k % t.size, Math.floor(k / t.size), tile.chars[k], hex2(tile.chars[k]), tile.colors[k])}` : head;
  }

  function refresh() {
    draw();
    drawList();
    drawPicker();
    status();
    updateSave();
  }
  let savedDirty = null;
  function updateSave() {
    const dirty = dirtyTilesets().length > 0;
    if (dirty !== savedDirty) { savedDirty = dirty; actions.dirtyChanged?.(); update(); }
  }

  // --- input -------------------------------------------------------------------------

  function cellAt(e) {
    const t = ts(), r = ui.canvas.getBoundingClientRect(), n = t.size;
    const x = clamp(Math.floor(((e.clientX - r.left) / r.width) * n), 0, n - 1), y = clamp(Math.floor(((e.clientY - r.top) / r.height) * n), 0, n - 1);
    return y * n + x;
  }
  function onDown(e) {
    if (!ts()) return;
    e.preventDefault();
    ui.canvas.setPointerCapture(e.pointerId);
    ui.wrap.focus({ preventScroll: true });
    if (e.button !== 2) { snapshot(); st.painting = true; }
    paintCell(cellAt(e), e.button);
  }
  function onMove(e) {
    if (!ts()) return;
    const k = cellAt(e);
    if (k === st.hover) return;
    st.hover = k;
    if (st.painting) paintCell(k, 0);
    draw();
    status();
  }
  const onUp = () => { st.painting = false; };

  function zoom(dir) {
    const k = ZOOM.indexOf(st.zoom);
    st.zoom = ZOOM[clamp((k < 0 ? 2 : k) + dir, 0, ZOOM.length - 1)];
    draw();
  }
  function onKey(e) {
    if (e.target.closest('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = ts();
    if (!t) return;
    if (e.key === '[' || e.key === ']') { st.tile = (st.tile + (e.key === ']' ? 1 : t.tiles.length - 1)) % t.tiles.length; refresh(); update(); }
    else if (e.key === '+') zoom(1);
    else if (e.key === '-') zoom(-1);
    else return;
    e.preventDefault();
  }

  // --- views -------------------------------------------------------------------------

  const section = (title, action, ...content) => uiSection(title, content, action, 'tiles.collapsed');

  function sideView() {
    const t = ts(), l = look(), mc = multicolor();
    const places = screensOf(store.game);
    return [
      section('§0854', null,
        t ? h('div', { style: { marginBottom: '14px' } }, select({ label: '§0461', value: tilesetCharset(st.key) ?? '', dense: true,
          options: charsetOptions(charsetKeys(tilesetCharset(st.key))), onchange: v => setCharset(v || '') })) : '',
        dom(ui.picker),
        h('div', { style: { marginTop: '10px' } }, colorChooser([
          { label: '§0637', color: mc ? mcCellColor(st.color) : st.color, count: mc ? 'mc' : video().cells === 'vic' ? 'cell' : 16, active: true,
            tip: mc ? '§1396' : '§1397', onpick: v => { st.color = mc ? mcCell(v) : v; update(); drawPicker(); } },
        ])),
        h('div', { class: 'section__hint', style: { margin: '10px 0 0' } }, '§1398')),
      section('§1399', null,
        select({ label: '§1418', value: l.place?.id ?? '', dense: true,
          options: [{ value: '', label: '§1400' }, ...places.map(r => ({ value: r.id, label: r.name + (placesUsing(st.key).includes(r) ? ' •' : '') }))],
          onchange: v => { st.placeId = v || null; lookKey = null; refresh(); update(); } }),
        h('div', { class: 'section__hint', style: { margin: '8px 0 0' } },
          t ? tr('§1401', t.tiles.length, t.size, placesUsing(st.key).map(r => r.name).join(', ') || '—') : '')),
    ];
  }

  function barView() {
    if (!store.game) return null;
    const keys = knownKeys();
    return h('div', { class: 'screen-bar' },
      h('span', { class: 'md-title-medium' }, '§1402'),
      h('span', { class: 'screen-bar__sep' }),
      select({ label: '§1373', hideLabel: true, value: st.key ?? '', dense: true, cls: 'screen-bar__sprite',
        options: keys.length ? keys.map(k => ({ value: k, label: k + (isTilesetDirty(k) ? ' •' : '') })) : [{ value: '', label: '§1403' }],
        onchange: v => { st.key = v || null; st.tile = 0; lookKey = null; render(); } }),
      iconButton('add', '§1384', () => newTileset()),
      ts() ? [h('span', { class: 'screen-bar__sep' }), defaultTools({
        undo: () => travel(undo, redo), redo: () => travel(redo, undo), zoom,
        grid: { on: st.grid, toggle: () => { st.grid = !st.grid; update(); draw(); } },
        multicolor: !hasMulticolor() ? undefined : { on: multicolor(), toggle: toggleMode },
        clear: { tip: '§1404', run: clearTile },
      }), h('span', { class: 'screen-bar__sep' }),
      iconButton('add', '§1405', () => addTile()),
      iconButton('content_copy', '§1406', () => addTile(true)),
      iconButton('delete', '§1407', removeTile)] : '',
      h('div', { class: 'app-bar__spacer' }));
  }

  const StatusLine = () => h('span', { class: 'md-body-small screen-status' }, statusLine.value);

  function bodyView() {
    if (!store.game) return null;
    const t = ts();
    if (!t) {
      const broken = st.key && tilesetState(st.key) === 'error';
      return h('div', { class: 'empty-state' }, icon('grid_view'),
        h('div', { class: 'md-title-medium' }, broken ? tilesetError(st.key) : '§1408'),
        h('div', { class: 'md-body-medium' }, '§1409'),
        button('§1384', { icon: 'add', variant: 'filled', onclick: () => newTileset() }));
    }
    return [
      h('div', { class: 'screen-body' },
        h('div', { class: 'chars-main' },
          h('div', { class: 'chars-row' }, h('div', { class: 'chars-block' }, dom(ui.wrap))),
          h('div', { class: 'screen-foot' }, h(StatusLine, {}))),
        sidePanel('Tiles', sideView())),
      h('div', { class: 'asset-grid' },
        h('div', { class: 'asset-grid__bar' }, h('span', { class: 'md-body-small' }, '§1410')),
        dom(ui.list)),
    ];
  }

  function islands() {
    if (ui) return;
    const canvas = dh('canvas', { class: 'chars-canvas tiles-canvas',
      onpointerdown: onDown, onpointermove: onMove, onpointerup: onUp, onpointercancel: onUp,
      onpointerleave: () => { st.hover = null; draw(); status(); },
      oncontextmenu: e => e.preventDefault() });
    const wrap = dh('div', { class: 'chars-wrap', tabindex: 0, onkeydown: onKey }, canvas);
    wheelZoom(wrap, () => ui?.canvas, zoom);   // the wheel zooms
    const picker = dh('canvas', { class: 'code-picker tiles-picker' });
    picker.addEventListener('pointerdown', pickDown);
    picker.addEventListener('pointermove', pickMove);
    picker.addEventListener('pointerup', pickUp);
    picker.addEventListener('pointercancel', () => { st.drag = null; drawPicker(); });
    ui = { canvas, wrap, picker, list: dh('div', { class: 'asset-grid__items' }) };
  }

  function render() {
    if (store.game) {
      if (!st.key) st.key = knownKeys()[0] ?? null;
      islands();
    }
    views ??= [mount(bar, barView), mount(el, bodyView)];
    update();
    if (store.game) actions.route?.();
    if (!store.game || !ts()) return;
    st.tile = clamp(st.tile, 0, ts().tiles.length - 1);
    refresh();
  }

  // the places painted with a tileset follow its tiles - also after an undo of the story, which
  // may bring back chars of tiles that changed since (store.derive: no undo step of its own)
  const sync = () => { if (store.game) store.derive(game => syncTiles(game), { source: 'tiles' }); };
  onTilesetChange(() => { sync(); updateSave(); if (!el.hidden) refresh(); });
  onCharsetChange(() => { lookKey = null; if (!el.hidden && ui) refresh(); });

  store.on((type, detail) => {
    if (type === 'load') { st.key = null; st.placeId = null; st.tile = 0; undo.clear(); redo.clear(); lookKey = null; refreshFiles(); }
    if (type === 'change' && (detail.source === 'undo' || detail.source === 'replace')) queueMicrotask(sync);
    if (el.hidden) return;
    if (type === 'load') render();
    else if (type === 'change' && detail.source !== 'tiles') { lookKey = null; render(); }
  });

  // what a reload keeps (uistate.js): the tile edited, the brush, the zoom, the place of the preview
  const KEEP = ['tile', 'code', 'color', 'zoom', 'grid'];
  keepUi('tiles', {
    save: () => ({ ...pickUi(st, KEEP), place: st.placeId ? store.node(st.placeId)?.name ?? null : null }),
    load(s) {
      putUi(st, s, KEEP);
      st.placeId = (s.place && screensOf(store.game).find(p => p.name === s.place)?.id) || null;
      lookKey = null;
      if (!el.hidden) render();
    },
  });

  return {
    importFormats,
    exportFormats,
    current: () => st.key,                       // the tileset open: its path in the project
    selectKey(key) { if (key !== st.key) { st.key = key; st.tile = 0; } },
    select(file, placeId) {
      st.placeId = placeId ?? null;
      if (file) { st.key = tilesetKey(file); st.tile = 0; }
      lookKey = null;
    },
    open() {
      refreshFiles();
      render();
      ui?.wrap.focus({ preventScroll: true });
    },
    cancel: () => false,
    undo: () => travel(undo, redo),
    redo: () => travel(redo, undo),
    isDirty: () => dirtyTilesets().length > 0,
    async saveChanges() { for (const key of dirtyTilesets()) saveTileset(key); return true; },
    render,
  };
}
