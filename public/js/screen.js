// screen.js - PETSCII screen editor for place backgrounds and patches
//
// Maps store PETSCII glyphs (C64 Pro Mono code points) plus a color map with one
// hex digit per cell. A brush is a screen code and a color; the editor draws with
// the real C64 font. Places can be 40-120 columns wide; the camera preview shows
// the 40 column window soft scrolling like the engine does. In a game of tiles ('screens tiles')
// the background of a place is painted with the tiles of its tileset (tileset.js): a stroke
// puts the tile of the brush into every tile cell it touches; layers stay of chars.

import { walkRoute, walkArea, clampToArea } from './walkarea.js';
import { symbols, newId, getAttr, screensOf, placeRows, maxPlaceCols, PLACE_COLS, MAX_PLACE_COLS, COLOR_NAMES, DEFAULT_ANIM_SPEED, MAX_BEHIND } from './adv.js';
import { charsetKey, scriptRelative, scriptDirectory, setCharsetBytes, saveCharset } from './chr.js';
import { parseCtm, ctmScreen, CTM_MODES } from './padfiles.js';
import { LAYOUT } from './layout.js';
import { createPixelPainter } from './screenpaint.js';
import { listBinaries } from './project.js';
import { t, tr } from './i18n.js';
import { numValue, placeWidth, uniqueName, setObjAttr, renameSymbol } from './advgen.js';
import {
  PALETTE, constMap, placeInfo, drawMap, drawCell, romCharset, drawOverlays, patchCells, objectRect, objectsInPlace, moveLayered, colorIndex,
  drawPlace, cellColors,
} from './c64.js';
import { placeToFile, scrPath, gfxDir, decodeScreen, mapToLines, canvasPath } from './gfxfile.js';
import { pngOf, exportName, importName } from './export.js';
import { attachObjectDrag, nudgeObject } from './objdrag.js';
import { petsciiChar, colorDigit, legacyMaps, ROM_ORDER, ROM_POS } from './petscii.js';
import {
  h, dh, dom, mount, signal, useRef, useLayoutEffect, icon, iconButton, button, field, select, checkbox, chipSelect, snackbar, dialog,
  section as uiSection, sidePanel,
  confirmRemove,
} from './pui.js';
import { sizePicker } from './sizes.js';
import { NO_TILE, tilesetData, tilesetByKey, tilesetKey, knownTilesets, newTilemap, fitTilemap, tileCells, expandTiles, tilesetCharset, bindCharset } from './tileset.js';
import { speedSlider } from './animui.js';
import { colorChooser } from './colorchooser.js';
import { regionOp, rectBetween, clipRect } from './gridops.js';
import { tools, DRAW, RANGE, rangeForKey, DRAG_TOOLS, BRUSH_TOOLS, defaultBrush, brushCells, brushMax, brushTools, radiusMax, radiusTools, defaultTools, toolForKey, lineCells as lineXY, dragCells as dragXY } from './drawtools.js';
import { paintArea, dragMods, dragTo, curveWaits, followCurve, modeButton, wheelZoom, outlineCells } from './drawtools.js';
import { keepUi, pick as pickUi, put as putUi } from './uistate.js';
import { video, videoMachine, colorMask, colorValue, mcCell, mcCellColor, mcNames, pickerColors, startColors, hasMulticolor } from './video.js';
import { platformOf } from './platforms.js';
import { textCode, machineFont } from './romfonts.js';

// the tools of the screen (drawtools.js): object, layer, select, draw, color only and text, and on
// a place with actors - not a map or a closeup - its walk area and behind areas
// nerdsuite: no objects, walk areas or behind areas - a screen is a picture of chars, its layers
const TOOLS = ['layer', 'select', ...DRAW, 'paint', 'text'];
const TIPS = { erase: 'erases', pick: '§0736',
  more: { pick: ' - drag over the screen to grab a brush with its colors; B grabs a selected range' } };
const toolsOf = rm => tools(rm?.canvas?.dirart ? TOOLS.filter(t => t !== 'layer') : TOOLS, TIPS);   // the directory art has no layers
// the range tools of the screen: no invert, X reverses the brush
const RANGE_KEYS = RANGE.filter(k => k !== 'invert' && k !== 'rotate');
// the tools that draw with the square or round brush of the bar (drawtools.js): color only too
const SHAPE_TOOLS = new Set([...BRUSH_TOOLS, 'paint']);
const hex2 = n => '$' + n.toString(16).padStart(2, '0');

export function createScreenEditor(el, store, actions, bar) {
  const st = {
    placeId: null, layer: 'background', tool: 'pencil', code: 160, color: 14, cell: 20,
    shape: defaultBrush(),                // the square or round brush of the bar, in cells (drawtools.js)
    grid: true, overlays: true, camera: true, camPx: 0, playing: false, playDir: 1,
    caret: null, hover: null, drag: null, recent: [],
    selObj: null, hoverObj: null, createRect: null,
    animPlaying: false, animTick: 0,      // char and patch animations in the preview
    openAnim: null,                       // the id of the layer animation selected in the side panel
    animEdit: false,
    condAnim: null,                       // the layer animation whose 'On condition' was checked before it has a condition                      // its panel is open under the bar of the layer animations
    layerEdit: false,
    objEdit: false,                       // the panel of the selected object is open under the bar of the objects
    renaming: null,                       // the id of the layer whose name is edited in its row                     // the panel of the selected layer is open under the bar of the layers
    ecmBg: 0,                             // extended color mode: the background of the brush, 0-3 ($d021-$d024)
    tile: { w: 1, h: 1 },                 // the brush is W x H chars: code, code + 1 ... row by row
    grab: null,                           // or cells grabbed from the screen: {w, h, cells: [{code, color}]} row by row
    sel: null,                            // the range selected on the map: {x, y, w, h} in cells
    hiddenLayers: new Set(),              // ids of the patches the editor does not show
    charsetFiles: null,                   // charset files of the project (project.js), null until listed
    tileNo: 0,                            // a game of tiles: the tile the background is painted with
    radius: 0,                            // the corners of the box tool: rounded with this radius (drawtools.js: radiusTools)
    pixels: false,                        // the pixel mode (screenpaint.js): pixels are painted, the charset gets the chars
    pen: 'color',                         // its pen: the cell color, or 'mc1', 'mc2' - a shared color of a multicolor place
    hoverPx: null,                        // the pixel under the pointer in pixel mode
  };
  let animTimer = 0;
  let ui = null;              // what the editor draws on, made once (islands), and the resolved cells of the place
  let views = null;           // the mounted bar and body (pui.mount)
  const update = () => { views?.forEach(v => v.update()); if (ui?.info) drawPicker(); };
  const statusLine = signal('');
  let base = null;            // offscreen canvas with the map at editor zoom
  let camBase = null;         // offscreen canvas with the map for the camera preview
  let stroke = 0;

  // --- model access ----------------------------------------------------------------

  const place = () => store.node(st.placeId);
  const rowsOf = () => placeRows(place(), store.game);      // 24 in a fullscreen place, 19 with the verb coin
  const consts = () => constMap(store.game);
  const charset = () => place()?.canvas?.charset ?? symbols(store.game).charset;   // the directory art: its own
  // the directory art of a .d64 (dirart): a file name has no reverse chars - only the first 128
  const dirartOn = () => !!place()?.canvas?.dirart;
  const patch = () => (st.layer === 'background' ? null : place()?.members.find(m => m.kind === 'patch' && m.id === st.layer));

  function patchRect(p) {
    const c = consts();
    const lines = [...p.lines];
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return { col: numValue(p.col, c) ?? 0, row: numValue(p.row, c) ?? 0,
             w: Math.max(0, ...lines.map(l => l.length)), h: lines.length };
  }

  // screen code and color of a cell in the current layer
  function cellValue(c, r) {
    if (rebuildFrame) rebuild();
    const L = ui.cells;
    const x = c - L.col, y = r - L.row;
    if (x < 0 || y < 0 || x >= L.width || y >= L.height) return { code: 32, color: ui.info.textcolor };
    const k = y * L.width + x;
    return { code: L.chars[k], color: L.colors[k] };
  }

  // write one cell into a map node (lines + colors), padding as needed
  function put(node, x, y, code, color, keepChar) {
    if (dirartOn()) code &= 0x7f;                 // the directory art: no reverse chars
    const space = petsciiChar(32, charset());
    node.colors ??= node.lines.map(l => '.'.repeat(l.length));
    while (node.lines.length <= y) node.lines.push('');
    while (node.colors.length <= y) node.colors.push('');
    const line = node.lines[y].padEnd(x + 1, space);
    node.lines[y] = keepChar ? line : line.slice(0, x) + petsciiChar(code, charset()) + line.slice(x + 1);
    const cl = node.colors[y].padEnd(x + 1, '.');
    node.colors[y] = cl.slice(0, x) + colorDigit(color) + cl.slice(x + 1);
  }

  // a game of tiles: the background of the place is painted with tiles, the layers with chars
  // a screen with a tileset is painted with its tiles (its background; a layer with chars)
  const tiling = () => !!place() && !!getAttr(place(), 'tiles') && !patch() && !dirartOn();
  const placeTileset = () => { const f = place() && getAttr(place(), 'tiles'); return f ? tilesetData(f) : null; };

  // the tile cells the cells touch get the tile of the brush (erased: tile 0), and their chars
  // the chars of the tile
  function paintTiles(cells, key) {
    const ts = placeTileset(), rm = place();
    if (!ts) { snackbar('§1415', { error: true }); return; }
    const width = placeWidth(rm, consts()), rows = rowsOf(), n = ts.size;
    const t = cells.some(x => x.erase) || st.tileNo >= ts.tiles.length ? 0 : st.tileNo;
    const touched = new Map();
    for (const x of cells) if (x.c >= 0 && x.r >= 0 && x.c < width && x.r < rows) touched.set(`${Math.floor(x.c / n)},${Math.floor(x.r / n)}`, [Math.floor(x.c / n), Math.floor(x.r / n)]);
    const out = [];
    store.mutate(() => {
      const bg = tileBackground(rm, ts, width, rows);
      for (const [tx, ty] of touched.values()) {
        bg.tiles.cells[ty * bg.tiles.w + tx] = t;
        out.push(...tileCells(ts, t, tx * n, ty * n, width, rows));
      }
      for (const x of out) put(bg, x.c, x.r, x.code, x.color);
    }, { key, source: 'screen' });
    if (paintCells(out)) drawSoon(); else rebuildSoon();
  }

  // the background of a place painted with tiles of ts: its map fits the place, a cell without a
  // tile takes tile 0 - a game of tiles has no chars of their own in a place
  function tileBackground(rm, ts, width, rows) {
    let bg = rm.members.find(m => m.kind === 'background');
    if (!bg) {
      bg = { id: newId(), kind: 'background', lines: [], colors: [] };
      rm.members.splice(rm.members.reduce((a, m, k) => (m.kind === 'attr' ? k + 1 : a), 0), 0, bg);
    }
    const fresh = !bg.tiles || bg.tiles.size !== ts.size;
    bg.tiles = fresh ? newTilemap(ts.size, width, rows) : fitTilemap(bg.tiles, width, rows);
    bg.tiles = { ...bg.tiles, cells: bg.tiles.cells.map(c => (c === NO_TILE || c >= ts.tiles.length ? 0 : c)) };
    expandTiles(bg, bg.tiles, ts, width, rows, charset());
    return bg;
  }

  // the tileset of the place (a project path, '' none): the map is made anew when its tiles
  // have another size; the place takes the charset of the tileset
  function setPlaceTiles(key) {
    const rm = place(), ts = key ? tilesetByKey(key) : null;
    store.mutate(() => {
      const i = rm.members.findIndex(m => m.kind === 'attr' && m.key === 'tiles');
      if (!key) {
        if (i >= 0) rm.members.splice(i, 1);
        const bg = rm.members.find(m => m.kind === 'background');
        if (bg) delete bg.tiles;
        return;
      }
      if (i >= 0) rm.members[i].str = scriptRelative(key);
      else rm.members.splice(rm.members.reduce((a, m, k) => (m.kind === 'attr' ? k + 1 : a), 0), 0, { id: newId(), kind: 'attr', key: 'tiles', str: scriptRelative(key) });
      if (ts) { bindCharset(rm, tilesetCharset(key, ts)); tileBackground(rm, ts, placeWidth(rm, consts()), rowsOf()); }
    }, { source: 'structure' });
    setTile(0);
  }

  // the tile of the brush: it shows where the pointer is (st.grab)
  function setTile(k) {
    const ts = placeTileset();
    st.tileNo = k;
    const tile = ts?.tiles[k];
    st.grab = tile ? { w: ts.size, h: ts.size, cells: tile.chars.map((code, j) => ({ code, color: tile.colors[j] })) } : null;
    update();
    draw();
  }

  // the side panel of a game of tiles: the tileset of the place and its tiles - while the background
  // is painted with them a matrix in place of the section of the chars, the charset is the one of
  // the tileset - a click picks one; the colors of the place below them
  const tileBrush = () => tiling() && !!placeTileset();
  // how the tiles of n x n chars cover the place: its tile map, and how much of the last column
  // and the last row of tiles it shows
  function tileFit(n) {
    const width = ui.info.width, rows = rowsOf(), w = Math.ceil(width / n), hh = Math.ceil(rows / n);
    const cut = [width % n ? tr('§1422', width % n, n) : '', rows % n ? tr('§1423', rows % n, n) : ''].filter(Boolean);
    return tr('§1421', width, rows, w, hh, n) + (cut.length ? ' ' + cut.join(' ') : '');
  }
  function tilesSection() {
    const rm = place(), file = getAttr(rm, 'tiles'), ts = placeTileset(), info = ui.info;
    const current = file ? tilesetKey(file) : '';
    const keys = [...new Set([...listBinaries().filter(f => /\.til$/i.test(f)), ...knownTilesets(), ...(current ? [current] : [])])].sort();
    const px = 2, size = ts ? ts.size * 8 * px : 0;
    const cols = ts?.size === 2 ? 8 : 6, cell = 288 / cols;   // as wide as the char matrix
    const drawTile = (cv, tile) => {
      if (!cv) return;
      const ctx = cv.getContext('2d');
      tile.chars.forEach((code, j) => drawCell(ctx, code, (j % ts.size) * 8 * px, Math.floor(j / ts.size) * 8 * px, 8 * px, tile.colors[j],
        info.bg, info.charset, info.chr, info.multicolor, info.ecm));
    };
    return section('§1402', [iconButton('grid_view', '§1413', () => actions.openTiles(file, st.placeId))],
      h('div', { style: { marginBottom: '10px' } }, select({ label: '§1373', value: current, dense: true,
        options: [{ value: '', label: '§1414' }, ...keys.map(k => ({ value: k, label: k }))], onchange: setPlaceTiles })),
      ts ? h('div', { class: 'tile-palette tile-palette--matrix', style: { gridTemplateColumns: `repeat(${cols}, ${cell}px)` } }, ts.tiles.map((tile, k) => h('div', {
        class: `asset-cell asset-cell--tile${k === st.tileNo ? ' asset-cell--selected' : ''}`, 'data-tip': tr('§1393', k),
        onclick: () => setTile(k) }, h('canvas', { width: size, height: size, style: { width: `${cell}px`, height: `${cell}px` }, ref: cv => drawTile(cv, tile) }))))
        : h('div', { class: 'section__hint' }, current ? tr('§1417', current) : '§1415'),
      ts && tileBrush() ? [
        h('div', { class: 'section__hint', style: { margin: '10px 0 0' } }, tileFit(ts.size)),
        h('div', { class: 'section__hint', style: { margin: '10px 0 0' } }, tr('§1420', tilesetCharset(current, ts) ?? romName(info))),
        h('div', { style: { marginTop: '10px' } }, placeColors(info, false)),
      ] : '',
      h('div', { class: 'section__hint', style: { margin: '10px 0 0' } }, '§1416'));
  }

  // cells: {c, r, code, color, keepChar}; one undo step per stroke
  function paint(cells, key = 'paint:' + stroke, brush = true) {
    if (!cells.length) return;
    if (tiling()) return paintTiles(cells, key);
    const rm = place();
    const width = placeWidth(rm, consts());
    store.mutate(() => {
      const p = patch();
      if (p) {
        let pr = patchRect(p);
        const minC = Math.min(pr.col, ...cells.map(x => x.c)), minR = Math.min(pr.row, ...cells.map(x => x.r));
        if (minC < pr.col || minR < pr.row) {
          const padC = pr.col - minC, padR = pr.row - minR;
          const space = petsciiChar(32, charset());
          const colors = p.colors ?? p.lines.map(l => '.'.repeat(l.length));
          p.lines = [...Array(padR).fill(''), ...p.lines].map(l => space.repeat(padC) + l);
          p.colors = [...Array(padR).fill(''), ...colors].map(l => '.'.repeat(padC) + l);
          p.col = String(minC);
          p.row = String(minR);
          pr = patchRect(p);
        }
        for (const x of cells) put(p, x.c - pr.col, x.r - pr.row, x.code, x.color, x.keepChar);
      } else {
        let bg = rm.members.find(m => m.kind === 'background');
        if (!bg) {
          bg = { id: newId(), kind: 'background', lines: [], colors: [] };
          const at = rm.members.reduce((a, m, k) => (m.kind === 'attr' ? k + 1 : a), 0);
          rm.members.splice(at, 0, bg);
        }
        for (const x of cells) if (x.c < width && x.r < rowsOf()) put(bg, x.c, x.r, x.code, x.color, x.keepChar);
      }
    }, { key, source: 'screen' });
    if (brush && !st.grab) remember(st.code, st.color);
    if (paintCells(cells)) drawSoon(); else rebuildSoon();
  }

  function remember(code, color) {
    const k = st.recent.findIndex(b => b.code === code && b.color === color);
    if (k === 0) return;
    if (k > 0) st.recent.splice(k, 1);
    st.recent.unshift({ code, color });
    st.recent.length = Math.min(st.recent.length, 16);
    update();
  }

  // --- tools -------------------------------------------------------------------------

  // the cells {c, r} of a line, from the shared Bresenham (drawtools.js)
  const lineCells = (a, b) => lineXY(cellXY(a), cellXY(b)).map(p => ({ c: p.x, r: p.y }));

  // The square or round brush of the bar: the cells it covers along cells {c, r}, inside the place.
  // Bigger than one cell it fills what it covers with the brush of chars (st.tile, st.grab), the
  // tile repeating from where the stroke began; of one cell a stroke stamps the whole tile
  const shapeGrid = () => ({ w: ui.info.width, h: rowsOf() });
  const shaped = () => SHAPE_TOOLS.has(st.tool) && Math.min(st.shape.size, brushMax(shapeGrid())) > 1;
  const shapeCells = cells => (SHAPE_TOOLS.has(st.tool) ? brushCells(cells.map(cellXY), st.shape, shapeGrid()).map(p => ({ c: p.x, r: p.y })) : cells);

  // a game of tiles: the tools draw on the tile cells of the place, each one the whole tile of the
  // brush - a tile cell {c, r} stands for the chars of its top left (paintTiles takes the tile
  // cells the chars touch)
  const tileN = () => (tiling() ? placeTileset()?.size ?? 0 : 0);
  const toTile = (x, n) => ({ c: Math.floor(x.c / n), r: Math.floor(x.r / n) });
  const fromTile = (x, n) => ({ c: x.c * n, r: x.r * n });
  const tileGrid = n => ({ w: Math.ceil(ui.info.width / n), h: Math.ceil(rowsOf() / n) });
  const uniqueTiles = (cells, n) => [...new Map(cells.map(x => toTile(x, n)).map(t => [`${t.c},${t.r}`, t])).values()];
  // the shaped brush on tile cells: its size counts tiles
  function shapeTiles(tiles, n) {
    if (!SHAPE_TOOLS.has(st.tool)) return tiles;
    return brushCells(tiles.map(cellXY), st.shape, tileGrid(n)).map(p => ({ c: p.x, r: p.y }));
  }
  // the line of the pencil from cell a to b on tile cells (a's tile is painted already)
  const tileLine = (a, b, n) => lineXY(cellXY(toTile(a, n)), cellXY(toTile(b, n))).slice(1).map(p => fromTile({ c: p.x, r: p.y }, n));
  // the tile cells of the tile number under cell start, 4-connected: the fill of a game of tiles
  function floodTiles(start, n, tile) {
    const map = place().members.find(m => m.kind === 'background')?.tiles, g = tileGrid(n), s = toTile(start, n);
    const at = (c, r) => (map && c < map.w && r < map.h ? map.cells[r * map.w + c] : NO_TILE);
    const t = at(s.c, s.r), seen = new Set(), out = [], stack = [s];
    if (t === tile) return [];
    while (stack.length) {
      const { c, r } = stack.pop();
      if (c < 0 || r < 0 || c >= g.w || r >= g.h || seen.has(r * g.w + c) || at(c, r) !== t) continue;
      seen.add(r * g.w + c);
      out.push(fromTile({ c, r }, n));
      stack.push({ c: c + 1, r }, { c: c - 1, r }, { c, r: r + 1 }, { c, r: r - 1 });
    }
    return out;
  }
  // the chars the tiles of tile cells (their top left chars) show: what a drag shows before it paints
  function tilePreview(cells, erase) {
    const ts = placeTileset(), n = tileN();
    if (!ts || !n) return [];
    const t = erase || st.tileNo >= ts.tiles.length ? 0 : st.tileNo;
    return uniqueTiles(cells, n).flatMap(x => tileCells(ts, t, x.c * n, x.r * n, ui.info.width, rowsOf()));
  }

  // the cells the line, box, circle or curve tool draws for drag d, inside the place - in a game
  // of tiles the tile cells
  const dragTool = () => DRAG_TOOLS.has(st.tool);
  function dragCells(d) {
    const n = tileN();
    if (n) {
      const T = x => cellXY(toTile(x, n)), g = tileGrid(n);
      const tiles = dragXY(st.tool, T(d.start), T(d.end), { ...d, radius: st.radius, bend: d.bend && { x: d.bend.c / n, y: d.bend.r / n } })
        .map(p => ({ c: p.x, r: p.y })).filter(x => x.c >= 0 && x.r >= 0 && x.c < g.w && x.r < g.h);
      return shapeTiles(tiles, n).map(x => fromTile(x, n));
    }
    const cells = dragXY(st.tool, cellXY(d.start), cellXY(d.end), { ...d, radius: st.radius, bend: d.bend && cellXY(d.bend) }).map(p => ({ c: p.x, r: p.y }));
    return shapeCells(cells.filter(x => x.c >= 0 && x.r >= 0 && x.c < ui.info.width && x.r < rowsOf()));
  }

  function floodCells(start, code, color) {
    const width = ui.info.width;
    const t = cellValue(start.c, start.r);
    if (t.code === code && t.color === color) return [];
    const seen = new Set(), cells = [], stack = [start];
    while (stack.length) {
      const { c, r } = stack.pop();
      const k = r * MAX_PLACE_COLS + c;
      if (c < 0 || r < 0 || c >= width || r >= rowsOf() || seen.has(k)) continue;
      const v = cellValue(c, r);
      if (v.code !== t.code || v.color !== t.color) continue;
      seen.add(k);
      cells.push({ c, r });
      stack.push({ c: c + 1, r }, { c: c - 1, r }, { c, r: r + 1 }, { c, r: r - 1 });
    }
    return cells;
  }

  const brushed = (cells, b) => cells.map(x => ({ ...x, ...b }));

  // a brush of W x H chars (st.tile), or the cells grabbed from the screen (st.grab): the code
  // and color dc columns and dr rows into it. Erasing takes the size of the brush only
  const mod = (v, n) => ((v % n) + n) % n;
  const tileW = () => st.grab?.w ?? st.tile.w, tileH = () => st.grab?.h ?? st.tile.h;
  function tileAt(b, dc, dr) {
    const w = tileW(), k = mod(dr, tileH()) * w + mod(dc, w);
    if (b.erase) return { code: 32, color: b.color };
    if (st.grab) return st.grab.cells[k];
    if (ecmOn()) return { code: (b.code & 0xc0) | ((b.code + k) & 63), color: b.color };   // chars 0-63, one background
    return { code: (b.code + k) & 255, color: b.color };
  }

  // extended color mode: the place shows chars 0-63, bits 6-7 of a screen code pick its background
  const ecmOn = () => !!ui?.info?.ecm;
  const ecmCode = code => (code & 63) | (st.ecmBg << 6);
  // the k-th char of the brush tile: codes count up, in extended color mode within 0-63
  const nthCode = k => (ecmOn() ? (st.code & 0xc0) | ((st.code + k) & 63) : (st.code + k) & 255);

  // the whole brush with its top left on a cell - in a game of tiles on the tile cell of it
  function stamp(cell, b) {
    const n = tiling() ? placeTileset()?.size : 0;
    if (n) cell = { c: cell.c - (cell.c % n), r: cell.r - (cell.r % n) };
    const out = [];
    for (let dr = 0; dr < tileH(); dr++) {
      for (let dc = 0; dc < tileW(); dc++) out.push({ c: cell.c + dc, r: cell.r + dr, ...b, ...tileAt(b, dc, dr) });
    }
    return out.filter(x => x.c < ui.info.width && x.r < rowsOf());
  }

  // cells of a rectangle or line with the tile repeating from origin
  const patterned = (cells, origin, b) => cells.map(x => ({ ...x, ...b, ...tileAt(b, x.c - origin.c, x.r - origin.r) }));

  // what a stroke of the pencil or color only paints on cells: with the shaped brush what it
  // covers, the tile repeating from where the stroke began; else the whole tile on every cell, over
  // the stamps before it. d: the stroke, { start, code, color, keepChar, erase }
  function strokeCells(cells, d) {
    const b = { code: d.code, color: d.color, keepChar: d.keepChar, erase: d.erase }, n = tileN();
    if (n) return shapeTiles(uniqueTiles(cells, n), n).map(x => ({ ...fromTile(x, n), ...b }));
    return shaped() ? patterned(shapeCells(cells), d.start, b) : cells.flatMap(x => stamp(x, b));
  }

  // the cells of range r (cells {x, y, w, h}) become the brush, with their colors
  function grabBrush(r) {
    const cells = [];
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) cells.push(cellValue(x, y));
    st.grab = { w: r.w, h: r.h, cells };
    snackbar(tr('§0838', r.w, r.h));
    draw();
    update();
  }
  const originOf = d => ({ c: Math.min(d.start.c, d.end.c), r: Math.min(d.start.r, d.end.r) });

  // --- drawing -----------------------------------------------------------------------

  // a stroke changes the place with every cell the pointer crosses: it is drawn once per frame
  let rebuildFrame = 0;
  function rebuildSoon() {
    if (!rebuildFrame) rebuildFrame = requestAnimationFrame(rebuild);
  }

  function rebuild() {
    cancelAnimationFrame(rebuildFrame);
    rebuildFrame = 0;
    const rm = place();
    if (!rm || !ui) return;
    if (dirartOn()) st.code &= 0x7f;              // the directory art: no reverse brush
    const info = placeInfo(store.game, rm);
    const s = st.cell;
    base ??= document.createElement('canvas');
    base.width = info.width * s;
    base.height = rowsOf() * s;
    const bctx = base.getContext('2d');
    const view = animView(rm, info);
    // the background, the layers the editor shows in their order, then the patches the
    // animations show; the layer painted on is drawn on top of them
    const p = patch();
    const paintLayers = (ctx, size, withSelected) => {
      drawMap(ctx, info, view.chars, info.colors, info.width, rowsOf(), 0, 0, size);
      for (const lp of layersOf(rm)) {
        if (st.hiddenLayers.has(lp.id) || (lp === p && !withSelected)) continue;
        const pc = patchCells(store.game, lp, rm, info), pr = patchRect(lp);
        drawMap(ctx, info, pc.chars, pc.colors, pc.width, pc.height, pr.col, pr.row, size);
      }
      for (const ap of view.patches) drawMap(ctx, info, ap.chars, ap.colors, ap.width, ap.height, ap.col, ap.row, size);
    };
    paintLayers(bctx, s, false);
    ui.cells = { chars: info.chars, colors: info.colors, width: info.width, height: rowsOf(), col: 0, row: 0 };
    if (p) {
      const pc = patchCells(store.game, p, rm, info);
      const pr = patchRect(p);
      drawMap(bctx, info, pc.chars, pc.colors, pc.width, pc.height, pr.col, pr.row, s);
      ui.cells = { ...pc, col: pr.col, row: pr.row };
    }
    camBase ??= document.createElement('canvas');
    camBase.width = info.width * 16;
    camBase.height = rowsOf() * 16;
    paintLayers(camBase.getContext('2d'), 16, true);
    // what is drawn over the cells painted on: in the editor the layer painted on is on top, in
    // the camera it keeps its place among the layers (a hidden one is not in the pictures)
    const shown = layersOf(rm).filter(lp => !st.hiddenLayers.has(lp.id));
    const rects = list => list.map(lp => patchRect(lp));
    const after = p ? shown.slice(shown.indexOf(p) + 1) : shown;
    ui.cover = p && st.hiddenLayers.has(p.id) ? null
      : { base: p ? [] : rects(shown), cam: rects(after), animated: view.patches.length > 0 };
    ui.info = info;
    drawSoon.now();
  }

  // the canvas and the camera show the pictures (base, camBase) once per frame; the status line
  // follows them
  let drawFrame = 0;
  function drawSoon() {
    if (!drawFrame) drawFrame = requestAnimationFrame(drawSoon.now);
  }
  drawSoon.now = () => {
    cancelAnimationFrame(drawFrame);
    drawFrame = 0;
    draw();
    drawCamera();
    if (statusAfter) { const { cell } = statusAfter; statusAfter = null; status(cell); }
  };

  // the cells a stroke painted, drawn into the pictures as they are now - without decoding and
  // drawing the whole place again. False when that is needed: a layer grew, an animation plays
  function paintCells(cells) {
    const L = ui?.cells, info = ui?.info, cover = ui?.cover;
    if (rebuildFrame || !L || !cover || cover.animated || !base || !camBase) return false;
    const p = patch();
    if (p) {
      const pr = patchRect(p);
      if (pr.col !== L.col || pr.row !== L.row || pr.w !== L.width || pr.h !== L.height) return false;
    }
    const inside = (list, c, r) => list.some(q => c >= q.col && c < q.col + q.w && r >= q.row && r < q.row + q.h);
    const s = st.cell, bctx = base.getContext('2d'), cctx = camBase.getContext('2d');
    for (const x of cells) {
      const cx = x.c - L.col, cy = x.r - L.row;
      if (cx < 0 || cy < 0 || cx >= L.width || cy >= L.height) continue;
      const k = cy * L.width + cx;
      if (!x.keepChar) L.chars[k] = x.code;
      L.colors[k] = x.color;
      const draw = (ctx, size) => drawCell(ctx, L.chars[k], x.c * size, x.r * size, size, L.colors[k], info.bg, info.charset, info.chr, info.multicolor, info.ecm);
      if (!inside(cover.base, x.c, x.r)) draw(bctx, s);
      if (!inside(cover.cam, x.c, x.r)) draw(cctx, 16);
    }
    return true;
  }

  function draw() {
    if (!ui?.info) return;
    const { canvas, info } = ui;
    const s = st.cell;
    // a new size allocates the canvas anew; else reset it: cleared, with the default state
    if (canvas.width !== base.width || canvas.height !== base.height) { canvas.width = base.width; canvas.height = base.height; }
    const ctx = canvas.getContext('2d');
    if (ctx.reset) ctx.reset(); else canvas.width = base.width;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(base, 0, 0);

    if (st.grid && s >= 10) {
      ctx.strokeStyle = 'rgba(255,255,255,.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = 1; c < info.width; c++) { ctx.moveTo(c * s + .5, 0); ctx.lineTo(c * s + .5, canvas.height); }
      for (let r = 1; r < rowsOf(); r++) { ctx.moveTo(0, r * s + .5); ctx.lineTo(canvas.width, r * s + .5); }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,.3)';
      ctx.beginPath();
      for (let c = PLACE_COLS; c < info.width; c += PLACE_COLS) { ctx.moveTo(c * s + .5, 0); ctx.lineTo(c * s + .5, canvas.height); }
      ctx.stroke();
    }
    const tn = tileN();
    if (st.grid && tn) {                            // the tile cells, the last ones cut at the edge of the place
      ctx.strokeStyle = 'rgba(255, 213, 79, .35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = tn; c < info.width; c += tn) { ctx.moveTo(c * s + .5, 0); ctx.lineTo(c * s + .5, rowsOf() * s); }
      for (let r = tn; r < rowsOf(); r += tn) { ctx.moveTo(0, r * s + .5); ctx.lineTo(info.width * s, r * s + .5); }
      ctx.stroke();
    }
    if (st.tool === 'object') {
      drawOverlays(ctx, store.game, place(), info, s, { selected: st.selObj, hover: st.hoverObj, handles: true, preview: st.createRect, base });
    } else if (st.overlays || st.tool === 'walkbox' || polyKind(st.tool)) {
      drawOverlays(ctx, store.game, place(), info, s, { walkbox: false, zones: false, base,
        behindSel: st.tool === 'behind' ? st.behindHover : null, blockSel: st.blockHover });
    }
    if (st.tool === 'walkbox' && !place()._noActors) drawWalkTool(ctx);
    if (polyKind(st.tool) && !place()._noActors) drawPolyTool(ctx, polyKind(st.tool));
    const p = patch();
    if (p) {
      const pr = patchRect(p);
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#ffd54f';
      ctx.lineWidth = 2;
      ctx.strokeRect(pr.col * s + 1, pr.row * s + 1, pr.w * s - 2, pr.h * s - 2);
      ctx.setLineDash([]);
    }
    if (st.camera && info.width > PLACE_COLS && !place().canvas) {
      const x = st.camPx * s / 8;
      ctx.strokeStyle = 'rgba(255, 213, 79, .95)';
      ctx.lineWidth = 3;
      ctx.strokeRect(x + 1.5, 1.5, PLACE_COLS * s - 3, rowsOf() * s - 3);
      ctx.fillStyle = 'rgba(255, 213, 79, .95)';
      ctx.font = '500 12px Roboto, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('camera', x + 6, 4);
    }
    if (st.drag && dragTool() && !st.drag.px) {
      const cells = dragCells(st.drag);
      ctx.globalAlpha = 0.85;
      for (const x of tileN() ? tilePreview(cells, st.drag.erase) : patterned(cells, originOf(st.drag), st.drag)) {
        drawCell(ctx, x.code, x.c * s, x.r * s, s, shownColor(x.code, x.color), info.bg, info.charset, info.chr, info.multicolor, info.ecm);
      }
      ctx.globalAlpha = 1;
    }
    const range = st.drag && (st.tool === 'select' || st.tool === 'pick') ? rectBetween(cellXY(st.drag.start), cellXY(st.drag.end)) : st.sel;
    if (range) {
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#00e5ff';
      ctx.lineWidth = 2;
      ctx.strokeRect(range.x * s + 1, range.y * s + 1, range.w * s - 2, range.h * s - 2);
      ctx.setLineDash([]);
    }
    if (st.drag?.start && st.tool === 'walkbox') {  // the walkbox being dragged
      const r = rectBetween(cellXY(st.drag.start), cellXY(st.drag.end));
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = 'rgba(0, 255, 200, .9)';
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x * s + 1, r.y * s + 1, r.w * s - 2, r.h * s - 2);
      ctx.setLineDash([]);
    }
    if (st.drag?.startAt && polyKind(st.tool)) {  // the rectangle of a new behind or block area being dragged, pixel by pixel
      const [a, b] = [st.drag.startAt, st.drag.endAt].map(walkPx);
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = `rgba(${polyKind(st.tool).color}, .9)`;
      ctx.lineWidth = 2;
      ctx.strokeRect(Math.min(a[0], b[0]) + .5, Math.min(a[1], b[1]) + .5, Math.abs(b[0] - a[0]) - 1, Math.abs(b[1] - a[1]) - 1);
      ctx.setLineDash([]);
    }
    if (st.hover && !st.pixels) {          // the brush's size where it paints
      const big = ['pencil', 'paint'].includes(st.tool) && !shaped();
      if (shaped() && !st.drag) {           // what the shaped brush covers
        ctx.fillStyle = 'rgba(255, 255, 255, .25)';
        shapeCells([st.hover]).forEach(q => ctx.fillRect(q.c * s, q.r * s, s, s));
      }
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      const n = tiling() ? placeTileset()?.size : null;
      if (n) {                                      // the tile cell, cut at the edge of the place
        const c0 = st.hover.c - st.hover.c % n, r0 = st.hover.r - st.hover.r % n;
        ctx.strokeRect(c0 * s + 1, r0 * s + 1, (Math.min(c0 + n, info.width) - c0) * s - 2, (Math.min(r0 + n, rowsOf()) - r0) * s - 2);
      }
      else if (shaped()) outlineCells(ctx, shapeCells([st.hover]).map(q => ({ x: q.c, y: q.r })), s, s);   // the shaped brush: its outline
      else ctx.strokeRect(st.hover.c * s + 1, st.hover.r * s + 1, (big ? tileW() : 1) * s - 2, (big ? tileH() : 1) * s - 2);
    }
    if (st.tool === 'text' && st.caret) {
      ctx.fillStyle = (Date.now() / 500 | 0) % 2 ? 'rgba(255,255,255,.9)' : 'rgba(255,255,255,.35)';
      ctx.fillRect(st.caret.c * s, (st.caret.r + 1) * s - 3, s, 3);
    }
    painter.overlay(ctx, s);
  }

  function drawCamera() {
    if (!ui?.cam || !ui.info) return;
    const { cam, info } = ui;
    const maxPx = (info.width - PLACE_COLS) * 8;
    st.camPx = Math.max(0, Math.min(maxPx, st.camPx));
    cam.width = PLACE_COLS * 16;
    cam.height = rowsOf() * 16;
    const ctx = cam.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(camBase, st.camPx * 2, 0, cam.width, cam.height, 0, 0, cam.width, cam.height);
    if (info.width > PLACE_COLS) {
      // 38 column mode hides 7 pixels left and 9 pixels right under the border
      ctx.fillStyle = PALETTE[info.border];
      ctx.fillRect(0, 0, 14, cam.height);
      ctx.fillRect(cam.width - 18, 0, 18, cam.height);
    }
    const col = Math.ceil(st.camPx / 8), xs = col * 8 - st.camPx;
    ui.camStatus.textContent = t(info.width > PLACE_COLS                  // written here, not by h(): translated here
      ? tr('§0739', st.camPx, col, xs)
      : '§0740');
    ui.slider.max = maxPx;
    ui.slider.value = st.camPx;
    ui.slider.disabled = maxPx === 0;
  }

  let raf = 0;
  function tick() {
    raf = 0;
    if (!ui || !el.isConnected || el.hidden) { st.playing = false; return; }
    if (st.playing) {
      const maxPx = (ui.info.width - PLACE_COLS) * 8;
      st.camPx += st.playDir * 2;
      if (st.camPx >= maxPx) { st.camPx = maxPx; st.playDir = -1; }
      if (st.camPx <= 0) { st.camPx = 0; st.playDir = 1; }
      drawCamera();
    }
    draw();
    if (st.playing || st.tool === 'text') raf = requestAnimationFrame(tick);
  }
  const animate = () => { if (!raf) raf = requestAnimationFrame(tick); };

  // --- input -------------------------------------------------------------------------

  // the cell under the pointer, the nearest one of the place outside it; free: the cell outside as well
  function cellAt(e, free = false) {
    const r = ui.canvas.getBoundingClientRect();
    const c = Math.floor((e.clientX - r.left) / r.width * ui.info.width);
    const row = Math.floor((e.clientY - r.top) / r.height * rowsOf());
    if (free) return { c, r: row };
    return { c: Math.max(0, Math.min(ui.info.width - 1, c)), r: Math.max(0, Math.min(rowsOf() - 1, row)) };
  }

  let statusAfter = null;       // {cell}: the status line waits for the redraw of a stroke
  function status(cell) {
    if (rebuildFrame || drawFrame) { statusAfter = { cell }; return; }
    if (!cell) { statusLine.value = ''; return; }
    if (st.pixels) { statusLine.value = painter.status(); return; }
    const v = cellValue(cell.c, cell.r);
    statusLine.value = tr('§0741', cell.c, cell.r, v.code, hex2(v.code), COLOR_NAMES[v.color], v.color) +
      ` · walk x ${cell.c * 4}-${cell.c * 4 + 3}, y ${(cell.r + 1) * 8}-${(cell.r + 2) * 8 - 1}` +
      (st.sel ? ` · range ${st.sel.w} × ${st.sel.h}` : '');
  }

  function onDown(e) {
    if (!place()) return;
    e.preventDefault();
    ui.canvas.setPointerCapture(e.pointerId);
    ui.wrap.focus({ preventScroll: true });
    if (painter.onDown(e)) return;
    const cell = cellAt(e);
    if (st.drag?.bend) { dragTo(st.drag, cellAt(e, true), e); draw(); return; }   // the second stroke of a curve
    const erase = e.button === 2;
    // the right button of the object and the layer tool lets go of what is selected
    if (erase && (st.tool === 'object' || st.tool === 'layer')) { deselectAll(); return; }
    const b = erase ? { code: 32, color: ui.info.textcolor, erase: true } : { code: st.code, color: st.color };
    stroke++;
    switch (st.tool) {
      case 'pencil': st.drag = { start: cell, last: cell, ...b }; paint(strokeCells([cell], st.drag)); break;
      case 'paint': st.drag = { start: cell, last: cell, ...b, keepChar: !erase }; paint(strokeCells([cell], st.drag)); break;
      case 'line': case 'rect': case 'circle': case 'curve':
        st.drag = { start: cell, end: cell, ...b, ...dragMods(e) }; draw(); break;
      case 'fill': paint(brushed(tileN() ? floodTiles(cell, tileN(), erase ? 0 : st.tileNo) : floodCells(cell, b.code, b.color), b)); break;
      case 'pick': st.drag = { start: cell, end: cell }; draw(); break;   // a click picks a char, a drag grabs a brush
      case 'text': st.caret = { ...cell, startCol: cell.c }; animate(); break;
      case 'select': st.drag = { start: cell, end: cell }; draw(); break;
      case 'walkbox': {                   // the walk area: its corners and edges, else a box
        if (place()._noActors) break;
        if (e.altKey) { routeClick(walkAt(e)); break; }
        const hit = walkHit(e), pts = walkCorners();
        if (erase) {                      // the right button deletes a corner
          if (hit?.corner != null && pts.length > 3) { pts.splice(hit.corner, 1); setWalkarea(pts); update(); }
          break;
        }
        if (hit?.corner != null) st.drag = { corner: hit.corner, click: [e.clientX, e.clientY] };   // a click without a drag deletes it
        else if (hit?.edge != null) {
          pts.splice(hit.edge + 1, 0, walkAt(e));
          setWalkarea(pts, 'walkarea:' + stroke);
          st.drag = { corner: hit.edge + 1 };
        } else { st.drag = { start: cell, end: cell }; draw(); }
        break;
      }
      case 'behind': case 'block': {      // the polygons: their corners and edges, a drag inside moves one, else a new one
        if (place()._noActors) break;
        const P = polyKind(st.tool), hit = polyHit(e, P), polys = P.get(), key = `${st.tool}:${stroke}`;
        if (erase) {                      // the right button deletes a corner, inside an area the area
          if (!hit) break;
          if (hit.corner != null && polys[hit.k].length > 3) { polys[hit.k].splice(hit.corner, 1); P.set(polys); }
          else P.remove(hit.k);
          st[P.hover] = -1;
          update();
          break;
        }
        if (hit?.corner != null) st.drag = { bk: hit.k, poly: st.tool, corner: hit.corner, key, click: [e.clientX, e.clientY] };
        else if (hit?.edge != null) {
          polys[hit.k].splice(hit.edge + 1, 0, behindAt(e));
          P.set(polys, key);
          st.drag = { bk: hit.k, poly: st.tool, corner: hit.edge + 1, key };
        } else if (hit) st.drag = { bk: hit.k, poly: st.tool, from: behindAt(e), orig: polys[hit.k], key };
        else st.drag = { startAt: behindAt(e), endAt: behindAt(e) };
        if (hit) st[P.hover] = hit.k;
        draw();
        break;
      }
      case 'layer': {                     // the object tool drags objects (objdrag.js)
        const target = layerAt(cell);
        if (!target) break;
        const pr = patchRect(target);
        if (target !== patch()) { st.layer = target.id; rebuild(); update(); }
        st.drag = { start: cell, id: target.id, col: pr.col, row: pr.row, w: pr.w, h: pr.h };
        break;
      }
    }
  }

  function onMove(e) {
    if (!ui?.info) return;
    const cell = cellAt(e);
    if (st.pixels) { st.hover = cell; if (painter.onMove(e)) return; }
    const changed = st.hover?.c !== cell.c || st.hover?.r !== cell.r;
    st.hover = cell;
    const d = st.drag;
    if (d && st.tool === 'curve') {       // beyond the place as well: dragCells clips the curve
      const at = cellAt(e, true), p = d.bend ?? d.end;
      if (at.c !== p.c || at.r !== p.r) dragTo(d, at, e);
      drawSoon();
      if (changed) status(cell);
      return;
    }
    if (st.tool === 'layer' && !d && changed) ui.canvas.style.cursor = layerAt(cell) ? 'move' : 'default';
    if (d && st.tool === 'layer') {
      if (changed) { moveLayer(d, cell); status(cell); }
      return;
    }
    if (polyKind(st.tool) && !d) {            // the area under the pointer: its corners, its edges, its inside
      const P = polyKind(st.tool), hit = place()._noActors ? null : polyHit(e, P), k = hit ? hit.k : -1;
      ui.canvas.style.cursor = hit?.corner != null ? 'move' : hit?.edge != null ? 'copy' : hit ? 'grab' : 'crosshair';
      if (k !== st[P.hover]) { st[P.hover] = k; drawSoon(); }
    }
    if (d?.bk != null) {
      dragPoly(d, e);
      if (changed) status(cell);
      return;
    }
    if (d?.startAt && polyKind(st.tool)) {             // a new area: its rectangle follows the pointer
      const at = behindAt(e);
      if (at[0] !== d.endAt[0] || at[1] !== d.endAt[1]) { d.endAt = at; draw(); }
      return;
    }
    if (st.tool === 'walkbox' && !d) {    // the pointer over a corner or an edge of the walk area
      const hit = place()._noActors ? null : walkHit(e);
      ui.canvas.style.cursor = hit?.corner != null ? 'move' : hit?.edge != null ? 'copy' : 'crosshair';
    }
    if (d?.corner != null) {
      const pts = walkCorners(), p = walkAt(e);
      if (pts[d.corner][0] !== p[0] || pts[d.corner][1] !== p[1]) {
        pts[d.corner] = p;
        setWalkarea(pts, 'walkarea:' + stroke);
      }
      if (changed) status(cell);
      return;
    }
    if (d && (st.tool === 'pencil' || st.tool === 'paint') && changed) {
      // the brush moves cell by cell like the pointer (the cell it came from is painted already)
      paint(strokeCells(tileN() ? tileLine(d.last, cell, tileN()) : lineCells(d.last, cell).slice(1), d));
      d.last = cell;
      drawSoon();
    } else if (d && changed) {
      dragTo(d, cell, e);
      drawSoon();
    } else if (changed) drawSoon();
    if (changed) status(cell);
  }

  function onUp(e) {
    if (painter.onUp(e)) return;
    const d = st.drag;
    st.drag = null;
    // a click on a corner of the walk area or of a behind area - pressed and let go in place, not
    // dragged - deletes it; an area keeps 3 corners at least (one undo step with a slip of the drag)
    if (d?.click && e?.type === 'pointerup' && Math.hypot(e.clientX - d.click[0], e.clientY - d.click[1]) < 4) {
      if (d.bk != null) {
        const P = polyKind(d.poly), polys = P.get();
        if (polys[d.bk]?.length > 3) { polys[d.bk].splice(d.corner, 1); P.set(polys, d.key); }
        else snackbar('§0797');
        st[P.hover] = -1;
      } else {
        const pts = walkCorners();
        if (pts.length > 3) { pts.splice(d.corner, 1); setWalkarea(pts, 'walkarea:' + stroke); }
        else snackbar('§0798');
      }
      st.behindHover = -1;
      update();
      return;
    }
    if (d && curveWaits(st.tool, d)) { st.drag = d; draw(); return; }
    if (d && dragTool()) {
      const cells = dragCells(d);
      paint(patterned(cells, originOf(d), { code: d.code, color: d.color, erase: d.erase }));
    }
    if (d && st.tool === 'layer') update();
    if (d?.start && st.tool === 'walkbox') {   // a drag on empty space: a walk area of 4 corners
      const [x1, y1, x2, y2] = walkboxOf(d.start, d.end);
      setWalkarea([[x1, y1], [x2, y1], [x2, y2], [x1, y2]]);
      update();
    }
    if (d?.startAt && polyKind(st.tool)) {     // a new area: the rectangle of the drag, pixel by pixel
      const x1 = Math.min(d.startAt[0], d.endAt[0]), x2 = Math.max(d.startAt[0], d.endAt[0]);
      const y1 = Math.min(d.startAt[1], d.endAt[1]), y2 = Math.max(d.startAt[1], d.endAt[1]);
      if (x1 === x2 || y1 === y2) { draw(); return; }
      const P = polyKind(st.tool);
      P.set([...P.get(), [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]]);
      if (st.tool === 'behind' && ui.info.behind.length > MAX_BEHIND) {
        snackbar(tr('§0813', ui.info.behind.length, MAX_BEHIND), { error: true });
      }
      update();
    }
    if (d?.bk != null || d?.corner != null) update();
    if (d && st.tool === 'pick' && tiling()) {      // a game of tiles: the tile under the pointer
      const m = place().members.find(x => x.kind === 'background')?.tiles;
      const t = m?.cells[Math.floor(d.end.r / m.size) * m.w + Math.floor(d.end.c / m.size)];
      if (t != null && t !== NO_TILE) setTile(t);
      setTool('pencil');
    } else if (d && st.tool === 'pick') {
      if (d.start.c === d.end.c && d.start.r === d.end.r) { const v = cellValue(d.start.c, d.start.r); setBrush(v.code, v.color); }
      else grabBrush(rectBetween(cellXY(d.start), cellXY(d.end)));
      setTool('pencil');
    }
    if (d && st.tool === 'select') {        // a click selects that one cell (a layer of one cell can be made of it); a click on the one cell selected clears it, so does Esc
      const r = rectBetween(cellXY(d.start), cellXY(d.end)), s = st.sel;
      const again = r.w === 1 && r.h === 1 && s && s.x === r.x && s.y === r.y && s.w === 1 && s.h === 1;
      st.sel = again ? null : r;
      draw();
      status(d.end);
    }
  }

  function onKey(e) {
    if (e.target.closest('input, select, textarea')) return;
    const mod = e.ctrlKey || e.metaKey || e.altKey;
    if (st.tool === 'text' && st.caret && !mod) {
      const cr = st.caret;
      const width = ui.info.width;
      if (e.key.length === 1) {
        stroke++;
        const typed = textCode(e.key, charset());          // the code of the machine (romfonts.js)
        paint([{ c: cr.c, r: cr.r, code: ecmOn() ? ecmCode(typed) : typed, color: st.color }], 'type:' + cr.r);
        cr.c = Math.min(width - 1, cr.c + 1);
      } else if (e.key === 'Backspace') {
        cr.c = Math.max(0, cr.c - 1);
        paint([{ c: cr.c, r: cr.r, code: ecmOn() ? ecmCode(32) : 32, color: st.color }], 'type:' + cr.r);
      } else if (e.key === 'Enter') { cr.r = Math.min(rowsOf() - 1, cr.r + 1); cr.c = cr.startCol; }
      else if (e.key === 'ArrowLeft') cr.c = Math.max(0, cr.c - 1);
      else if (e.key === 'ArrowRight') cr.c = Math.min(width - 1, cr.c + 1);
      else if (e.key === 'ArrowUp') cr.r = Math.max(0, cr.r - 1);
      else if (e.key === 'ArrowDown') cr.r = Math.min(rowsOf() - 1, cr.r + 1);
      else if (e.key === 'Escape') { st.caret = null; setTool('pencil'); }
      else return;
      e.preventDefault();
      e.stopPropagation();
      draw();
      return;
    }
    const selected = st.tool === 'object' && st.selObj ? store.node(st.selObj) : null;
    if (selected && !mod) {
      const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (dir) {
        nudgeObject(store, place(), selected, dir[0], dir[1], e.shiftKey, 'screen');
        rebuild();                          // an object on a layer moves the layer
        update();
        e.preventDefault();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        actions.remove(selected.id, { before: () => { st.selObj = null; } });
        e.preventDefault();
        return;
      }
    }
    if (mod) return;
    const tool = toolForKey(toolsFor(place()), e.key.toLowerCase());
    if (tool) { setTool(tool); e.preventDefault(); }
    // the range keys only work on a selected range, so a key never shifts the whole place
    const op = rangeForKey(RANGE_KEYS, e);
    if (st.sel && op) { applyRange(op); e.preventDefault(); }
    if (e.key === 'Escape') { cancel(); e.preventDefault(); }
    if (st.sel && e.key.toLowerCase() === 'n') { layerFromRange(); e.preventDefault(); }
    if (st.sel && e.key.toLowerCase() === 'b') { grabBrush(st.sel); setTool('pencil'); e.preventDefault(); }
    if (e.key.toLowerCase() === 'x') {      // reverse video, of every char of a grabbed brush too
      if (st.grab) { st.grab = { ...st.grab, cells: st.grab.cells.map(v => ({ ...v, code: v.code ^ 0x80 })) }; update(); }
      else setBrush(st.code ^ 0x80, st.color);
    }
    if (e.key === '+') zoom(1);
    if (e.key === '-') zoom(-1);
  }

  const cellXY = cell => ({ x: cell.c, y: cell.r });

  // the range tools: the range selected with S, else the whole layer (the place, or the
  // patch). Shifting wraps inside the range; mirroring, flipping and rotating move the
  // cells, the characters keep their look. Only the cells that change are written.
  async function applyRange(op) {
    const info = ui?.info;
    if (!info) return;
    const p = patch(), pr = p && patchRect(p);
    if (op === 'clear' && !(await confirmRemove({ kind: 'clear:screen', verb: 'clear',
      what: st.sel ? tr('§1448', st.sel.w, st.sel.h) : p ? tr('§1449', p.name) : tr('§1450', place().name) }))) return;
    const area = st.sel ?? (p ? { x: pr.col, y: pr.row, w: pr.w, h: pr.h } : { x: 0, y: 0, w: info.width, h: rowsOf() });
    const grid = Array.from({ length: rowsOf() }, (_, r) => Array.from({ length: info.width }, (_, c) => cellValue(c, r)));
    const res = regionOp(grid, op, area, { blank: { code: 32, color: info.textcolor }, resize: !!st.sel });
    if (!res) return snackbar('§0742', { error: true });
    const cells = [];
    res.grid.forEach((row, r) => row.forEach((v, c) => {
      if (v.code !== grid[r][c].code || v.color !== grid[r][c].color) cells.push({ c, r, code: v.code, color: v.color });
    }));
    if (st.sel) st.sel = res.rect;
    stroke++;
    paint(cells, 'range:' + stroke, false);
    draw();
  }

  // --- state changes ---------------------------------------------------------------

  // Esc, and the right button of the object and the layer tool: no object, no layer - the
  // background is painted on -, no range and no route of the walk area tool
  // Escape: the curve being bent, the text caret, else everything selected (deselectAll)
  function cancel() {
    if (painter.cancel()) return true;
    if (st.drag?.bend) { st.drag = null; draw(); return true; }
    if (st.caret) { st.caret = null; setTool('pencil'); return true; }
    deselectAll();
    return true;
  }

  function deselectAll() {
    Object.assign(st, { selObj: null, hoverObj: null, createRect: null, sel: null, route: null, layerEdit: false, objEdit: false });
    if (st.layer !== 'background') { st.layer = 'background'; render(); return; }
    update();
    draw();
  }

  function setTool(tool) {
    if (st.drag?.bend) st.drag = null;
    st.tool = tool;
    if (tool !== 'text') st.caret = null;
    st.createRect = null;
    if (ui) { ui.canvas.style.cursor = ''; ui.canvas.title = ''; painter.cursor(); }
    draw();
    update();
  }

  // a char of the matrix, a recent brush or a picked char: the grabbed brush is let go
  function setBrush(code, color) {
    st.code = code & (dirartOn() ? 0x7f : 0xff);
    if (ecmOn()) st.ecmBg = st.code >> 6;       // a picked char brings its background along
    st.color = color & colorMask();
    st.grab = null;
    update();
  }

  // extended color mode: the background of the brush (0-3), of every char of a grabbed brush too
  function setEcmBg(k) {
    st.ecmBg = k;
    if (st.grab) st.grab = { ...st.grab, cells: st.grab.cells.map(v => ({ ...v, code: (v.code & 63) | (k << 6) })) };
    else st.code = ecmCode(st.code);
    update();
  }

  // the brush color: a grabbed brush takes it in all of its cells
  function setColor(color) {
    if (!st.grab) return setBrush(st.code, color);
    st.color = color & colorMask();
    st.grab = { ...st.grab, cells: st.grab.cells.map(v => ({ ...v, color: st.color })) };
    update();
  }

  // pixel mode zooms closer: up to 8 screen pixels a C64 pixel, the canvas scrolls in its box
  const zoomSteps = () => (st.pixels ? [8, 10, 12, 16, 20, 24, 32, 48, 64] : [8, 10, 12, 16, 20, 24, 32]);
  function zoom(dir) {
    const steps = zoomSteps();
    const k = steps.indexOf(st.cell);
    st.cell = steps[Math.max(0, Math.min(steps.length - 1, (k < 0 ? 4 : k) + dir))];
    rebuild();
  }

  // --- layers: the background and the patches of the place, in their order ------------

  const layersOf = rm => rm.members.filter(m => m.kind === 'patch');

  // the layer under a cell: the selected one, else the front one the editor shows
  function layerAt(cell) {
    const inside = p => {
      const r = patchRect(p);
      return cell.c >= r.col && cell.c < r.col + r.w && cell.r >= r.row && cell.r < r.row + r.h;
    };
    const sel = patch();
    if (sel && inside(sel)) return sel;
    return layersOf(place()).reverse().find(p => !st.hiddenLayers.has(p.id) && inside(p)) ?? null;
  }

  function selectLayer(id) {
    st.layer = id;
    render();
  }

  // a new layer in front of the others
  function insertLayer(p) {
    const rm = place();
    store.mutate(() => {
      const last = layersOf(rm).at(-1);
      const at = last ? rm.members.indexOf(last) + 1 : rm.members.findIndex(m => m.kind === 'enter' || m.kind === 'object');
      rm.members.splice(at >= 0 ? at : rm.members.length, 0, p);
    }, { source: 'screen' });
    st.hiddenLayers.delete(p.id);
    selectLayer(p.id);
  }

  // + of the layers: with a range selected the layer can be a copy of it (layerFromRange) - the
  // dialog asks; without one it is a new empty layer
  function newLayer() {
    if (!st.sel) return addPatch();
    dialog({ title: tr('§0756'), content: h('div', { class: 'md-body-medium' }, tr('§0783', st.sel.w, st.sel.h)),
      actions: [{ label: '§0006', value: null }, { label: '§0784', value: 'empty' }, { label: '§0785', value: 'range', variant: 'filled' }],
      onclose: v => { if (v === 'range') layerFromRange(); else if (v === 'empty') addPatch(); } });
  }

  function addPatch() {
    const rm = place();
    const g = petsciiChar(st.code, charset()), d = colorDigit(st.color);
    insertLayer({ id: newId(), kind: 'patch', blank: true, name: uniqueName(store.game, rm.name + '_patch', 'patch'),
      col: String(Math.ceil(st.camPx / 8)), row: '0', lines: [g.repeat(4), g.repeat(4)], colors: [d.repeat(4), d.repeat(4)] });
  }

  // a new layer of what the selected range shows in the current layer
  function layerFromRange() {
    const sel = st.sel;
    if (!sel) return snackbar('§0743');
    const lines = [], colors = [];
    for (let r = 0; r < sel.h; r++) {
      let l = '', c = '';
      for (let k = 0; k < sel.w; k++) {
        const v = cellValue(sel.x + k, sel.y + r);
        l += petsciiChar(v.code, charset());
        c += colorDigit(v.color);
      }
      lines.push(l);
      colors.push(c);
    }
    insertLayer({ id: newId(), kind: 'patch', blank: true, name: uniqueName(store.game, place().name + '_layer', 'patch'),
      col: String(sel.x), row: String(sel.y), lines, colors });
  }

  function duplicateLayer(p) {
    const copy = structuredClone(p);
    delete copy.src;
    delete copy.fp;
    insertLayer({ ...copy, id: newId(), blank: true, name: uniqueName(store.game, p.name, 'patch') });
  }

  // dir 1: one layer to the front, -1: one to the back
  function reorderLayer(p, dir) {
    const rm = place(), list = layersOf(rm), other = list[list.indexOf(p) + dir];
    if (!other) return;
    store.mutate(() => {
      const i = rm.members.indexOf(p), j = rm.members.indexOf(other);
      [rm.members[i], rm.members[j]] = [rm.members[j], rm.members[i]];
    }, { source: 'screen' });
    rebuild();
    update();
  }

  // the layer tool: the layer follows the mouse, inside the place; the own hotspot of its
  // object (at and size) goes along
  function moveLayer(d, cell) {
    const node = store.node(d.id);
    if (!node) return;
    const col = Math.max(0, Math.min(ui.info.width - d.w, d.col + cell.c - d.start.c));
    const row = Math.max(0, Math.min(rowsOf() - d.h, d.row + cell.r - d.start.r));
    if (String(col) === node.col && String(row) === node.row) return;
    const c = consts(), was = patchRect(node);
    const owners = linkedObjects(node).map(o => [o, objectRect(o, c, store.game)]).filter(([, r]) => r.own);
    store.mutate(() => {
      node.col = String(col);
      node.row = String(row);
      owners.forEach(([o, r]) => setObjAttr(o, 'at', [String(r.col + col - was.col), String(r.row + row - was.row)]));
    }, { key: 'move:' + d.id + ':' + stroke, source: 'screen' });
    rebuild();
  }

  // objects whose hotspot is layer p
  const linkedObjects = p => objectsInPlace(store.game, place()).filter(o => o.attrs.some(a => a.key === 'layer' && a.values.includes(p.name)));

  // link layer name to obj (on) or unlink it; an object without layers gets its own hotspot
  // where its layers were
  function linkLayer(obj, name, on = true) {
    const c = consts(), r = objectRect(obj, c, store.game);
    const names = obj.attrs.find(a => a.key === 'layer')?.values ?? [];
    const next = on ? [...new Set([...names, name])] : names.filter(n => n !== name);
    // a layer belongs to one object: another object that has it lets it go
    const others = on ? objectsInPlace(store.game, place()).filter(o => o !== obj && (o.attrs.find(a => a.key === 'layer')?.values ?? []).includes(name)) : [];
    const otherRects = others.map(o => objectRect(o, c, store.game));
    store.mutate(() => {
      others.forEach((o, k) => {
        const rest = o.attrs.find(a => a.key === 'layer').values.filter(n => n !== name);
        if (rest.length) { setObjAttr(o, 'layer', rest); return; }
        setObjAttr(o, 'layer', null);
        setObjAttr(o, 'at', [String(otherRects[k].col), String(otherRects[k].row)]);
        setObjAttr(o, 'size', [String(otherRects[k].w), String(otherRects[k].h)]);
      });
      if (next.length) {
        setObjAttr(obj, 'at', null);
        setObjAttr(obj, 'size', null);
        setObjAttr(obj, 'layer', next);
      } else {
        setObjAttr(obj, 'layer', null);
        setObjAttr(obj, 'at', [String(r.col), String(r.row)]);
        setObjAttr(obj, 'size', [String(r.w), String(r.h)]);
      }
    }, { source: 'screen' });
    update();
    draw();
  }

  // the object obj of rect r to col, row: all its layers move by the same distance
  function moveObjectLayers(obj, r, col, row) {
    const c = consts();
    store.mutate(() => moveLayered(obj, r, col - r.col, row - r.row, c), { source: 'screen' });
    rebuild();
  }

  // the object of layer p as a pill in one field - a layer belongs to one object (an object has any
  // number of layers): with a pill the field offers no more, without one its input offers the
  // objects of the place, those whose own hotspot is where the layer is first
  function layerObjectControls(p, linked) {
    const o = linked[0];
    const c = consts(), pr = patchRect(p);
    const samePlace = x => { const r = objectRect(x, c, store.game); return r.col === pr.col && r.row === pr.row && r.w === pr.w && r.h === pr.h; };
    const onLayers = x => objectRect(x, c, store.game).layers?.map(l => l.name).join(', ');
    const objs = objectsInPlace(store.game, place()).sort((a, b) => Number(samePlace(b)) - Number(samePlace(a)));
    const hint = x => (x === o ? '' : samePlace(x) ? tr('§1984') : onLayers(x) ? tr('§1985', onLayers(x)) : '').replace(/^ · /, '');
    return [h('div', { class: 'layer-object' },
      chipSelect({ label: '§0746', dense: true, placeholder: '§0747', values: o ? [o.id] : [], max: 1,
        options: objs.map(x => ({ value: x.id, label: tr('§1123', x.name, x.title), chip: x.name, hint: hint(x) || undefined })),
        onchange: next => {
          const added = objs.find(x => next.includes(x.id) && x !== o);
          if (added) linkLayer(added, p.name);
          else if (o && !next.includes(o.id)) linkLayer(o, p.name, false);
        } }))];
  }

  // the layers of the place, the front one on top and the background at the bottom: a click selects
  // one for painting, its arrows move it to the front or the back. Below them a bar edits, copies or
  // deletes the selected layer; edit opens its panel under the bar
  function layersSection() {
    const rm = place(), layers = [...layersOf(rm)].reverse(), sel = patch();
    const eye = p => {
      const shown = !st.hiddenLayers.has(p.id);
      return iconButton(shown ? 'visibility' : 'visibility_off', shown ? '§0749' : '§0750', () => {
        if (shown) st.hiddenLayers.add(p.id); else st.hiddenLayers.delete(p.id);
        rebuild();
        update();
      }, 'md-icon-button--sm');
    };
    // p: the layer (null for the background); its name is renamed in place - a double click or F2.
    // A click on the selected layer lets go of it: the background is painted on again
    const pick = id => selectLayer(id !== 'background' && sel?.id === id ? 'background' : id);
    const row = (id, lead, name, actions = [], p = null) => h('div', {
      class: `layer-row ${(sel?.id ?? 'background') === id ? 'layer-row--selected' : ''}`, role: 'button', tabindex: 0, 'data-layer': id,
      'aria-pressed': String((sel?.id ?? 'background') === id),
      onclick: e => { if (!e.target.closest('button, input') && e.detail < 2) pick(id); },   // the 2nd click of a double click renames
      onkeydown: e => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(id); }
        if (e.key === 'F2' && p) { e.preventDefault(); st.renaming = id; update(); }
      },
    }, lead, p && st.renaming === p.id ? h(LayerName, { layer: p })
      : h('span', { class: 'md-label-large layer-row__name', 'data-tip': p ? '§0815' : undefined,
        ondblclick: p ? () => { st.renaming = p.id; selectLayer(p.id); } : undefined }, name), ...actions);
    const entry = (p, k) => row(p.id, eye(p), p.name, [
      iconButton('arrow_upward', '§0751', () => reorderLayer(p, 1), 'md-icon-button--sm', { disabled: k === 0 }),
      iconButton('arrow_downward', '§0752', () => reorderLayer(p, -1), 'md-icon-button--sm', { disabled: k === layers.length - 1 }),
    ], p);
    const background = row('background', h('span', { class: 'layer-row__lead' }, icon('wallpaper', 'msr--sm')), 'background');
    const editing = st.layerEdit && sel;
    const bar = h('div', { class: 'layer-bar' },
      iconButton('edit', sel ? tr('§0818', sel.name) : '§0819', () => { st.layerEdit = !st.layerEdit; update(); },
        editing ? 'md-icon-button--selected' : '', { disabled: !sel, 'data-layer-action': 'edit', 'aria-pressed': String(!!editing) }),
      iconButton('content_copy', sel ? tr('§0820', sel.name) : '§0821', () => duplicateLayer(sel), '', { disabled: !sel, 'data-layer-action': 'copy' }),
      iconButton('delete', sel ? tr('§0822', sel.name) : '§0823', () => actions.remove(sel.id, { before: () => { st.layer = 'background'; st.layerEdit = false; } }),
        '', { disabled: !sel, 'data-layer-action': 'delete' }));
    return section('§0502', [iconButton('add', '§0782', newLayer, 'md-icon-button--sm')],
      h('div', { class: 'section__hint' }, '§0817'),
      h('div', { class: 'layer-list' }, layers.map(entry), background),
      bar,
      editing ? layerEditor(sel) : '');
  }

  // the name of a layer being renamed in its row: Enter or leaving the field renames it, Esc
  // keeps the name; a name that cannot be says why (Enter stays in the field, leaving it keeps the old one). The story follows: renameSymbol renames every use of the layer (draw steps,
  // layer animations, the objects on it) in the same undo step
  function LayerName({ layer }) {
    const input = useRef(null);
    useLayoutEffect(() => { input.current.focus(); input.current.select(); }, []);
    let done = false;
    const finish = (commit, leaving = false) => {
      if (done) return;
      const name = input.current.value.trim();
      const problem = commit && name !== layer.name ? nameProblem(layer, name) : null;
      if (problem) snackbar(problem, { error: true });
      if (problem && !leaving) { input.current.focus(); return; }
      if (problem) commit = false;
      done = true;
      st.renaming = null;
      if (commit && name !== layer.name) {
        const old = layer.name;
        store.mutate(g => renameSymbol(g, old, name, layer.kind), { source: 'structure' });
      }
      update();
      ui.wrap.focus({ preventScroll: true });
    };
    return h('input', { ref: input, class: 'md-label-large layer-row__input', value: layer.name, spellcheck: false, 'aria-label': tr('§0816', layer.name),
      onkeydown: e => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      },
      onblur: () => finish(true, true) });
  }

  // the panel of the selected layer, under the bar of the layers
  function layerEditor(p) {
    return h('div', { class: 'layer-edit' },
      h('div', { class: 'grid2' },
        field({ label: '§0753', value: p.col, dense: true, mono: true, onchange: v => editMember(p, x => { x.col = v.trim() || '0'; }) }),
        field({ label: '§0395', value: p.row, dense: true, mono: true, onchange: v => editMember(p, x => { x.row = v.trim() || '0'; }) })),
    );
  }

  // --- side panel ------------------------------------------------------------------

  // --- the layer animations of the place ----------------------------------------------

  const speedOf = v => numValue(v ?? String(DEFAULT_ANIM_SPEED), consts()) || DEFAULT_ANIM_SPEED;

  // what the animations show at st.animTick (50 ticks per second) while they play: the current
  // patch of each patch animation
  function animView(rm, info) {
    if (!st.animPlaying) return { chars: info.chars, patches: [] };
    const S = symbols(store.game);
    const patches = [];
    for (const a of rm.members.filter(m => m.kind === 'patchanim')) {
      const frames = a.frames.map(n => S.patches.find(p => p.name === n)).filter(Boolean);
      if (!frames.length) continue;
      const k = Math.floor(st.animTick / speedOf(a.speed));
      const p = frames[a.once ? Math.min(k, frames.length - 1) : k % frames.length];
      const pr = patchRect(p);
      patches.push({ ...patchCells(store.game, p, rm, info), col: pr.col, row: pr.row });
    }
    return { chars: info.chars, patches };
  }

  function playAnims() {
    clearInterval(animTimer);
    animTimer = 0;
    if (!st.animPlaying) return;
    animTimer = setInterval(() => {
      if (!ui || el.hidden || !el.isConnected || !st.animPlaying) { clearInterval(animTimer); animTimer = 0; return; }
      st.animTick++;
      if (st.animTick % 4 === 0) rebuild();
    }, 20);
  }

  // a change to a char or patch animation: key = typing into a field (no new side panel)
  function editMember(node, fn, key = null) {
    store.mutate(() => fn(node), { key, source: 'screen' });
    if (!key) update();
    rebuild();
  }

  function addMember(node) {
    const rm = place();
    store.mutate(() => {
      const at = rm.members.findIndex(m => m.kind === 'enter' || m.kind === 'object' || m.kind === 'place');
      rm.members.splice(at >= 0 ? at : rm.members.length, 0, node);
    }, { source: 'screen' });
    update();
    rebuild();
  }

  async function removeMember(node) {
    const rm = place();
    if (!(await confirmRemove({ what: tr('§1451', node.name), detail: tr('§1452', node.frames?.length ?? 0), kind: 'layer-anim' }))) return;
    st.openAnim = null;
    store.mutate(() => { rm.members.splice(rm.members.indexOf(node), 1); }, { source: 'screen' });
    snackbar(tr('§1986', node.name),
      { action: 'Undo', onaction: () => store.undo() });
    update();
    rebuild();
  }

  // the timing of an animation: dragging changes it, letting go shows the new speed
  const speedControl = node => speedSlider({ speed: node.speed, consts: consts(),
    oninput: v => editMember(node, x => { x.speed = v; }, `${node.id}:speed`),
    onchange: () => update() });


  // the layer animations of the place ('patchanim'): its layers drawn in turn. Like the layers: a click
  // selects one, a click on the selected one lets go of it, a double click on its name (or F2)
  // renames it; the bar below edits or deletes the selected one (no copy), edit opens its panel
  function layerAnimSection() {
    const rm = place();
    const anims = rm.members.filter(m => m.kind === 'patchanim');
    const patches = rm.members.filter(m => m.kind === 'patch');
    const sel = anims.find(a => a.id === st.openAnim) ?? null;
    const add = iconButton('add', '§0772', () => {
      if (!patches.length) return snackbar('§0840');
      const node = { id: newId(), kind: 'patchanim', name: uniqueName(store.game, rm.name + '_anim'), frames: patches.slice(0, 2).map(p => p.name), speed: null, auto: true };
      st.openAnim = node.id;
      addMember(node);
    }, 'md-icon-button--sm');
    const pick = a => { st.openAnim = st.openAnim === a.id ? null : a.id; update(); };
    const rename = a => { st.openAnim = a.id; st.renaming = a.id; update(); };
    const row = a => h('div', {
      class: `layer-row ${sel === a ? 'layer-row--selected' : ''}`, role: 'button', tabindex: 0, 'data-anim': a.id, 'aria-pressed': String(sel === a),
      onclick: e => { if (!e.target.closest('button, input') && e.detail < 2) pick(a); },   // the 2nd click of a double click renames
      onkeydown: e => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(a); }
        if (e.key === 'F2') { e.preventDefault(); rename(a); }
      },
    }, h('span', { class: 'layer-row__lead' }, icon('animation', 'msr--sm')),
    st.renaming === a.id ? h(LayerName, { layer: a })
      : h('span', { class: 'md-label-large layer-row__name', 'data-tip': '§0815', ondblclick: () => rename(a) }, a.name));
    const editing = st.animEdit && sel;
    // 'On condition' is checked while it has one, or since the checkbox was checked (the field is empty yet)
    const onCond = a => !!a.cond || st.condAnim === a.id;
    const bar = h('div', { class: 'layer-bar' },
      iconButton('edit', sel ? tr('§0786', sel.name) : '§0787', () => { st.animEdit = !st.animEdit; update(); },
        editing ? 'md-icon-button--selected' : '', { disabled: !sel, 'data-anim-action': 'edit', 'aria-pressed': String(!!editing) }),
      iconButton('delete', sel ? tr('§0788', sel.name) : '§0789', () => removeMember(sel),
        '', { disabled: !sel, 'data-anim-action': 'delete' }));
    return section('§0841', [add],
      h('div', { class: 'section__hint' }, '§0842'),
      anims.length ? [h('div', { class: 'layer-list' }, anims.map(row)), bar] : '',
      editing ? h('div', { class: 'layer-edit' },
        // the frames: the layers in turn, as chips in one field like the media of the game - the
        // input offers every layer (one may come more than once); a removed frame is asked for first
        chipSelect({ label: '§1108', values: sel.frames, min: 1, repeat: true, placeholder: '§0843', cls: 'anim-frames',
          options: patches.map(p => ({ value: p.name, label: p.name })),
          onchange: async next => {
            if (next.length < sel.frames.length) {
              const k = sel.frames.findIndex((p, i) => p !== next[i]);
              const gone = sel.frames[k < 0 ? sel.frames.length - 1 : k];
              if (!(await confirmRemove({ what: tr('§1453', gone, sel.name), kind: 'anim-frame', verb: 'remove' }))) return;
            }
            editMember(sel, x => { x.frames = [...next]; });
          } }),
        speedControl(sel),
        // how it plays: once or in a loop (one of them); when: on a condition ('if', the field
        // shows) or else from the entry into the place ('auto')
        h('div', { class: 'inline-actions' },
          checkbox('§0776', !!sel.once, on => editMember(sel, x => { if (on) x.once = true; else delete x.once; })),   // one of the two:
          checkbox('§0777', !sel.once, on => editMember(sel, x => { if (on) delete x.once; else x.once = true; })),     // unchecking one checks the other
          checkbox('§0778', onCond(sel), on => {
            st.condAnim = on ? sel.id : null;
            editMember(sel, x => { if (on) delete x.auto; else { delete x.cond; x.auto = true; } });
          })),
        onCond(sel) ? field({ label: '§0399', value: sel.cond ?? '', dense: true, mono: true, placeholder: 'lamp.state == 1',
          onchange: v => editMember(sel, x => { if (v.trim()) { x.cond = v.trim(); delete x.auto; } else delete x.cond; }) }) : '',
        h('div', { class: 'section__hint', style: { margin: '-4px 0 0' } }, onCond(sel)
          ? '§0781'
          : sel.auto ? '§0779'
            : '§0780')) : '');
  }

  // why n cannot be the new name of a layer, an object or a layer animation a, null when it can
  const nameProblem = (a, n) => (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? '§0404'
    : n !== a.name && uniqueName(store.game, n, a.kind === 'patch' ? 'patch' : 'symbol') !== n ? tr('§0121', n) : null);

  // the bitmaps the side panel draws chars with: the place's charset file, else the ROM characters
  const glyphs = info => info.chr ?? romCharset(info.charset);
  // the name of the ROM font: a Commodore's of its case set, another machine's (romfonts.js)
  const romName = info => (machineFont().kind === 'commodore' ? tr('§0852', info.charset) : 'ROM font');
  // the colour a char shows: on an Atari screen the one its code and the registers give (c64.js cellColors)
  const shownColor = (code, color) => (ui?.info?.atari ? cellColors(ui.info, [code], null)[0] : color);

  function Swatch({ code, color, size, bg }) {
    const cv = useRef(null);
    useLayoutEffect(() => {
      const ctx = cv.current.getContext('2d');
      const shown = shownColor(code, color);
      drawCell(ctx, code, 0, 0, size, shown, shown === bg && !ui.info.atari ? (shown ? 0 : 1) : bg, ui.info.charset, glyphs(ui.info), ui.info.multicolor, ui.info.ecm);
    });
    return h('canvas', { ref: cv, width: size, height: size, class: 'brush-swatch' });
  }
  const swatch = (code, color, size, bg = ui.info.bg) => h(Swatch, { code, color, size, bg });

  const recentView = () => h('div', { class: 'brushes' }, st.recent.map(b => h('button', {
    class: `brush ${b.code === st.code && b.color === st.color ? 'brush--selected' : ''}`, type: 'button',
    'data-tip': `${b.code} (${hex2(b.code)}) ${COLOR_NAMES[b.color]}`, onclick: () => setBrush(b.code, b.color),
  }, swatch(b.code, b.color, 24))), !st.recent.length ? h('span', { class: 'md-body-small' }, '§0844') : '');

  // the objects of the place, like the layers: opening an entry selects the object on the
  // screen (object tool) and shows what can be edited, closing it deselects it
  // the objects of the place, like the layers: a click selects one on the screen (object tool),
  // a click on the selected one lets go of it, a double click on its name (or F2) renames it.
  // The bar below edits or deletes the selected object; edit opens its panel under the bar
  function objectsSection() {
    const rm = place();
    const objs = objectsInPlace(store.game, rm);
    const sel = objs.find(o => o.id === st.selObj) ?? null;
    const pick = o => {
      st.selObj = st.selObj === o.id ? null : o.id;
      if (st.selObj && st.tool !== 'object') setTool('object');
      else { update(); draw(); }
    };
    const rename = o => { st.selObj = o.id; st.renaming = o.id; if (st.tool !== 'object') setTool('object'); else update(); };
    const row = o => h('div', {
      class: `layer-row ${sel === o ? 'layer-row--selected' : ''}`, role: 'button', tabindex: 0, 'data-object': o.id, 'aria-pressed': String(sel === o),
      onclick: e => { if (!e.target.closest('button, input') && e.detail < 2) pick(o); },   // the 2nd click of a double click renames
      onkeydown: e => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(o); }
        if (e.key === 'F2') { e.preventDefault(); rename(o); }
      },
    }, h('span', { class: 'layer-row__lead' }, icon('category', 'msr--sm')),
    st.renaming === o.id ? h(LayerName, { layer: o })
      : h('span', { class: 'md-label-large layer-row__name', 'data-tip': '§0815', ondblclick: () => rename(o) }, o.name));
    const editing = st.objEdit && sel;
    const bar = h('div', { class: 'layer-bar' },
      iconButton('edit', sel ? tr('§0790', sel.name) : '§0791', () => { st.objEdit = !st.objEdit; update(); },
        editing ? 'md-icon-button--selected' : '', { disabled: !sel, 'data-object-action': 'edit', 'aria-pressed': String(!!editing) }),
      iconButton('delete', sel ? tr('§0792', sel.name) : '§0793', () => actions.remove(sel.id, { before: () => { st.selObj = null; } }),
        '', { disabled: !sel, 'data-object-action': 'delete' }));
    return section('§0096', [iconButton('add', '§0828', () => {
          setTool('object');
          snackbar('§0829');
        }, 'md-icon-button--sm')],
      h('div', { class: 'section__hint' }, '§0964'),
      h('div', { class: 'layer-list' }, objs.map(row)),
      bar,
      editing ? h('div', { class: 'layer-edit' }, objectEditor(sel)) : '');
  }

  // the panel of the selected object, under the bar of the objects
  function objectEditor(obj) {
    const rm = place(), c = consts();
    const r = objectRect(obj, c, store.game);
    const width = placeWidth(rm, c);
    const set = (key, values) => {
      store.mutate(() => setObjAttr(obj, key, values), { key: `${obj.id}:${key}`, source: 'screen' });
      draw();
    };
    const num = (label, value, min, max, apply) => field({
      label, value: String(value), type: 'number', dense: true, mono: true,
      onchange: v => { apply(Math.max(min, Math.min(max, Math.round(Number(v)) || 0))); update(); },
    });
    const setSize = (w, hh) => store.mutate(() => {
      if (r.layer && !r.own) setObjAttr(obj, 'at', [String(r.col), String(r.row)]);
      setObjAttr(obj, 'size', [String(w), String(hh)]);
    }, { key: `${obj.id}:size`, source: 'screen' });
    const wt = obj.attrs.find(a => a.key === 'walkto')?.values;
    return [
      // the layers of the object as pills in one field; its input offers the free layers of the place
      chipSelect({ label: r.layers ? '§0846' : '§0847', dense: true, cls: 'object-layers', placeholder: '§0848',
        values: (r.layers ?? []).map(lp => lp.name),
        options: layersOf(rm).filter(p => (r.layers ?? []).includes(p) || !linkedObjects(p).length).map(p => ({ value: p.name, label: p.name })),
        onchange: next => {
          const names = (r.layers ?? []).map(lp => lp.name);
          const gone = names.find(n => !next.includes(n)), added = next.find(n => !names.includes(n));
          if (gone) linkLayer(obj, gone, false);
          if (added) linkLayer(obj, added);
        } }),
      // on layers Col and Row move the layers too; Width and Height give it a hotspot of its own
      h('div', { class: 'grid4' },
        num('Col', r.col, 0, width - r.w, n => (r.layer ? moveObjectLayers(obj, r, n, r.row) : set('at', [String(n), String(r.row)]))),
        num('§0395', r.row, 0, rowsOf() - r.h, n => (r.layer ? moveObjectLayers(obj, r, r.col, n) : set('at', [String(r.col), String(n)]))),
        num('§0397', r.w, 1, width - r.col, n => setSize(n, r.h)),
        num('§0531', r.h, 1, rowsOf() - r.row, n => setSize(r.w, n))),
      r.own && h('div', { class: 'inline-actions' },
        button('§0832', { icon: 'fit_screen', tip: '§0833',
          onclick: () => { store.mutate(() => { setObjAttr(obj, 'at', null); setObjAttr(obj, 'size', null); }, { source: 'screen' }); update(); draw(); } })),
      h('div', { class: 'grid2' },
        field({ label: '§0849', value: wt?.[0] ?? '', placeholder: 'auto', dense: true, mono: true,
          onchange: v => { set('walkto', v.trim() ? [v.trim(), wt?.[1] ?? '120'] : null); update(); } }),
        field({ label: '§0850', value: wt?.[1] ?? '', placeholder: 'auto', dense: true, mono: true,
          onchange: v => { set('walkto', v.trim() ? [wt?.[0] ?? String(r.col * 4), v.trim()] : null); update(); } })),
      checkbox('§0535', obj.attrs.some(a => a.key === 'pickable'), on => { set('pickable', on ? [] : null); update(); }),
      h('div', { class: 'section__hint', style: { margin: '-4px 0 0' } }, '§0851'),
    ];
  }

  // --- the charset of the screen: the ROM font of the game's case, or a charset file ------

  let listingCharsets = false;
  async function loadCharsetFiles() {
    if (listingCharsets) return;
    listingCharsets = true;
    st.charsetFiles = listBinaries().filter(f => /\.(chr|fnt|bin|raw)$/i.test(f));   // not the pictures of the bitmap editor
    update();
  }

  // key: the project path of a charset file, null for the ROM font (no 'charset')
  function setPlaceCharset(key) {
    const rm = place();
    store.mutate(() => {
      const i = rm.members.findIndex(m => m.kind === 'attr' && m.key === 'charset');
      if (!key) { if (i >= 0) rm.members.splice(i, 1); return; }
      if (i >= 0) { rm.members[i].str = scriptRelative(key); return; }
      let at = 0;
      rm.members.forEach((m, k) => { if (m.kind === 'attr') at = k + 1; });
      rm.members.splice(at, 0, { id: newId(), kind: 'attr', key: 'charset', str: scriptRelative(key) });
    }, { source: 'structure' });
  }

  function charsetSelect(info) {
    if (!st.charsetFiles) loadCharsetFiles();
    const current = info.chrFile ? charsetKey(info.chrFile) : '';
    const used = screensOf(store.game).map(r => getAttr(r, 'charset')).filter(Boolean).map(charsetKey);
    const keys = [...new Set([...(st.charsetFiles ?? []), ...used, ...(current ? [current] : [])])].sort();
    return h('div', { style: { marginBottom: '14px' } }, select({
      label: '§0461', value: current, dense: true,
      options: [{ value: '', label: romName(info) }, ...keys.map(k => ({ value: k, label: k }))],
      onchange: v => setPlaceCharset(v || null),
    }));
  }

  // a color setting of the place (bgcolor): the attribute with the name of color k
  function setPlaceColor(key, k) {
    const rm = place();
    store.mutate(() => {
      const m = rm.members.find(x => x.kind === 'attr' && x.key === key);
      if (m) { m.values = [colorValue(k, COLOR_NAMES)]; return; }
      let at = 0;
      rm.members.forEach((x, i) => { if (x.kind === 'attr') at = i + 1; });
      rm.members.splice(at, 0, { id: newId(), kind: 'attr', key, values: [colorValue(k, COLOR_NAMES)] });
    }, { source: 'structure' });
  }

  // the walkbox over the columns and rows of a drag, in walk units: 4 per column, the feet in
  // place row r at y = (r+1)*8
  function walkboxOf(a, b) {
    const c0 = Math.min(a.c, b.c), c1 = Math.max(a.c, b.c), r0 = Math.min(a.r, b.r), r1 = Math.max(a.r, b.r);
    return [c0 * 4, (r0 + 1) * 8, (c1 + 1) * 4 - 1, Math.min(199, (r1 + 2) * 8 - 1)].map(String);
  }

  // the side panel: whether the place has a walk area, and a button to remove it - its corners
  // are drawn and dragged on the screen with the tool (W)
  function walkSection(info) {
    const set = !!(info.walkPts || getAttr(place(), 'walkbox'));
    const error = info.walkPts && walkArea(info.walkPts).error;
    const remove = async () => {
      const rm = place();
      if (!(await confirmRemove({ what: tr('§1454', rm.name), detail: info.walkPts ? tr('§0801', walkCorners().length) : null, kind: 'walkarea', verb: 'remove' }))) return;
      store.mutate(() => {
        for (let i = rm.members.length - 1; i >= 0; i--) {
          const x = rm.members[i];
          if (x.kind === 'attr' && (x.key === 'walkarea' || x.key === 'walkbox')) rm.members.splice(i, 1);
        }
      }, { source: 'screen' });
      st.route = null;
      rebuild();
      update();
    };
    return section('§1246', [
      iconButton('delete', set ? '§0799' : '§0800', remove, '', { disabled: !set }),
    ],
      h('div', { class: 'walk-state' }, icon(set ? 'check_circle' : 'radio_button_unchecked'),
        h('span', {}, set ? tr('§0801', walkCorners().length) : '§0802')),
      error ? h('div', { class: 'banner banner--error', style: { marginTop: '8px' } }, icon('error'), h('span', {}, error)) : '',
      h('div', { class: 'section__hint', style: { margin: '8px 0 0' } },
        '§0803'));
  }

  // --- behind the scenery: 'behind_area pixels (X, Y) (X, Y) ...', a polygon each in the units of
  // the walk area - x in walk units, y the feet pixel row - drawn pixel by pixel like the walk area.
  // The cells whose middle is inside hide an actor whose feet are above the lowest corner of the
  // polygon, its base for all its strips (engine/depth.s, mask.s; behindRects in advgen.js) -------

  // the polygons, copies to change: the 'behind_area pixels' polygons, and the older polygons on
  // the cells and rectangles as such polygons (behindPolygons)
  const behindPolys = () => (ui.info.behindPolys ?? []).map(pts => pts.map(p => [...p]));

  // the polygons become the behind areas of the place, a 'behind_area pixels' line each; the
  // older forms give way to them. key: a drag, one undo step
  function setBehindPolys(polys, key = null) {
    const rm = place();
    store.mutate(() => {
      for (let i = rm.members.length - 1; i >= 0; i--) {
        const x = rm.members[i];
        if (x.kind === 'attr' && (x.key === 'behind' || x.key === 'behindpoly')) rm.members.splice(i, 1);
      }
      const have = rm.members.filter(x => x.kind === 'attr' && x.key === 'behindpx');
      polys.forEach((pts, k) => {
        const values = pts.flatMap(p => p.map(String));
        if (have[k]) { have[k].values = values; return; }
        let at = 0;
        rm.members.forEach((x, i) => { if (x.kind === 'attr') at = i + 1; });
        rm.members.splice(at, 0, { id: newId(), kind: 'attr', key: 'behindpx', values });
      });
      for (const x of have.slice(polys.length)) rm.members.splice(rm.members.indexOf(x), 1);
    }, { key, source: 'screen' });
    rebuild();
  }

  // the point under the pointer in walk units (x) and feet pixels (y), inside the place; Shift
  // puts it on the corners of the cells
  function behindAt(e) {
    const [cx, cy] = canvasXY(e);
    let x = Math.round(cx * 4 / st.cell), y = Math.round(cy * 8 / st.cell) + 8;
    if (e.shiftKey) { x = Math.round(x / 4) * 4; y = Math.round(y / 8) * 8; }
    return [Math.max(0, Math.min(ui.info.width * 4, x)), Math.max(8, Math.min((rowsOf() + 1) * 8, y))];
  }

  // the canvas pixels of a pointer event
  function canvasXY(e) {
    const r = ui.canvas.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width * ui.canvas.width, (e.clientY - r.top) / r.height * ui.canvas.height];
  }

  // the area of kind P (polyKind) under the pointer: { k, corner }, { k, edge } (the corner it starts
  // at) or { k } inside it, or null. The last one drawn first
  function polyHit(e, P) {
    const p = canvasXY(e), near = 7 * ui.canvas.width / ui.canvas.getBoundingClientRect().width;
    const polys = P.shown().map(pts => pts.map(walkPx));
    for (let k = polys.length - 1; k >= 0; k--) {
      const corner = polys[k].findIndex(q => Math.hypot(q[0] - p[0], q[1] - p[1]) <= near);
      if (corner >= 0) return { k, corner };
    }
    for (let k = polys.length - 1; k >= 0; k--) {
      const pts = polys[k];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length], dx = b[0] - a[0], dy = b[1] - a[1], len = dx * dx + dy * dy;
        const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
        if (Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]) <= near) return { k, edge: i };
      }
    }
    for (let k = polys.length - 1; k >= 0; k--) {
      let inside = false;
      const pts = polys[k];
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) return { k };
    }
    return null;
  }

  // a drag of an area: a corner to the point under the pointer, or the whole area along with it,
  // inside the place; one undo step per drag
  function dragPoly(d, e) {
    const P = polyKind(d.poly), polys = P.get(), at = behindAt(e);
    if (!polys[d.bk]) return;
    if (d.corner != null) {
      const q = polys[d.bk][d.corner];
      if (q[0] === at[0] && q[1] === at[1]) return;
      polys[d.bk][d.corner] = at;
    } else {
      const xs = d.orig.map(q => q[0]), ys = d.orig.map(q => q[1]);
      const dx = Math.max(-Math.min(...xs), Math.min(ui.info.width * 4 - Math.max(...xs), at[0] - d.from[0]));
      const dy = Math.max(8 - Math.min(...ys), Math.min((rowsOf() + 1) * 8 - Math.max(...ys), at[1] - d.from[1]));
      const moved = d.orig.map(([x, y]) => [x + dx, y + dy]);
      if (moved.every((q, i) => q[0] === polys[d.bk][i][0] && q[1] === polys[d.bk][i][1])) return;
      polys[d.bk] = moved;
    }
    P.set(polys, d.key);
  }

  // the corners of the areas of kind P (polyKind); the one under the pointer or dragged brighter
  function drawPolyTool(ctx, P) {
    const sel = st.drag?.bk ?? st[P.hover], hs = Math.max(6, st.cell / 3);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    P.shown().forEach((pts, k) => {
      ctx.fillStyle = k === sel ? `rgba(${P.color}, .95)` : `rgba(${P.color}, .6)`;
      for (const [x, y] of pts.map(walkPx)) {
        ctx.fillRect(x - hs / 2, y - hs / 2, hs, hs);
        ctx.strokeRect(x - hs / 2 + .5, y - hs / 2 + .5, hs - 1, hs - 1);
      }
    });
  }

  // the side panel: whether the place has behind areas, and a button to remove them - they are
  // drawn and changed on the screen with the tool (H)
  function behindSection(info) {
    const polys = info.behindPolys ?? [], n = polys.length, strips = info.behind?.length ?? 0;
    const remove = async () => {
      if (!(await confirmRemove({ what: n === 1 ? '§1455' : tr('§1456', n), kind: 'behind', verb: 'remove' }))) return;
      setBehindPolys([]); st.behindHover = -1; update();
    };
    const removeOne = async k => {
      if (!(await confirmRemove({ what: tr('§1457', k + 1), detail: tr('§0810', polys[k].length), kind: 'behind', verb: 'remove' }))) return;
      const all = behindPolys(); all.splice(k, 1); setBehindPolys(all); st.behindHover = -1; update();
    };
    const hover = k => { if (st.behindHover !== k) { st.behindHover = k; drawSoon(); } };
    return section('§0794', [
      iconButton('delete', !n ? '§0804' : n === 1 ? '§0805' : tr('§0806', n), remove, '', { disabled: !n }),
    ],
      h('div', { class: 'walk-state' }, icon(n ? 'check_circle' : 'radio_button_unchecked'),
        h('span', {}, !n ? '§0807' : n === 1 ? '§0808' : tr('§0809', n))),
      // the areas one by one: pointing at one shows it on the screen, its button removes it alone
      n ? h('div', { class: 'behind-list' }, polys.map((pts, k) => h('div', {
        class: 'behind-list__row', 'data-behind': k,
        onmouseenter: () => hover(k), onmouseleave: () => hover(-1),
      },
        h('span', { class: 'kv-table__index' }, String(k + 1)),
        h('span', { class: 'behind-list__text' }, tr('§0810', pts.length)),
        iconButton('delete', tr('§0811', k + 1), () => removeOne(k), 'md-icon-button--sm')))) : '',
      strips > MAX_BEHIND ? h('div', { class: 'banner banner--error', style: { marginTop: '8px' } }, icon('error'),
        h('span', {}, tr('§0812', strips, MAX_BEHIND))) : '',
      h('div', { class: 'section__hint', style: { margin: '8px 0 0' } },
        '§0814'));
  }

  // --- block areas: 'block_area (X, Y) (X, Y) ... [unless COND]', polygons in the units of the walk
  // area cut out of it - actors do not walk there, always or unless COND holds (walkarea.js) -------

  const blockMembers = () => place().members.filter(x => x.kind === 'attr' && x.key === 'blockarea');
  const blockPolys = () => (ui.info.blockPolys ?? []).map(pts => pts.map(p => [...p]));

  // the polygons become the block areas of the place, in their order: a member keeps its condition,
  // a new one is always blocked. key: a drag, one undo step
  function setBlockPolys(polys, key = null) {
    const rm = place();
    store.mutate(() => {
      const have = rm.members.filter(x => x.kind === 'attr' && x.key === 'blockarea');
      polys.forEach((pts, k) => {
        const values = pts.flatMap(p => p.map(String));
        if (have[k]) { have[k].values = values; return; }
        let at = 0;
        rm.members.forEach((x, i) => { if (x.kind === 'attr') at = i + 1; });
        rm.members.splice(at, 0, { id: newId(), kind: 'attr', key: 'blockarea', values });
      });
      for (const x of have.slice(polys.length)) rm.members.splice(rm.members.indexOf(x), 1);
    }, { key, source: 'screen' });
    rebuild();
  }

  // block area k goes, with its condition
  function removeBlock(k) {
    const m = blockMembers()[k];
    if (!m) return;
    const rm = place();
    store.mutate(() => { rm.members.splice(rm.members.indexOf(m), 1); }, { source: 'screen' });
    rebuild();
  }

  // the tools of polygons (H, K): the polygons of the place as copies to change, how they change, how
  // one goes, the ones drawn, the state of the one under the pointer, their color
  function polyKind(tool) {
    if (tool === 'behind') return { get: () => behindPolys(), set: (p, key) => setBehindPolys(p, key), shown: () => ui.info.behindPolys ?? [],
      remove: k => { const all = behindPolys(); all.splice(k, 1); setBehindPolys(all); }, hover: 'behindHover', color: '255, 110, 220' };
    if (tool === 'block') return { get: () => blockPolys(), set: (p, key) => setBlockPolys(p, key), shown: () => ui.info.blockPolys ?? [],
      remove: k => removeBlock(k), hover: 'blockHover', color: '255, 152, 0' };
    return null;
  }

  // the side panel: the block areas, each with its condition ('unless'), and buttons to remove them
  function blockSection(info) {
    const blocks = blockMembers(), n = blocks.length;
    const remove = async () => {
      if (!(await confirmRemove({ what: n === 1 ? '§1727' : tr('§1728', n), kind: 'block', verb: 'remove' }))) return;
      setBlockPolys([]); st.blockHover = -1; update();
    };
    const removeOne = async k => {
      if (!(await confirmRemove({ what: tr('§1729', k + 1), detail: tr('§0810', info.blockPolys[k]?.length ?? 0), kind: 'block', verb: 'remove' }))) return;
      removeBlock(k); st.blockHover = -1; update();
    };
    const hover = k => { if (st.blockHover !== k) { st.blockHover = k; drawSoon(); } };
    return section('§1721', [
      iconButton('delete', !n ? '§1722' : n === 1 ? '§1723' : tr('§1724', n), remove, '', { disabled: !n }),
    ],
      h('div', { class: 'walk-state' }, icon(n ? 'check_circle' : 'radio_button_unchecked'),
        h('span', {}, !n ? '§0807' : n === 1 ? '§0808' : tr('§0809', n))),
      // one by one: pointing at one shows it on the screen; its condition opens it, its button removes it
      n ? h('div', { class: 'behind-list' }, blocks.map((m, k) => h('div', {
        class: 'behind-list__row', 'data-block': k,
        onmouseenter: () => hover(k), onmouseleave: () => hover(-1),
      },
        h('span', { class: 'kv-table__index' }, String(k + 1)),
        h('div', { class: 'behind-list__text' },
          field({ label: '§1725', value: m.cond ?? '', dense: true, mono: true, placeholder: 'door.state == open',
            onchange: v => editMember(m, x => { if (v.trim()) x.cond = v.trim(); else delete x.cond; }) })),
        iconButton('delete', tr('§0811', k + 1), () => removeOne(k), 'md-icon-button--sm')))) : '',
      h('div', { class: 'section__hint', style: { margin: '8px 0 0' } },
        '§1726'));
  }

  // --- the walk area tool (W): the corners of the polygon, 'walkarea X Y, X Y, ...' (walkarea.js) ----

  // the corners the tool edits: the walk area's, else those of the walkbox
  function walkCorners() {
    const info = ui.info;
    if (info.walkPts) return info.walkPts.map(p => [...p]);
    const [x1, y1, x2, y2] = info.walkbox;
    return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
  }

  // canvas pixels of a point in walk units (x) and pixels (y, the feet: they stand in the row above)
  const walkPx = ([x, y]) => [x * st.cell / 4, (y - 8) * st.cell / 8];

  // the point under the pointer; Shift puts it on the cells
  function walkAt(e) {
    const r = ui.canvas.getBoundingClientRect();
    const cx = (e.clientX - r.left) / r.width * ui.canvas.width, cy = (e.clientY - r.top) / r.height * ui.canvas.height;
    let x = Math.round(cx * 4 / st.cell), y = Math.round(cy * 8 / st.cell) + 8;
    if (e.shiftKey) { x = Math.round(x / 4) * 4; y = Math.round(y / 8) * 8; }
    return [Math.max(0, Math.min(ui.info.width * 4 - 1, x)), Math.max(0, Math.min(199, y))];
  }

  // the corner or the edge under the pointer: { corner } or { edge } (the corner it starts at), or null
  function walkHit(e) {
    const r = ui.canvas.getBoundingClientRect(), k = ui.canvas.width / r.width;
    const p = [(e.clientX - r.left) * k, (e.clientY - r.top) * k], near = 7 * k;
    const pts = walkCorners().map(walkPx);
    const corner = pts.findIndex(q => Math.hypot(q[0] - p[0], q[1] - p[1]) <= near);
    if (corner >= 0) return { corner };
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length], dx = b[0] - a[0], dy = b[1] - a[1], len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
      if (Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]) <= near) return { edge: i };
    }
    return null;
  }

  // the corners become the walk area of the place; a walkbox gives way to it. key: a drag, one undo step
  function setWalkarea(pts, key = null) {
    const rm = place();
    store.mutate(() => {
      const wb = rm.members.findIndex(x => x.kind === 'attr' && x.key === 'walkbox');
      if (wb >= 0) rm.members.splice(wb, 1);
      const values = pts.flatMap(p => p.map(String));
      const m = rm.members.find(x => x.kind === 'attr' && x.key === 'walkarea');
      if (m) { m.values = values; return; }
      let at = 0;
      rm.members.forEach((x, i) => { if (x.kind === 'attr') at = i + 1; });
      rm.members.splice(at, 0, { id: newId(), kind: 'attr', key: 'walkarea', values });
    }, { key, source: 'screen' });
    rebuild();
  }

  // Alt+click: the first point of a route, then its end - the route shows how an actor walks
  function routeClick(p) {
    st.route = !st.route || st.route.to ? { from: p } : { ...st.route, to: p };
    draw();
  }

  // the tool's marks: the corners, and the route of Alt+click from point to point
  function drawWalkTool(ctx) {
    const s = st.cell, hs = Math.max(6, s / 3);
    ctx.fillStyle = 'rgba(0, 255, 200, .95)';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    for (const p of walkCorners().map(walkPx)) {
      ctx.fillRect(p[0] - hs / 2, p[1] - hs / 2, hs, hs);
      ctx.strokeRect(p[0] - hs / 2 + .5, p[1] - hs / 2 + .5, hs - 1, hs - 1);
    }
    if (!st.route) return;
    const area = ui.info.walkarea, to = st.route.to && area ? clampToArea(area, ...st.route.to) : null;   // like a click
    const pts = [st.route.from, ...(!st.route.to ? [] : area ? walkRoute(area, ...st.route.from, to.x, to.y) : [st.route.to])];
    ctx.strokeStyle = '#ffd54f';
    ctx.fillStyle = '#ffd54f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.map(walkPx).forEach((p, k) => ctx[k ? 'lineTo' : 'moveTo'](...p));
    ctx.stroke();
    for (const p of pts.map(walkPx)) { ctx.beginPath(); ctx.arc(p[0], p[1], 3, 0, Math.PI * 2); ctx.fill(); }
  }

  // the multicolor charset of the place: null switches it off, else its two shared colors ($d022, $d023)
  const setPlaceMulticolor = values => setPlaceMode('multicolor', values);
  // extended color mode: null switches it off, else the backgrounds 2-4 ($d022-$d024)
  function setPlaceEcm(values) {
    if (values && !st.grab) { st.ecmBg = st.code >> 6; }   // the brush keeps its char: its bits 6-7 are its background now
    setPlaceMode('ecm', values);
  }

  // multicolor or extended color mode (key): the VIC shows only black with both, so one switches the other off
  function setPlaceMode(key, values, { keepOther = false } = {}) {
    const rm = place();
    store.mutate(() => {
      const other = key === 'ecm' ? 'multicolor' : 'ecm';
      if (values && !keepOther) { const o = rm.members.findIndex(x => x.kind === 'attr' && x.key === other); if (o >= 0) rm.members.splice(o, 1); }
      const i = rm.members.findIndex(x => x.kind === 'attr' && x.key === key);
      if (!values) { if (i >= 0) rm.members.splice(i, 1); return; }
      if (i >= 0) { rm.members[i].values = values; return; }
      let at = 0;
      rm.members.forEach((x, k) => { if (x.kind === 'attr') at = k + 1; });
      rm.members.splice(at, 0, { id: newId(), kind: 'attr', key, values });
    }, { source: 'structure' });
  }

  // the matrix of the 256 characters: a canvas the editor draws on, again after every update. In
  // extended color mode the 64 chars 0-63 at twice the size: the background of the brush adds the rest
  const PB = 2, PG = 2;                           // a black border, a gap between the chars
  const pickerN = () => (ecmOn() ? 8 : 16);       // chars a row
  const pickerS = () => (ecmOn() ? 32 : 16);      // canvas pixels a char: 2 or 4 per C64 pixel
  const pickerAt = v => PB + v * (pickerS() + PG); // column or row -> canvas pixel
  const pickerSize = () => 2 * PB + pickerN() * pickerS() + (pickerN() - 1) * PG;
  // its rows: the directory art has the first 128 chars only (no reverse ones) - the upper 8 rows
  const pickerRows = () => (dirartOn() && !ecmOn() ? pickerN() / 2 : pickerN());
  const pickerHeight = () => 2 * PB + pickerRows() * pickerS() + (pickerRows() - 1) * PG;
  let pickerPlain = null, pickerHover = -1;
  // the ROM font of a Commodore in its visual order (ROM_ORDER); a charset file, ECM and the fonts of the other machines in code order
  const pickerOrdered = () => !ui.info.chrFile && !ecmOn() && machineFont().kind === 'commodore';
  const codeAtPos = k => (ecmOn() ? ecmCode(k) : pickerOrdered() ? ROM_ORDER[k] : k);
  const posOf = code => (ecmOn() ? code & 63 : pickerOrdered() ? ROM_POS[code] : code);
  function makePicker() {
    const picker = dh('canvas', { class: 'code-picker', width: 290, height: 290 });
    const posAt = e => {
      const r = picker.getBoundingClientRect(), n = pickerN();
      const cell = (v, len, size, max) => Math.max(0, Math.min(max - 1, Math.floor((v * size / len - PB) / (pickerS() + PG))));
      return cell(e.clientY - r.top, r.height, picker.height, pickerRows()) * n + cell(e.clientX - r.left, r.width, picker.width, n);
    };
    // the character under the mouse in light red, over the drawn matrix
    const hover = p => {
      if (p === pickerHover || !pickerPlain) return;
      pickerHover = p;
      const pctx = picker.getContext('2d');
      pctx.putImageData(pickerPlain, 0, 0);
      if (p < 0) return;
      pctx.fillStyle = 'rgba(255, 138, 128, .55)';
      pctx.fillRect(pickerAt(p % pickerN()), pickerAt(Math.floor(p / pickerN())), pickerS(), pickerS());
    };
    picker.addEventListener('click', e => setBrush(codeAtPos(posAt(e)), st.color));
    picker.addEventListener('pointermove', e => {
      const p = posAt(e), c = codeAtPos(p);
      picker.title = t(tr('§0853', c, hex2(c)));
      hover(p);
    });
    picker.addEventListener('pointerleave', () => hover(-1));
    return picker;
  }
  function drawPicker() {
    const picker = ui.picker, info = ui.info, pctx = picker.getContext('2d');
    const n = pickerN(), ps = pickerS();
    if (picker.width !== pickerSize() || picker.height !== pickerHeight()) { picker.width = pickerSize(); picker.height = pickerHeight(); }
    pctx.fillStyle = '#000';
    pctx.fillRect(0, 0, picker.width, picker.height);
    // the chars white on dark grey - in a multicolor place with a brush color of 8-15 as the game
    // shows them then: multicolor, in the brush color and the two shared colors
    // - on an Atari screen every char as the screen shows it: its registers, its mode (shownColor)
    const chars = glyphs(info), multi = info.multicolor && st.color & 8;
    for (let k = 0; k < n * pickerRows(); k++) {
      const code = codeAtPos(k) & (ecmOn() ? 63 : 255);
      if (info.atari) drawCell(pctx, code, pickerAt(k % n), pickerAt(Math.floor(k / n)), ps, shownColor(code, 0), info.bg, info.charset, chars, info.multicolor);
      else drawCell(pctx, code, pickerAt(k % n), pickerAt(Math.floor(k / n)), ps,
        multi ? st.color : pickerColors().fg, multi ? info.bg : pickerColors().bg, info.charset, chars, multi ? info.multicolor : null);
    }
    pctx.strokeStyle = '#ffd54f';
    pctx.lineWidth = 2;
    for (let k = 0; k < (st.grab ? 0 : st.tile.w * st.tile.h); k++) {
      const p = posOf(nthCode(k));
      pctx.strokeRect(pickerAt(p % n) + 1, pickerAt(Math.floor(p / n)) + 1, ps - 2, ps - 2);
    }
    pickerPlain = pctx.getImageData(0, 0, picker.width, picker.height);
    pickerHover = -1;
  }

  // the sections open and close with a click on their head; the closed ones are remembered by title
  const section = (title, actions, ...content) => uiSection(title, content, actions, 'screen.collapsed');

  // the screen code of the last of n chars of the brush
  const lastCode = n => nthCode(n - 1);

  // the brush as it paints: its tile of W x H chars, the cells smaller the bigger it is
  function brushTile() {
    const w = tileW(), th = tileH(), size = Math.max(8, Math.min(56, Math.floor(112 / Math.max(w, th))));
    const tip = st.grab ? tr('§1121', w, th) : w * th > 1 ? tr('§1122', st.code, lastCode(w * th)) : tr('§0859', st.code);
    return h('div', { class: 'brush-tile', style: { gridTemplateColumns: `repeat(${w}, ${size}px)` }, 'data-tip': tip },
      Array.from({ length: w * th }, (_, k) => { const v = tileAt({ code: st.code, color: st.color }, k % w, Math.floor(k / w)); return swatch(v.code, v.color, size); }));
  }

  // the colors under the characters: the brush (brush), the shared multicolors, the background -
  // in extended color mode the four backgrounds, one of them the background of the brush
  // in pixel mode (screenpaint.js) the rows are its pens too: the color of the cell - of 8 in a
  // multicolor place, where the cell is multicolor - and the shared colors; a click makes one the pen
  // the colours of the machine (video.js): the 16 of the C64, the 8 of a VIC-20 char, the 121 of the TED;
  // the PET has one
  function placeColors(info, brush) {
    if (video().cells === 'mono') return '';
    if (info.atari) return atariColors(info);
    const mc = getAttr(place(), 'multicolor'), ecm = getAttr(place(), 'ecm');
    const px = brush && st.pixels, pxMc = px && !!info.multicolor, names = mcNames();
    const penRow = (key, row) => (px ? { ...row, active: painter.pen() === key, onselect: () => painter.setPen(key) } : row);
    // the VIC-20 has no multicolor switch: bit 3 of a colour makes the char multicolor, a hires char takes 8
    const cellKind = pxMc || (video().cells === 'vic' && info.multicolor) ? 'mc' : video().cells === 'vic' ? 'cell' : 'all';
    const pen = brush ? [penRow('color', { label: px ? '§1625' : '§0637', color: cellKind === 'mc' ? mcCellColor(st.color) : st.color, active: true, tip: '§0966',
      count: cellKind, onpick: k => setColor(cellKind === 'mc' ? mcCell(k) : k) })] : [];
    return info.ecm ? colorChooser([
      ...pen.map(x => ({ ...x, active: false })),
      ...[info.bg, ...info.ecm].map((color, k) => ({
        label: tr('§1183', k + 1), color, active: brush && st.ecmBg === k,
        tip: k ? tr('§0978', k + 1, 1 + k, k * 64, k * 64 + 63)
          : '§0977',
        onselect: brush ? () => setEcmBg(k) : undefined,
        onpick: c => (k ? setPlaceEcm(ecm.map((v, i) => (i === k - 1 ? colorValue(c, COLOR_NAMES) : v))) : setPlaceColor('bgcolor', c)),
      })),
    ]) : colorChooser([
      ...pen,
      ...(mc ? [0, 1].map(k => penRow(k ? 'mc2' : 'mc1', { label: k ? names.mc2 : names.mc1, color: colorIndex(mc[k], info.consts, 0),
        tip: video().cells === 'vic2' ? tr('§0968', k + 1, 2 + k) : k ? names.mc2 : names.mc1,
        count: video().cells === 'vic' && !k ? 'cell' : 16,           // the VIC-20's border: one of 8
        onpick: c => setPlaceMulticolor(mc.map((v, i) => (i === k ? colorValue(c, COLOR_NAMES) : v))) })) : []),
      { label: '§0636', color: info.bg,
        tip: '§0967', onpick: k => setPlaceColor('bgcolor', k) },
    ]);
  }

  // an Atari screen: its five colour registers - ANTIC 2 shows COLOR1 (the luminance of the chars), COLOR2 (their
  // background) and COLOR4 (the border); ANTIC 4 COLOR4 (00), COLOR0 (01), COLOR1 (10), COLOR2 (11), COLOR3 (11 of
  // the codes 128-255). A click on a swatch sets it for the whole screen
  function atariColors(info) {
    const { regs, antic4 } = info.atari;
    const set = (k, c) => {
      const values = regs.map(String);
      values[k] = String(c);
      setPlaceMode('registers', values, { keepOther: true });
    };
    const label = antic4 ? ['COLOR0 (01)', 'COLOR1 (10)', 'COLOR2 (11)', 'COLOR3 (11, codes 128-255)', 'COLOR4: background (00)']
      : [null, 'COLOR1: luminance of the chars', 'COLOR2: background', null, 'COLOR4: border'];
    return colorChooser(regs.map((color, k) => label[k] && { label: label[k], color, tip: `${label[k]} - the register of the whole screen`, onpick: c => set(k, c) }).filter(Boolean));
  }

  function sideView() {
    const info = ui.info;
    const legacy = legacyMaps(store.game).filter(m => place().members.includes(m));
    const tiles = tileBrush();                      // the brush is a tile: no section of chars, no brush of chars

    return [
      painter.section(),
      dirartOn() ? '' : tilesSection(),
      tiles ? '' : section('§0854', [iconButton('edit', info.chrFile ? '§0855' : '§0856',
            () => actions.openChars(info.chrFile, st.placeId))],
        placeTileset() ? h('div', { class: 'section__hint', style: { margin: '0 0 14px' } },
          tr('§1420', tilesetCharset(tilesetKey(getAttr(place(), 'tiles'))) ?? romName(info))) : dirartOn() ? '' : charsetSelect(info),
        dom(ui.picker),
        h('div', { style: { marginTop: '10px' } }, placeColors(info, true)),
        info.multicolor ? h('div', { class: 'section__hint', style: { margin: '10px 0 0' } },
          '§0984') : '',
        h('div', { class: 'section__hint', style: { margin: '10px 0 0' } }, info.ecm ? '§0979'
          : info.chrFile ? '§0857'
          : dirartOn() ? '§1742'
          : machineFont().kind === 'commodore' ? '§0965' : `The ROM font of the ${platformOf(videoMachine()).short} (${machineFont().source}), in the order of its codes.`)),
      tiles ? '' : section('§0858', [],
        h('div', { class: 'brush-current' }, brushTile()),
        h('div', { class: 'sprite-color-label' }, '§0860'),
        sizePicker({ w: tileW(), h: tileH(), onchange: (w, th) => {
          if (!Number.isInteger(w) || !Number.isInteger(th) || w < 1 || th < 1 || w > 16 || th > 16) {
            return snackbar('§0861', { error: true });
          }
          st.tile = { w, h: th };
          st.grab = null;
          update();
        } }),
        st.grab ? h('div', { class: 'section__hint', style: { margin: '8px 0 0' } },
          '§0839')
        : st.tile.w * st.tile.h > 1 ? h('div', { class: 'section__hint', style: { margin: '8px 0 0' } },
          tr('§0862', st.code, lastCode(st.tile.w * st.tile.h), st.tile.w)) : ''),
      dirartOn() ? '' : layersSection(),
      legacy.length ? h('div', { class: 'section' },
        h('div', { class: 'banner banner--info' }, icon('info'),
          h('span', {}, tr('§1066', legacy.length, legacy.length === 1 ? '' : 's'))),
        h('div', { style: { marginTop: '12px' } },
          button('§0863', { icon: 'auto_fix_high', variant: 'tonal', onclick: () => { actions.convertToPetscii(); render(); } }))) : '',
      section('§0865', [],
        recentView()),
    ];
  }

  // what the editor draws on is made once; the views show it (pui.dom)
  function islands() {
    if (ui) return;
    const canvas = dh('canvas', { class: 'screen-canvas',
      onpointerdown: onDown, onpointermove: onMove, onpointerup: onUp, onpointercancel: onUp,
      onpointerleave: () => { st.hover = null; painter.leave(); draw(); status(null); },
      oncontextmenu: e => e.preventDefault() });
    const wrap = dh('div', { class: 'screen-canvas-wrap', tabindex: 0, onkeydown: onKey }, canvas);
    wheelZoom(wrap, () => ui?.canvas, zoom);   // the wheel zooms
    const slider = dh('input', { type: 'range', class: 'cam-slider', min: 0, step: 1,
      oninput: e => { st.camPx = Number(e.target.value); st.playing = false; update(); drawCamera(); draw(); } });
    ui = { canvas, wrap, slider, cam: dh('canvas', { class: 'cam-canvas' }), camStatus: dh('span', { class: 'md-body-small cam-status' }), picker: makePicker(), info: null, cells: null };
    attachObjectDrag(canvas, {
      store, place, source: 'screen', selectOnDown: true,
      enabled: () => st.tool === 'object',   // the layer tool drags layers
      selected: () => st.selObj,
      onSelect: id => { st.selObj = id; update(); draw(); },
      onHover: id => { st.hoverObj = id; draw(); },
      onChange: () => rebuild(),
      onDone: () => update(),
      onPreview: rect => { st.createRect = rect; draw(); },
      onCreate: async rect => {
        const obj = await actions.addObject(st.placeId, rect, { select: false });
        if (obj) st.selObj = obj.id;
        render();
      },
    });
  }

  // the place as it is edited: its screen file (background and patches), its chars and colors
  // row by row (the chars of all rows, then their colors - 40 wide, the screen and color RAM of
  // the place band), and a PNG of the background (2 screen pixels per C64 pixel)
  function exportFormats(rm) {
    const info = placeInfo(store.game, rm), bg = rm.members.find(m => m.kind === 'background');
    const name = bg.file ?? scrPath(rm.name, gfxDir(store.path)), size = info.width * info.rows;
    return [
      { label: '§1019', name: exportName(name, 'gfx'), description: 'yopaca screen', bytes: () => placeToFile(rm, rm.canvas?.charset ?? symbols(store.game).charset) },
      // the colours as the colour RAM holds them (the TED: its attribute bytes); the PET and the Atari have none
      { label: tr('§1020', info.width, info.rows), name: exportName(name, 'bin'), description: `${platformOf(videoMachine()).short} screen data`,
        bytes: () => {
          const mono = video().cells === 'mono' || video().cells === 'atari', out = new Uint8Array(size * (mono ? 1 : 2));
          out.set(info.chars.subarray(0, size));
          if (!mono) out.set(info.colors.subarray(0, size).map(c => c & colorMask()), size);
          return out;
        } },
      { label: '§1021', icon: 'wallpaper', name: exportName(name, 'png'), type: 'image/png', description: 'PNG picture',
        bytes: () => {
          const cv = document.createElement('canvas');
          drawPlace(cv, store.game, rm, { cell: 16 });
          return pngOf(cv);
        } },
    ];
  }

  // --- import (the Import button of the app bar: app.js, export.js) -------------------------

  // a map { w, h, chars, colors (0-15, or null: the text color) } as the background of the place:
  // its rows (17, a fullscreen place 24) from the top, as wide as the map (40 at least); what is
  // missing is blank. A new width changes the width of the place first
  function importMap(m, name) {
    const rm = place(), bg = rm?.members.find(x => x.kind === 'background');
    if (!bg) throw new Error(tr('§1987', rm?.name ?? ''));
    const rows = rowsOf(), w = Math.max(PLACE_COLS, Math.min(maxPlaceCols(store.game), m.w));
    const chars = new Uint8Array(w * rows).fill(32), colors = m.colors ? new Uint8Array(w * rows).fill(0xff) : null;
    for (let y = 0; y < Math.min(rows, m.h); y++) {
      for (let x = 0; x < Math.min(w, m.w); x++) {
        chars[y * w + x] = m.chars[y * m.w + x];
        if (colors) colors[y * w + x] = m.colors[y * m.w + x];
      }
    }
    const art = mapToLines({ w, h: rows, chars, colors }, charset());
    if (w !== placeWidth(rm, constMap(store.game))) actions.setPlaceWidth(rm.id, w);
    store.mutate(() => {
      bg.lines = art.lines;
      if (art.colors) bg.colors = art.colors; else delete bg.colors;
    }, { source: 'screen' });
    render();
    snackbar(tr('§1015', name, m.w, m.h, rm.name, w, rows));
  }

  // a screen file of yopaca (.gfx): its screen, not its patches
  const importGfx = (bytes, name) => importMap(decodeScreen(bytes, name).screen, name);

  // chars and colors (.bin): W x rows chars, then their colors, as the export writes them; a whole
  // C64 screen (1000 chars and 1000 colors, 40 x 25) gives its top rows, 1000 bytes only chars
  function importBin(bytes, name) {
    // a whole screen of the machine (video.js): 40 x 25, the VIC-20's 22 x 23
    const rows = rowsOf(), color = c => c & colorMask(), { cols: W, rows: H } = video().screen ?? { cols: 40, rows: 25 };
    if (bytes.length === 2 * W * H) return importMap({ w: W, h: H, chars: bytes.subarray(0, W * H), colors: bytes.subarray(W * H).map(color) }, name);
    if (bytes.length === W * H) return importMap({ w: W, h: H, chars: bytes, colors: null }, name);
    const n = bytes.length / 2;
    if (!Number.isInteger(n) || n % rows) {
      throw new Error(tr('§1988', bytes.length, rows));
    }
    importMap({ w: n / rows, h: rows, chars: bytes.subarray(0, n), colors: bytes.subarray(n).map(color) }, name);
  }

  // a CharPad project (.ctm): its chars become a new charset of the place (gfx/charset/NAME.chr),
  // its mode and colors those of the place (multicolor $d022/$d023, bgcolor), its map - tiles
  // expanded into their chars - the screen of the place (importMap)
  async function importCtm(bytes, name) {
    const p = parseCtm(bytes, name), rm = place();
    if (p.mode > 1) throw new Error(tr('§1989', name, CTM_MODES[p.mode]));
    if (p.count > 256) throw new Error(tr('§1965', name, p.count));
    const data = new Uint8Array(2048);
    data.set(p.chars.subarray(0, 2048));
    const known = new Set(listBinaries());
    const base = importName(name, 'charpad');
    let key = `${scriptDirectory()}${LAYOUT.charset}/${base}.chr`;
    for (let k = 2; known.has(key); k++) key = `${scriptDirectory()}${LAYOUT.charset}/${base}${k}.chr`;
    setCharsetBytes(key, data);
    await saveCharset(key);
    store.mutate(() => {
      const m = rm.members.find(x => x.kind === 'attr' && x.key === 'charset');
      if (m) { m.str = scriptRelative(key); delete m.values; return; }
      let at = 0;
      rm.members.forEach((x, i) => { if (x.kind === 'attr') at = i + 1; });
      rm.members.splice(at, 0, { id: newId(), kind: 'attr', key: 'charset', str: scriptRelative(key) });
    }, { source: 'structure' });
    setPlaceMulticolor(p.mode === 1 ? [COLOR_NAMES[p.colors.mc1 & 15], COLOR_NAMES[p.colors.mc2 & 15]] : null);
    setPlaceColor('bgcolor', p.colors.bg & 15);
    importMap(ctmScreen(p), name);
    snackbar(tr('§1695', name, p.count, scriptRelative(key), rm.name));
  }

  const importFormats = () => (!store.game || !place() ? [] : [
    { label: '§1019', icon: 'wallpaper', accept: '.scr,.gfx', open: importGfx },
    { label: '§1691', icon: 'wallpaper', accept: '.ctm', open: importCtm },
    { label: '§1014', icon: 'wallpaper', accept: '.bin,.raw', open: importBin },
  ]);

  // a new screen (actions.js addPlace: its name and size), shown at once
  async function addScreen() {
    const p = await actions.addPlace(null);
    if (p) { st.placeId = p.id; st.layer = 'background'; st.camPx = 0; st.sel = null; render(); }
  }

  function barView() {
    const rm = store.game && place();
    // no screen yet: the bar has the button that makes one
    if (!rm) return store.game ? h('div', { class: 'screen-bar' }, h('span', { class: 'md-title-medium' }, 'Screen'), h('span', { class: 'screen-bar__sep' }),
      iconButton('add', 'New screen', addScreen)) : null;
    const toggle = (ic, tip, key) => iconButton(ic, tip, () => { st[key] = !st[key]; update(); draw(); }, st[key] ? 'md-icon-button--selected' : '');
    const mc = getAttr(rm, 'multicolor'), ecm = getAttr(rm, 'ecm'), canvas = !!rm.canvas;
    return h('div', { class: 'screen-bar' },
      h('span', { class: 'md-title-medium' }, 'Screen'),
      h('span', { class: 'screen-bar__sep' }),
      iconButton('add', 'New screen', addScreen),
      h('span', { class: 'screen-bar__sep' }),
      defaultTools({
        undo: () => store.undo(), redo: () => store.redo(), zoom,
        grid: { on: st.grid, toggle: () => { st.grid = !st.grid; update(); draw(); } },
        // the two modes of the place side by side: multicolor and extended color mode, one of them - as the
        // machine has them (video.js: the VIC-20 no ECM, the PET neither); the directory art has neither
        multicolor: !hasMulticolor() ? undefined : { on: !!mc, locked: rm.canvas?.dirart ? '§1660' : null, toggle: () => setPlaceMulticolor(mc ? null : startColors().mc.map(k => colorValue(k, COLOR_NAMES))) },
        modes: rm.canvas?.dirart ? [] : [video().ecm ? modeButton('ECM', ecm ? '§0980' : '§0981',
          () => setPlaceEcm(ecm ? null : startColors().ecm.map(k => colorValue(k, COLOR_NAMES))), !!ecm, { 'data-mode': 'ecm' }) : '',
          modeButton('PIX', st.pixels ? '§1611' : '§1612', painter.toggle, st.pixels, { 'data-mode': 'pixels' })],
        clear: { tip: '§0826', run: () => applyRange('clear') },
      }),
      h('span', { class: 'screen-bar__sep' }),
      ui?.info ? [brushTools({ brush: st.shape, tool: st.tool, tools: SHAPE_TOOLS, max: brushMax(shapeGrid()),
        onchange: b => { st.shape = b; update(); draw(); } }),
        radiusTools({ radius: st.radius, tool: st.tool, max: radiusMax(st.pixels ? painter.grid() : shapeGrid()), onchange: v => { st.radius = v; update(); draw(); } }),
        h('span', { class: 'screen-bar__sep' })] : '',
      h('div', { class: 'app-bar__spacer' }),
      // the size of the screen (its file: gfx/screen/NAME.scr) and its delete
      h('span', { class: 'md-body-small screen-bar__canvas' }, `${rm.canvas.cols} × ${rm.canvas.rows} chars · ${canvasPath(rm, gfxDir(store.path))}`),
      iconButton('delete', `Delete the screen ${rm.name}`, async () => { if (await actions.deleteCanvas(rm.id)) { st.placeId = null; render(); } }, '', { 'data-action': 'delete-canvas' }));
  }

  const StatusLine = () => h('span', { class: 'md-body-small screen-status' }, statusLine.value);

  function bodyView() {
    if (!store.game) return null;
    if (!place() || !ui?.info) return h('div', { class: 'empty-state' }, icon('wallpaper'), h('div', { class: 'md-title-medium' }, '§0868'),
      store.game ? button('New screen', { icon: 'add', variant: 'tonal', onclick: addScreen }) : '');
    // the range tools, in the toolbox left of the canvas below the drawing tools
    const range = { keys: RANGE_KEYS, run: applyRange, note: '§1991' };
    return h('div', { class: 'screen-body' },
      h('div', { class: 'screen-main' },
        paintArea({ tools: toolsFor(place()), current: st.tool, onselect: setTool, range }, dom(ui.wrap)),
        h('div', { class: 'screen-foot' }, h(StatusLine, {})),
        !place().canvas && h('div', { class: 'cam-panel' },
          h('div', { class: 'cam-panel__head' },
            icon('videocam'), h('span', { class: 'md-title-small' }, '§0869'),
            iconButton(st.playing ? 'pause' : 'play_arrow', '§0870', () => { st.playing = !st.playing; update(); animate(); }, 'md-icon-button--tonal'),
            dom(ui.slider), dom(ui.camStatus)),
          h('div', { class: 'cam-frame' }, dom(ui.cam)))),
      sidePanel('Screen', sideView()));
  }

  // --- render --------------------------------------------------------------------------

  function render() {
    if (!store.game) return;
    const S = symbols(store.game);
    if (!place()) st.placeId = screensOf(store.game).find(c => !c.canvas.dirart)?.id ?? screensOf(store.game)[0]?.id ?? null;   // the first screen
    actions.route?.();            // the address follows what is open (app.js)
    const rm = place();
    if (!rm) {
      views ??= [mount(bar, barView), mount(el, bodyView)];
      update();
      return;
    }
    if (st.layer !== 'background' && !patch()) st.layer = 'background';
    if (!toolsFor(rm).some(t => t.key === st.tool)) Object.assign(st, { tool: 'pencil', drag: null });
    const width = placeWidth(rm, consts());
    st.sel = clipRect(st.sel, width, rowsOf());

    islands();
    painter.cursor();
    views ??= [mount(bar, barView), mount(el, bodyView)];
    base = null;
    camBase = null;
    rebuild();
    update();
    if (st.playing) animate();
    playAnims();
  }

  // the pixel mode (screenpaint.js): the tools of the toolbox are its own while it is on
  const painter = createPixelPainter({
    store, st, ui: () => ui, place, patch, patchRect, rowsOf, cellValue, paint, draw, drawSoon, update, setTool, setColor,
    tiling: () => tiling(), status: cell => status(cell), rebuild,
  });
  const toolsFor = rm => (st.pixels ? painter.tools() : toolsOf(rm));

  followCurve(() => ui, () => st.tool === 'curve' && !!st.drag?.bend, onMove, onDown);

  store.on((type, detail) => {
    if (type === 'load') { st.placeId = null; st.layer = 'background'; st.camPx = 0; st.sel = null; st.charsetFiles = null; listingCharsets = false; }   // another script, maybe of another project
    if (el.hidden) return;
    if (type === 'load') render();
    else if (type === 'change' && detail.source !== 'screen') render();
  });

  // what a reload keeps (uistate.js): the brush, the tools, the zoom, the camera, the layer drawn on
  const KEEP = ['tool', 'code', 'color', 'cell', 'shape', 'grid', 'overlays', 'camera', 'camPx', 'ecmBg', 'tile', 'tileNo', 'recent', 'pixels', 'pen', 'radius'];
  keepUi('screen', {
    save: () => ({ ...pickUi(st, KEEP), layer: st.layer === 'background' ? null : store.node(st.layer)?.name ?? null }),
    load(s) {
      putUi(st, s, KEEP);
      const layer = s.layer && place()?.members.find(m => m.kind === 'patch' && m.name === s.layer);
      if (layer) st.layer = layer.id;
      if (!el.hidden) render();
    },
  });

  return {
    // what the Export button of the app bar offers here (app.js): the place open, with a background
    exportFormats: () => {
      const rm = store.game && place();
      return rm && rm.members.some(m => m.kind === 'background') ? exportFormats(rm) : [];
    },
    current: () => place()?.name ?? null,        // the place open: its name, for the address
    open(placeId) {
      if (placeId && placeId !== st.placeId) { st.placeId = placeId; st.layer = 'background'; st.camPx = 0; st.sel = null; }
      // another machine (video.js): the brush starts in its text colour, one of its colours
      if (st.machine !== videoMachine()) { st.machine = videoMachine(); st.color = startColors().text; }
      render();
      ui?.wrap.focus({ preventScroll: true });
    },
    render,
    cancel,
    importFormats,
  };
}
