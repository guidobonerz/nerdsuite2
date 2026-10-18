// bitmap.js - the bitmap editor: a C64 bitmap picture with the color rules of the VIC's
// bitmap modes:
//   hires:      320 x 200 pixels of 1 x 1; every 8 x 8 cell has two colors, a foreground
//               (a set pixel) and a background (a clear pixel) - the two nibbles of its
//               screen byte
//   multicolor: 160 x 200 pixels of 2 x 1; every 8 x 8 block (4 x 8 of them) has three colors - pens 1 and 2
//               from its screen byte, pen 3 from the color RAM - and pen 0 is the background
//               of the whole picture
// Two pens, rows like in the sprite editor: Background and Color. Hires: they are the block's
// two slots - painting with a pen gives the block that pen's color. Multicolor: the
// background is the register of the whole picture, and the block's three slots are managed
// by the editor: painting with the color uses the slot that holds it, takes a free slot (one
// no pixel of the block shows) or, with three other colors in the block, recolors the slot it
// paints over - all its pixels in the block; over the background it leaves the pixel alone - a
// color clash, counted in the status line. The left button paints with the selected pen, the
// right button with the background. The pixel under the pointer shows the color it paints.
//
// The picture is a file of the project: Koala (.kla) for multicolor - load address, 8000
// bytes of bitmap, 1000 of screen, 1000 of color RAM, the background - and Art Studio (.art)
// for hires - load address, bitmap, screen, 7 bytes of padding.
//
// The canvas is drawn on by this module; the bar, the toolbox and the side panel are Preact
// views (pui.js), rendered again by update().

import { LAYOUT } from './layout.js';
import { PALETTE } from './c64.js';
import { tools, RANGE, rotation, rangeForKey, DRAG_TOOLS, BRUSH_TOOLS, defaultBrush, brushCells, brushMax, brushTools, radiusMax, radiusTools, defaultTools, paintArea, toolForKey, lineCells, dragCells as dragXY, dragMods, dragTo, curveWaits, followCurve, DRAW_POLY, WAIT_TOOLS, waits, strokeDown, closePolygon, wheelZoom, outlineCells } from './drawtools.js';
import { regionOp, rectBetween, clipRect } from './gridops.js';
import { h, mount, dom, signal, iconButton, select, snackbar, promptDialog, section, sidePanel, confirmRemove } from './pui.js';
import { colorChooser } from './colorchooser.js';
import { reloadPicture } from './picture.js';
import { listBinaries, readBinary, writeBinary, isOpen } from './project.js';
import { pngOf, exportName, importName } from './export.js';
import { bitmapPrg } from './bitmapprg.js';
import { referenceLayer } from './trace.js';
import { encodeYbm, decodeYbm, isYbm } from './ybm.js';
import { aaShape, coverage, shadeOf, edgeCover } from './aa.js';
import { tr } from './i18n.js';
import { keepUi, pick as pickUi, put as putUi } from './uistate.js';

const COLOR_NAMES = ['black', 'white', 'red', 'cyan', 'purple', 'green', 'blue', 'yellow',
  'orange', 'brown', '§0616', '§0617', 'grey', '§0618', '§0619', '§0620'];
const ZOOM = [1, 2, 3, 4, 5, 6, 8];
const UNDO_LIMIT = 60;
const PULSE_MS = 1200;              // the border of the pixel cursor fades from black to white and back in this time
const COLS = 40, ROWS = 25, CELLS = COLS * ROWS;
const KOALA_SIZE = 2 + 8000 + 1000 + 1000 + 1, ART_SIZE = 2 + 8000 + 1000 + 7;

// the tools of the bitmap (drawtools.js): the hand (scrolls the zoomed canvas), select and draw
// the tools that draw antialiased when it is on
const AA_TOOLS = new Set(['pencil', 'line', 'rect', 'circle', 'curve', 'polygon']);
const TOOLS = tools(['select', 'hand', ...DRAW_POLY], { erase: '§0621', pick: '§0622',
  more: { select: ' · Shift: whole blocks' } });

const rgb = hex => [1, 3, 5].map(k => parseInt(hex.slice(k, k + 2), 16));

export function createBitmapEditor(el, store, actions, bar) {
  const st = {
    file: null,                 // the picture's path in the project, null: a new one
    files: [],                  // the pictures of the project (.kla, .art)
    mc: false,
    pix: null,                  // 200 rows: hires 320 values 0/1, multicolor 160 values 0-3
    slots: null,                // per cell: multicolor [pen1, pen2, pen3], hires [fg, bg] (the same screen byte) and the color RAM of multicolor
    bg: 0,                      // multicolor: the background of the picture
    pen: 1,                     // the pen of the left button: 0 background, 1 color
    penColor: [0, 1],           // the colors of the two pens: [background, color]
    tool: 'pencil', cell: 3, grid: true,
    brush: defaultBrush(), radius: 0,      // the brush of the pencil, line, box, circle and curve (drawtools.js)
    hover: null, drag: null, sel: null,
    pan: null,                  // the hand tool while dragging: where it was pressed and the scroll position then
    aa: false,                  // antialiasing: the edges of what the color pen draws in the colors between it and the background
    undo: [], redo: [], dirty: false,
  };
  let ui = null;                    // the canvas and its wrap, made once
  let views = null;                 // the mounted bar and body (pui.mount)
  const update = () => views?.forEach(v => v.update());
  // the turn of the range tool 'rotate' (drawtools.js): while it is on, the picture is turned - from
  // the state kept aside when it started, which comes back each time and when it ends; Apply turns
  // it as one undo step
  let unturned = null;
  const rot = rotation({
    preview: () => {
      unturned ??= { pix: st.pix.map(r => r.slice()), slots: st.slots.map(s => [...s]), sel: st.sel };
      Object.assign(st, { pix: unturned.pix.map(r => r.slice()), slots: unturned.slots.map(s => [...s]), sel: unturned.sel });
      if (rot.on) moveRange('rotate', 1, { aspect: st.mc ? 2 : 1, ...rot.turn }, false);
      else { unturned = null; draw(); status(); }
    },
    apply: t => moveRange('rotate', 1, { aspect: st.mc ? 2 : 1, ...t }),
    refresh: () => render(),
  });
  const statusLine = signal('');    // the line below the canvas: it changes with every move of the pointer
  let img = null;
  // the image to trace (trace.js), one per picture: in front of the pixels - every pixel of a
  // bitmap has a color, nothing behind them would show
  const refKey = (file = st.file) => `bitmap:${file ?? 'new'}`;
  const reference = referenceLayer({ key: () => (st.pix ? refKey() : null), area: () => ({ w: 320, h: ph() }),
    redraw: () => draw(), rerender: () => update(), behind: false });

  const pw = () => (st.mc ? 160 : 320);
  const ph = () => 200;
  const cellOf = p => ({ c: Math.floor(p.x / (st.mc ? 4 : 8)), r: p.y >> 3 });
  const fgValue = () => st.pen;
  const pixelColor = (v, k) => (st.mc ? (v ? st.slots[k][v - 1] : st.bg) : st.slots[k][v ? 0 : 1]);

  function blank(mc) {
    st.mc = mc;
    st.pix = Array.from({ length: ph() }, () => new Uint8Array(pw()));
    st.slots = Array.from({ length: CELLS }, () => (mc ? [1, 2, 3] : [1, 0]));
    st.bg = 0;
    st.penColor = [0, 1];
    st.pen = 1;
    st.sel = null; st.undo = []; st.redo = [];
  }

  // --- the file formats ---------------------------------------------------------------------------

  function decode(bytes) {
    const mc = bytes.length === KOALA_SIZE;
    if (!mc && bytes.length !== ART_SIZE) throw new Error(`${bytes.length} bytes: not a Koala (${KOALA_SIZE}) or Art Studio (${ART_SIZE}) picture`);
    blank(mc);
    const bitmap = bytes.subarray(2, 8002), screen = bytes.subarray(8002, 9002), color = mc ? bytes.subarray(9002, 10002) : null;
    st.bg = mc ? bytes[10002] & 15 : 0;
    if (mc) st.penColor[0] = st.bg;
    for (let k = 0; k < CELLS; k++) {
      const c = k % COLS, r = Math.floor(k / COLS);
      st.slots[k] = mc ? [screen[k] >> 4, screen[k] & 15, color[k] & 15] : [screen[k] >> 4, screen[k] & 15];
      for (let y = 0; y < 8; y++) {
        const b = bitmap[k * 8 + y], row = st.pix[r * 8 + y];
        if (mc) for (let x = 0; x < 4; x++) row[c * 4 + x] = (b >> (6 - 2 * x)) & 3;
        else for (let x = 0; x < 8; x++) row[c * 8 + x] = (b >> (7 - x)) & 1;
      }
    }
  }

  function encode() {
    const bytes = new Uint8Array(st.mc ? KOALA_SIZE : ART_SIZE);
    bytes[0] = 0x00; bytes[1] = 0x60;                 // $6000, the usual load address of both
    for (let k = 0; k < CELLS; k++) {
      const c = k % COLS, r = Math.floor(k / COLS), s = st.slots[k];
      for (let y = 0; y < 8; y++) {
        const row = st.pix[r * 8 + y];
        let b = 0;
        if (st.mc) for (let x = 0; x < 4; x++) b |= row[c * 4 + x] << (6 - 2 * x);
        else for (let x = 0; x < 8; x++) b |= row[c * 8 + x] << (7 - x);
        bytes[2 + k * 8 + y] = b;
      }
      bytes[8002 + k] = (s[0] << 4) | (s[1] & 15);
      if (st.mc) bytes[9002 + k] = s[2] & 15;
    }
    if (st.mc) bytes[10002] = st.bg;
    return bytes;
  }

  // changed or not: the red dot of the Save in the app bar follows (app.js)
  function setDirty(on) {
    if (st.dirty === on) return;
    st.dirty = on;
    actions.dirtyChanged?.();
  }

  async function listFiles() {
    st.files = listBinaries().filter(f => /\.(kla|koa|art)$/i.test(f));
  }

  async function openFile(path) {
    try {
      decode(readBinary(path));
      st.file = path; setDirty(false);
    } catch (e) {
      snackbar(tr('§0626', path, e.message), { error: true });
      if (!st.pix) blank(false);
    }
    render();
  }

  async function save(as = false, { quiet = false } = {}) {
    if (!st.pix) return;
    let path = st.file;
    const ext = st.mc ? 'kla' : 'art';
    if (!path || as || !path.toLowerCase().endsWith('.' + ext)) {
      const v = await promptDialog({
        title: tr('§0627'), icon: 'save', ok: 'Save',
        text: st.mc ? '§0628' : '§0629',
        fields: [{ name: 'path', label: '§1263', value: (path ?? st.suggest ?? `${LAYOUT.bitmap}/picture.kla`).replace(/\.\w+$/, '.' + ext), mono: true,
          validate: p => (!/^[\w\-./]+\.(kla|koa|art)$/i.test(p) || p.includes('..') ? tr('§0630', ext) : null) }],
      });
      if (!v) return;
      path = v.path;
    }
    try {
      writeBinary(path, encode());
      if (path !== st.file) reference.rename(refKey(), refKey(path), { copy: !!st.file });   // the new picture takes it along
      st.file = path; setDirty(false);
      if (!quiet) snackbar(tr('§0631', path));
      reloadPicture(path);                          // the storyboard previews of places that show it
      await listFiles();
      render();
    } catch (e) {
      snackbar(tr('§0211', e.message), { error: true, timeout: 8000 });
    }
  }

  const mayDiscard = async title => !st.dirty || !!(await promptDialog({ title, icon: 'note_add', ok: '§0634', text: 'The picture has unsaved changes.', fields: [] }));

  async function newPicture() {
    if (!(await mayDiscard('§0633'))) return;
    blank(st.mc);
    st.file = null; st.suggest = null; setDirty(false);
    render();
  }

  // the Import button of the app bar (app.js, export.js): a Koala or Art Studio picture of this
  // computer becomes a new picture - not in the project until it is saved (Save offers its name).
  // A Yopaca picture (.ybm, ybm.js) brings its reference image along, placed as it was
  async function importPicture(bytes, name) {
    const ybm = isYbm(bytes) ? decodeYbm(bytes) : null;
    if (ybm) bytes = ybm.picture;
    const mc = bytes.length === KOALA_SIZE;
    if (!mc && bytes.length !== ART_SIZE) throw new Error(tr('§1952', bytes.length, KOALA_SIZE, ART_SIZE));
    if (!(await mayDiscard('§1003'))) return;
    decode(bytes);
    st.file = null; st.suggest = `${LAYOUT.bitmap}/${importName(name, 'picture')}.${mc ? 'kla' : 'art'}`;
    setDirty(true);
    if (ybm) await reference.restore(ybm.image && { ...ybm.image, reference: ybm.reference });
    render();
    snackbar(tr(ybm?.image ? '§2118' : '§1953', name, mc ? '§1011' : '§1010'));
  }
  const importFormats = () => (!isOpen() ? [] : [
    { label: '§1002', icon: 'wallpaper', accept: '.kla,.koa', open: importPicture },
    { label: '§0991', icon: 'wallpaper', accept: '.art', open: importPicture },
    { label: '§2117', icon: 'wallpaper', accept: '.ybm', open: importPicture },
  ]);

  // hires <-> multicolor like the VIC's multicolor bit: the bitmap and the screen memory stay, they
  // are read the other way. A multicolor pixel is the two hires pixels of its bits - 11 two set
  // pixels, 10 set and clear, 01 clear and set, 00 two clear ones - and the two colors of a hires
  // block are its screen byte: set pixels the high nibble (multicolor 01), clear ones the low
  // nibble (multicolor 10). What only multicolor shows - the color RAM (11) and the background -
  // stays in hires unused (the third slot, st.bg), so switching back gives the same picture
  function converted(mc) {
    const pix = Array.from({ length: ph() }, () => new Uint8Array(mc ? 160 : 320));
    st.pix.forEach((row, y) => {
      for (let x = 0; x < 160; x++) {
        if (mc) pix[y][x] = row[2 * x] << 1 | row[2 * x + 1];
        else { pix[y][2 * x] = row[x] >> 1; pix[y][2 * x + 1] = row[x] & 1; }
      }
    });
    // the color RAM of a hires picture: that of the set pixels, so 11 shows like two set pixels
    const slots = st.slots.map(sl => [sl[0], sl[1], sl[2] ?? sl[0]]);
    return { pix, slots, bg: st.bg, mc };
  }

  function setMode(mc) {
    if (!st.pix || mc === st.mc) return;
    snapshot();
    Object.assign(st, converted(mc));
    st.penColor = [mc ? st.bg : st.penColor[0], st.penColor[1]];
    st.pen = 1;
    st.sel = null; setDirty(true);
    render();
  }

  // --- undo ------------------------------------------------------------------------------------

  const copy = () => ({ pix: st.pix.map(r => r.slice()), slots: st.slots.map(s => [...s]), bg: st.bg, mc: st.mc, penColor: [...st.penColor] });
  // state: the picture as it was, taken earlier (a stroke that may change nothing takes its step
  // when it does)
  function snapshot(state = copy()) {
    st.undo.push(state);
    if (st.undo.length > UNDO_LIMIT) st.undo.shift();
    st.redo = [];
    if (!st.dirty) { setDirty(true); update(); }
  }
  function restore(from, to) {
    const s = from.pop();
    if (!s) return;
    to.push(copy());
    const modeChange = s.mc !== st.mc;
    Object.assign(st, { pix: s.pix, slots: s.slots, bg: s.bg, mc: s.mc, penColor: s.penColor, sel: null });
    setDirty(true);                      // the picture differs from its file again (an undo after a save)
    draw(); status(); update();
  }

  // --- painting --------------------------------------------------------------------------------

  // how many pixels of a multicolor block show each value: which of its three slots are in use
  function valueCounts(c, r) {
    const n = [0, 0, 0, 0];
    for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) n[st.pix[r * 8 + y][c * 4 + x]]++;
    return n;
  }

  // cells: {x, y} pixels; pen: 0 background, 1 color. Hires: the pixel's bit is the pen, and the
  // block's slot of the pen takes the pen's color (its other pixels of that pen change with it).
  // Multicolor: the background clears the pixel; the color uses the block's slot that holds it, a
  // free slot, or - three other colors in the block - leaves the pixel alone (a clash)
  function paintPixels(cells, pen) {
    const w = pw(), hgt = ph(), color = st.penColor[pen];
    for (const p of cells) {
      if (p.x < 0 || p.y < 0 || p.x >= w || p.y >= hgt) continue;
      const c = cellOf(p), k = c.r * COLS + c.c, slots = st.slots[k];
      if (!st.mc) {
        st.pix[p.y][p.x] = pen;
        const slot = pen ? 0 : 1;
        if (slots[slot] !== color) { slots[slot] = color; st.recolored++; }
      } else if (!pen || color === st.bg) {
        st.pix[p.y][p.x] = 0;
      } else {
        let v = slots.indexOf(color) + 1;
        if (!v) {
          const under = st.pix[p.y][p.x], n = valueCounts(c.c, c.r);
          n[under]--;                                    // this pixel is repainted: its slot is free when no other pixel shows it
          const free = [1, 2, 3].find(i => !n[i]);
          if (free) v = free;
          else if (under) { v = under; st.recolored++; }   // a full block: the slot painted over takes the color, all its pixels with it
          else { st.clashes++; continue; }               // over the background, which is the picture's: no slot for a fourth color
          slots[v - 1] = color;
        }
        st.pix[p.y][p.x] = v;
      }
    }
    draw();
  }

  function floodCells(start, value) {
    const w = pw(), hgt = ph();
    const from = st.pix[start.y][start.x];
    const colorAt = p => { const c = cellOf(p); return pixelColor(st.pix[p.y][p.x], c.r * COLS + c.c); };
    const fromColor = colorAt(start);
    if (fromColor === st.penColor[value]) return [];
    const same = p => st.pix[p.y][p.x] === from && colorAt(p) === fromColor;
    const seen = new Set([`${start.x},${start.y}`]), out = [], queue = [start];
    while (queue.length) {
      const p = queue.pop();
      out.push(p);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = { x: p.x + dx, y: p.y + dy }, key = `${n.x},${n.y}`;
        if (n.x < 0 || n.y < 0 || n.x >= w || n.y >= hgt || seen.has(key) || !same(n)) continue;
        seen.add(key);
        queue.push(n);
      }
    }
    return out;
  }

  const dragTool = () => DRAG_TOOLS.has(st.tool);
  // the pixels the brush paints along cells (drawtools.js), with the tools that draw with it
  const brushGrid = () => ({ aspect: st.mc ? 2 : 1, w: pw(), h: ph() });
  const brushed = cells => (BRUSH_TOOLS.has(st.tool) ? brushCells(cells, st.brush, brushGrid()) : cells);
  // inside the picture: the curve may reach beyond it
  const dragCells = d => brushed(dragXY(st.tool, d.start, d.end, { ...d, aspect: st.mc ? 2 : 1, radius: st.radius })).filter(p => p.x >= 0 && p.y >= 0 && p.x < pw() && p.y < ph());

  // --- antialiasing (aa.js) ---------------------------------------------------------------------

  // the pencil, line, box, circle and curve, with the color pen: the background pen paints as it is
  const aaOn = value => st.aa && value === 1 && AA_TOOLS.has(st.tool);
  // how much of each pixel the shape covers, with the brush: [{x, y, cov}]. The pixels the tool draws
  // without antialiasing stay whole (core): the line keeps its shape and its color, the shades go
  // around it, most where it steps
  function aaCover(tool, a, b, mods, core) {
    const cov = coverage(aaShape(tool, a, b, { ...mods, aspect: st.mc ? 2 : 1 }),
      { brush: st.brush, size: Math.min(st.brush.size, brushMax(brushGrid())), aspect: st.mc ? 2 : 1, w: pw(), h: ph() });
    const whole = new Set(core.map(p => p.y * 320 + p.x));
    return [...core.map(p => ({ x: p.x, y: p.y, cov: 1 })), ...cov.filter(p => !whole.has(p.y * 320 + p.x))];
  }

  // paint covered pixels: fully covered ones - or those whose shade is the pen - with the color pen and
  // its rules, the others in their shade where the block has room for it. stroke: coverage already
  // painted in this stroke (key -> cov), a pixel is painted again only when it is covered more
  function paintAA(list, stroke) {
    const [bg, pen] = st.penColor, core = [], shades = [];
    for (const p of list) {
      const key = p.y * 320 + p.x, before = stroke.get(key);
      if (before !== undefined && p.cov <= before) continue;
      const c = shadeOf(p.cov, pen, bg);
      if (c === bg) continue;
      stroke.set(key, p.cov);
      if (c === pen) core.push(p); else shades.push({ ...p, color: c, own: before !== undefined });
    }
    if (core.length) paintPixels(core, 1);
    for (const p of shades) paintShade(p, p.color, p.own);
    draw();
  }

  // a pixel of an edge in its shade: over the background only (or a shade of this stroke: own), in a
  // slot that holds the color or one that no other pixel of the block shows - a shade recolors nothing
  function paintShade(p, color, own) {
    const c = cellOf(p), k = c.r * COLS + c.c, slots = st.slots[k], v0 = st.pix[p.y][p.x];
    if (v0 && !own) return;
    if (!st.mc) {
      if (slots[0] !== color) {
        for (let y = c.r * 8; y < c.r * 8 + 8; y++) for (let x = c.c * 8; x < c.c * 8 + 8; x++) if (st.pix[y][x] && (x !== p.x || y !== p.y)) return;
        slots[0] = color;
      }
      st.pix[p.y][p.x] = 1;
      return;
    }
    let v = slots.indexOf(color) + 1;
    if (!v) {
      const n = valueCounts(c.c, c.r);
      n[v0]--;
      v = [1, 2, 3].find(i => !n[i]);
      if (!v) return;
      slots[v - 1] = color;
    }
    st.pix[p.y][p.x] = v;
  }

  // the range tools: the range selected with S, else the whole picture; the cell colors stay
  // the tools that move pixels: they move colors, not the values of the pixels - a value is a slot
  // of its block, and in another block the slot holds another color (or the background)
  const MOVES = new Set(['left', 'right', 'up', 'down', 'mirror', 'flip', 'rotl', 'rotr', 'rotate']);   // on the colors, the blocks take them again

  // the four shifts: with Shift a whole block (8 x 8 pixels, multicolor 4 x 8)
  const SHIFTS = new Set(['left', 'right', 'up', 'down']);
  const blockStep = op => (op === 'left' || op === 'right' ? (st.mc ? 4 : 8) : 8);

  function applyRange(op, { block = false, confirmed = false } = {}) {
    if (!st.pix) return;
    if (op === 'rotate') return rot.start();          // turned in space: the section of the turn
    rot.stop(false);
    if (op === 'clear' && !confirmed) {             // asks first: the range or the whole picture
      const what = st.sel ? tr('§1470', st.sel.w, st.sel.h) : tr('§1471', st.file ?? tr('§1472'));
      confirmRemove({ what, kind: 'clear:bitmap', verb: 'clear' }).then(ok => ok && applyRange(op, { block, confirmed: true }));
      return;
    }
    if (MOVES.has(op)) return moveRange(op, block && SHIFTS.has(op) ? blockStep(op) : 1);
    const grid = st.pix.map(r => [...r]);
    const res = regionOp(grid, op, st.sel, { blank: 0, invert: v => (st.mc ? 3 - v : 1 - v), resize: !!st.sel });
    if (!res) return snackbar('§0635', { error: true });
    snapshot();
    st.pix = res.grid.map(r => Uint8Array.from(r));
    if (op === 'clear') clearBlocks(st.sel ? clipRect(st.sel, pw(), ph()) : { x: 0, y: 0, w: pw(), h: ph() });
    if (st.sel) st.sel = res.rect;
    draw(); status();
  }

  // the colors of the pixels move; the blocks the range touches (before and after) take them again
  // (recode). BACK: a pixel a rotation leaves - the background of its block
  const BACK = -1;
  // times: the op again and again before the blocks take the colors - a whole block moves whole
  // more: the turn and the aspect of 'rotate' (regionOp); undoable false: a preview, no undo step
  function moveRange(op, times = 1, more = {}, undoable = true) {
    const bw = st.mc ? 4 : 8;
    const colors = st.pix.map((row, y) => Array.from(row, (v, x) => pixelColor(v, (y >> 3) * COLS + Math.floor(x / bw))));
    let res = regionOp(colors, op, st.sel, { blank: BACK, resize: !!st.sel, ...more });
    if (!res) return snackbar('§0635', { error: true });
    for (let n = 1; n < times; n++) res = regionOp(res.grid, op, st.sel, { blank: BACK, resize: !!st.sel });
    if (undoable) snapshot();
    st.recolored = 0; st.clashes = 0; st.lost = 0;
    const from = st.sel ? clipRect(st.sel, pw(), ph()) : { x: 0, y: 0, w: pw(), h: ph() };
    const areas = [from, st.sel || op === 'rotate' ? res.rect : null].filter(Boolean);
    const c0 = Math.min(...areas.map(a => Math.floor(a.x / bw))), c1 = Math.max(...areas.map(a => Math.floor((a.x + a.w - 1) / bw)));
    const r0 = Math.min(...areas.map(a => a.y >> 3)), r1 = Math.max(...areas.map(a => (a.y + a.h - 1) >> 3));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) recode(c, r, res.grid);
    if (st.sel) st.sel = res.rect;
    draw(); status();
  }

  // Ctrl+C: the range selected with S, else the whole picture - as the colors of its pixels: a
  // value is a slot of its block, the color is what the pixel shows
  function copyRange() {
    if (!st.pix) return;
    const r = st.sel ? clipRect(st.sel, pw(), ph()) : { x: 0, y: 0, w: pw(), h: ph() };
    if (!r) return;
    const bw = st.mc ? 4 : 8;
    const grid = st.pix.slice(r.y, r.y + r.h).map((row, j) => Array.from(row.subarray(r.x, r.x + r.w), (v, i) => pixelColor(v, ((r.y + j) >> 3) * COLS + Math.floor((r.x + i) / bw))));
    st.clip = { ...r, grid, mc: st.mc };
    snackbar(st.sel ? tr('§2119', r.w, r.h) : '§2120');
  }

  // Ctrl+V: the copy at the range selected now (its top left corner), else where it was copied
  // from; what does not fit is cut off. The blocks it lands on take the colors again (recode), as
  // after a move. One undo step; the pasted part is the range then
  function pasteRange() {
    const cl = st.clip;
    if (!st.pix) return;
    if (!cl) return snackbar('§2121');
    if (cl.mc !== st.mc) return snackbar(tr('§2122', cl.mc ? '§1011' : '§1010', cl.mc ? '§1010' : '§1011'), { error: true });
    rot.stop(false);
    const x0 = st.sel?.x ?? cl.x, y0 = st.sel?.y ?? cl.y;
    const to = clipRect({ x: x0, y: y0, w: cl.w, h: cl.h }, pw(), ph());
    if (!to) return snackbar('§2123', { error: true });
    snapshot();
    st.recolored = 0; st.clashes = 0; st.lost = 0;
    const bw = st.mc ? 4 : 8;
    const colors = st.pix.map((row, y) => Array.from(row, (v, x) => pixelColor(v, (y >> 3) * COLS + Math.floor(x / bw))));
    for (let y = to.y; y < to.y + to.h; y++) for (let x = to.x; x < to.x + to.w; x++) colors[y][x] = cl.grid[y - y0][x - x0];
    for (let r = to.y >> 3; r <= (to.y + to.h - 1) >> 3; r++) for (let c = Math.floor(to.x / bw); c <= Math.floor((to.x + to.w - 1) / bw); c++) recode(c, r, colors);
    st.sel = to;
    draw(); status();
    snackbar(tr('§2124', to.w, to.h, to.x, to.y));
  }

  // the smooth tool: antialiasing under its brush (aa.js edgeCover) - a background pixel in a
  // corner of an edge takes the C64 color between the drawn color and its background, as a shade
  // of the pen does (paintShade: only in a slot the block has free, so in hires only in a block of
  // its own). d.shaded: the shades of this stroke. The undo step is taken with the first shade -
  // a stroke that shades nothing (hires, a full block) leaves no empty step behind
  function smoothPixels(cells, d) {
    const bw = st.mc ? 4 : 8, w = pw(), h = ph(), block = (x, y) => (y >> 3) * COLS + Math.floor(x / bw);
    const colors = st.pix.map((row, y) => Array.from(row, (v, x) => pixelColor(v, block(x, y))));
    const before = d.snapped ? null : copy();
    for (const e of edgeCover(colors, cells, { isBg: (v, x, y) => !st.pix[y][x], w, h, skip: d.shaded })) {
      const bg = colors[e.y][e.x], color = shadeOf(e.cov, e.fg, bg);
      if (color === bg || color === e.fg) continue;
      paintShade(e, color, false);
      if (!st.pix[e.y][e.x]) continue;
      d.shaded.add(e.y * w + e.x);
      if (!d.snapped) { snapshot(before); d.snapped = true; }
    }
  }

  // a block from the colors of its pixels: multicolor - the background and the three colors most
  // pixels show, hires - the two; a color keeps the slot it had. What does not fit takes the
  // background of the block (st.lost counts it)
  function recode(c, r, colors) {
    const bw = st.mc ? 4 : 8, k = r * COLS + c, slots = st.slots[k];
    const back = st.mc ? st.bg : slots[1];
    const at = (x, y) => { const v = colors[r * 8 + y][c * bw + x]; return v === BACK ? back : v; };
    const count = new Map();
    for (let y = 0; y < 8; y++) for (let x = 0; x < bw; x++) {
      const v = at(x, y);
      if (!st.mc || v !== st.bg) count.set(v, (count.get(v) ?? 0) + 1);
    }
    const n = st.mc ? 3 : 2;
    const kept = [...count.keys()].sort((a, b) => count.get(b) - count.get(a) || slots.indexOf(b) - slots.indexOf(a)).slice(0, n);
    // the colors that are in their slot stay there, the others take the slots left
    const next = [...slots], taken = new Set();
    for (const col of kept) { const i = slots.indexOf(col); if (i >= 0) { next[i] = col; taken.add(i); } }
    for (const col of kept) {
      if (next.some((x, i) => x === col && taken.has(i))) continue;
      const i = next.findIndex((_, j) => !taken.has(j));
      next[i] = col; taken.add(i);
    }
    // hires with one color: it is the background of the block
    if (!st.mc && kept.length === 1 && next[1] !== kept[0]) { next[1] = kept[0]; next[0] = slots[0]; }
    st.slots[k] = next;
    for (let y = 0; y < 8; y++) for (let x = 0; x < bw; x++) {
      const col = at(x, y);
      let v;
      if (st.mc) v = col === st.bg ? 0 : next.indexOf(col) + 1;
      else v = col === next[1] ? 0 : col === next[0] ? 1 : -1;
      if (v < 0 || (st.mc && v === 0 && col !== st.bg)) { st.lost++; v = 0; }
      st.pix[r * 8 + y][c * bw + x] = v;
    }
  }

  // clear: the screen RAM and the color RAM of the blocks the range covers whole go to 0 as well;
  // a block the range only cuts keeps its colors, its pixels outside the range still show them
  function clearBlocks(area) {
    if (!area) return;
    const bw = st.mc ? 4 : 8;
    const c0 = Math.ceil(area.x / bw), c1 = Math.floor((area.x + area.w) / bw);
    const r0 = Math.ceil(area.y / 8), r1 = Math.floor((area.y + area.h) / 8);
    for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) st.slots[r * COLS + c].fill(0);
  }

  // --- mouse and keys -----------------------------------------------------------------------------

  // the pixel under the pointer, the nearest one of the picture outside it; free: the pixel outside as well
  function pixelAt(e, free = false) {
    const r = ui.canvas.getBoundingClientRect();
    const s = st.cell;
    const x = Math.floor((e.clientX - r.left) / (s * (st.mc ? 2 : 1)));
    const y = Math.floor((e.clientY - r.top) / s);
    if (free) return { x, y };
    return { x: Math.max(0, Math.min(pw() - 1, x)), y: Math.max(0, Math.min(ph() - 1, y)) };
  }

  function onDown(e) {
    rot.stop(false);                                 // painting ends a turn that was not applied
    if (!ui || !st.pix || e.button === 1) return;
    e.preventDefault();
    ui.canvas.setPointerCapture(e.pointerId);
    ui.wrap.focus({ preventScroll: true });
    if (st.tool === 'hand') {                 // the canvas box scrolls, the picture stays as it is
      st.pan = { x: e.clientX, y: e.clientY, left: ui.wrap.scrollLeft, top: ui.wrap.scrollTop };
      return;
    }
    const p = pixelAt(e);
    if (waits(st.drag)) { strokeDown(st.drag, pixelAt(e, true), e); draw(); return; }   // the bend of a curve, a corner of a polygon
    const value = e.button === 2 ? 0 : fgValue();
    if (st.tool === 'pick') {
      const v = st.pix[p.y][p.x], c = cellOf(p), k = c.r * COLS + c.c;
      st.pen = v ? 1 : 0;                               // the pixel's pen, with its color
      if (v) st.penColor[1] = st.mc ? st.slots[k][v - 1] : st.slots[k][0];
      else if (!st.mc) st.penColor[0] = st.slots[k][1];
      setTool('pencil'); return;
    }
    if (st.tool === 'select') { st.drag = { start: p, end: p, shift: e.shiftKey }; draw(); return; }
    if (!WAIT_TOOLS.has(st.tool) && st.tool !== 'smooth') snapshot();   // the curve and the polygon when they draw, the smoother with its first shade: a stroke of nothing is no step
    st.recolored = 0; st.clashes = 0; st.lost = 0;  // counted over the whole stroke
    if (st.tool === 'pencil') {
      st.drag = { last: p, value, aa: aaOn(value) ? new Map() : null };
      if (st.drag.aa) paintAA(aaCover('line', p, p, {}, brushed([p])), st.drag.aa); else paintPixels(brushed([p]), value);
    }
    else if (st.tool === 'smooth') { st.drag = { last: p, shaded: new Set() }; smoothPixels(brushed([p]), st.drag); }
    else if (dragTool()) { st.drag = { start: p, end: p, value, ...dragMods(e), aa: aaOn(value) }; draw(); }
    else if (st.tool === 'fill') paintPixels(floodCells(p, value), value);
    status();
  }

  // the border of the pixel cursor fades while the pointer is over the picture: a redraw every few frames
  let pulse = 0;
  function pulsing() {
    pulse = 0;
    if (!st.hover || st.tool === 'hand') return;
    draw();
    pulse = setTimeout(pulsing, 50);
  }

  function onMove(e) {
    if (!ui || !st.pix) return;
    if (st.pan) {
      ui.wrap.scrollLeft = st.pan.left - (e.clientX - st.pan.x);
      ui.wrap.scrollTop = st.pan.top - (e.clientY - st.pan.y);
      return;
    }
    const p = pixelAt(e);
    const d = st.drag;
    if (d && WAIT_TOOLS.has(st.tool)) {   // beyond the picture as well: dragCells clips the curve or the polygon
      const at = pixelAt(e, true), q = d.bend ?? d.end;
      st.hover = p;
      if (at.x !== q.x || at.y !== q.y) { dragTo(d, at, e); draw(); status(); }
      return;
    }
    if (!pulse) pulse = setTimeout(pulsing, 50);
    if (st.hover?.x === p.x && st.hover?.y === p.y) return;
    st.hover = p;
    if (d && st.tool === 'pencil' && d.aa) { paintAA(aaCover('line', d.last, p, {}, brushed(lineCells(d.last, p))), d.aa); d.last = p; }
    else if (d && st.tool === 'pencil') { paintPixels(brushed(lineCells(d.last, p).slice(1)), d.value); d.last = p; }   // from the last pixel on, which is painted
    else if (d && st.tool === 'smooth') { smoothPixels(brushed(lineCells(d.last, p)), d); d.last = p; }
    else if (d) dragTo(d, p, e);
    draw(); status();
  }

  function onUp() {
    st.pan = null;
    const d = st.drag;
    st.drag = null;
    if (!d) return;
    if (curveWaits(st.tool, d)) { st.drag = d; draw(); return; }
    if (WAIT_TOOLS.has(st.tool)) snapshot();
    if (dragTool() && d.aa) paintAA(aaCover(st.tool, d.start, d.end, d, dragCells(d)), new Map());
    else if (dragTool()) paintPixels(dragCells(d), d.value);
    if (st.tool === 'select') st.sel = d.start.x === d.end.x && d.start.y === d.end.y && !d.shift ? null : selRect(d);
    draw(); status();
  }

  // the range being selected: with Shift the whole blocks it touches
  function selRect(d) {
    if (!d.shift) return rectBetween(d.start, d.end);
    const bw = st.mc ? 4 : 8;
    const x = Math.floor(Math.min(d.start.x, d.end.x) / bw) * bw, y = Math.min(d.start.y, d.end.y) & ~7;
    const x1 = (Math.floor(Math.max(d.start.x, d.end.x) / bw) + 1) * bw, y1 = (Math.max(d.start.y, d.end.y) | 7) + 1;
    return { x, y, w: Math.min(pw(), x1) - x, h: Math.min(ph(), y1) - y };
  }

  // Shift pressed or let go while a range is dragged: blocks or pixels from now on
  const shiftKey = e => {
    if (e.key !== 'Shift' || st.tool !== 'select' || !st.drag || st.drag.shift === (e.type === 'keydown')) return;
    st.drag.shift = e.type === 'keydown';
    draw(); status();
  };
  addEventListener('keydown', shiftKey);
  addEventListener('keyup', shiftKey);

  function onKey(e) {
    if (e.target.closest('input, select, textarea')) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && !e.shiftKey && !e.altKey && (key === 'c' || key === 'v')) { if (key === 'c') copyRange(); else pasteRange(); e.preventDefault(); return; }
    if (mod || e.altKey) return;
    const tool = toolForKey(TOOLS, key);
    const op = rangeForKey(RANGE, e);
    if (tool) setTool(tool);
    else if (op) applyRange(op, { block: e.shiftKey });
    else if (e.key === '1' || e.key === '2') { st.pen = Number(e.key) - 1; update(); draw(); }   // keys 1-2: the pens; the pixel under the pointer in its color
    else if (e.key === 'Escape') cancel();
    else if (e.key === '+') zoom(1);
    else if (e.key === '-') zoom(-1);
    else return;
    e.preventDefault();
  }

  function setTool(tool) {
    if (waits(st.drag)) st.drag = null;   // a curve or a polygon not drawn yet is dropped
    st.tool = tool;
    update();
    draw();
  }

  function zoom(dir) {
    const k = Math.max(0, Math.min(ZOOM.length - 1, ZOOM.indexOf(st.cell) + dir));
    if (ZOOM[k] === st.cell) return;
    st.cell = ZOOM[k];
    draw();
  }

  // --- drawing ---------------------------------------------------------------------------------

  function draw() {
    if (!ui) return;
    const cv = ui.canvas, ctx = cv.getContext('2d');
    if (!st.pix) { cv.width = cv.height = 0; return; }
    const s = st.cell, w = pw(), hgt = ph(), px = st.mc ? 2 : 1;
    img ??= document.createElement('canvas');
    img.width = 320; img.height = hgt;
    const ictx = img.getContext('2d');
    const id = ictx.createImageData(320, hgt);
    const d = id.data;
    const pal = PALETTE.map(rgb);
    for (let y = 0; y < hgt; y++) {
      const row = st.pix[y], r = y >> 3;
      for (let x = 0; x < w; x++) {
        const k = r * COLS + Math.floor(x / (st.mc ? 4 : 8));
        const [R, G, B] = pal[pixelColor(row[x], k) & 15];
        for (let q = 0; q < px; q++) {
          const o = (y * 320 + x * px + q) * 4;
          d[o] = R; d[o + 1] = G; d[o + 2] = B; d[o + 3] = 255;
        }
      }
    }
    ictx.putImageData(id, 0, 0);
    cv.width = 320 * s; cv.height = hgt * s;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    const dg = st.drag;
    if (dg && dragTool() && dg.aa) {     // antialiased: each pixel in its shade (the blocks decide when it is drawn)
      const [bg, pen] = st.penColor;          // the pens: [background, color]
      for (const p of aaCover(st.tool, dg.start, dg.end, dg, dragCells(dg))) {
        const c = shadeOf(p.cov, pen, bg);
        if (c !== bg) { ctx.fillStyle = PALETTE[c]; ctx.fillRect(p.x * px * s, p.y * s, px * s, s); }
      }
    } else if (dg && dragTool()) {       // the preview of a drag tool, in the pen color
      ctx.fillStyle = PALETTE[st.penColor[dg.value] & 15];
      for (const p of dragCells(dg)) if (p.x >= 0 && p.y >= 0 && p.x < w && p.y < hgt) ctx.fillRect(p.x * px * s, p.y * s, px * s, s);
    }
    reference.draw(ctx, s, true);
    if (st.grid && s >= 3) {             // the cells: 8 x 8 pixels, multicolor 4 x 8 double wide ones
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = 1; c < COLS; c++) { ctx.moveTo(c * 8 * s + 0.5, 0); ctx.lineTo(c * 8 * s + 0.5, cv.height); }
      for (let r = 1; r < ROWS; r++) { ctx.moveTo(0, r * 8 * s + 0.5); ctx.lineTo(cv.width, r * 8 * s + 0.5); }
      ctx.stroke();
    }
    const range = dg && st.tool === 'select' ? selRect(dg) : st.sel;
    if (range) {
      const a = clipRect(range, w, hgt);
      if (a) {
        ctx.strokeStyle = '#fff'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
        ctx.strokeRect(a.x * px * s + 0.5, a.y * s + 0.5, a.w * px * s - 1, a.h * s - 1);
        ctx.setLineDash([]);
      }
    }
    cv.classList.toggle('screen-canvas--hand', st.tool === 'hand');
    cv.classList.toggle('screen-canvas--pixels', st.tool !== 'hand');      // no mouse cursor: the pixel cursor is the only one
    if (st.hover && st.tool !== 'hand') {
      // the pixel under the pointer, while a drag lasts too: a tool that paints shows it in the
      // color of the selected pen (not over the preview of a drag), with a border that fades from
      // black to white and back, so it shows on any color
      const paints = st.tool !== 'select' && st.tool !== 'pick' && !dg;
      const covers = brushed([st.hover]).filter(q => q.x >= 0 && q.y >= 0 && q.x < pw() && q.y < ph());
      if (paints) { ctx.fillStyle = PALETTE[st.penColor[st.pen] & 15]; covers.forEach(q => ctx.fillRect(q.x * px * s, q.y * s, px * s, s)); }
      const v = Math.round(127.5 - 127.5 * Math.cos(Date.now() / PULSE_MS * 2 * Math.PI));
      ctx.strokeStyle = `rgb(${v}, ${v}, ${v})`; ctx.lineWidth = 1;
      outlineCells(ctx, covers, px * s, s);   // the brush in its shape, size and pixel width
    }
  }

  function status() {
    if (!ui || !st.pix) return;
    const p = st.hover;
    const parts = [`${st.mc ? 'multicolor 160 × 200' : 'hires 320 × 200'}${st.dirty ? ' · changed' : ''}`];
    if (p) {
      const c = cellOf(p), s = st.slots[c.r * COLS + c.c];
      parts.push(`pixel ${p.x},${p.y} · block ${c.c},${c.r}: ${s.slice(0, st.mc ? 3 : 2).map((v, i) => `${st.mc ? i + 1 : (i ? 'bg' : 'fg')} ${COLOR_NAMES[v & 15]}`).join(', ')}`);
    }
    if (st.sel) parts.push(`range ${st.sel.w} × ${st.sel.h}`);
    if (st.recolored) parts.push(`${st.recolored} block${st.recolored > 1 ? 's' : ''} recolored`);
    if (st.clashes) parts.push(`${st.clashes} pixel${st.clashes > 1 ? 's' : ''} not painted: the block already shows three other colors`);
    if (st.lost) parts.push(tr('§1954', st.lost, st.lost > 1 ? 's' : ''));
    statusLine.value = parts.join(' · ');
  }

  // --- the side panel: the pens and the colors -----------------------------------------------

  function sideView() {
    const key = pen => ` (key ${pen + 1})`;
    // the background row colors the whole picture: multicolor the register, hires the background
    // slot of every block (the clear pixels); set pixels keep their colors
    const pick = pen => k => {
      snapshot();
      st.penColor[pen] = k;
      if (pen === 0) { if (st.mc) st.bg = k; else st.slots.forEach(sl => { sl[1] = k; }); }
      draw(); update(); status();
    };
    const row = (label, pen, tip) => ({ label, color: st.penColor[pen], active: st.pen === pen, tip: tip + key(pen),
      onselect: () => { st.pen = pen; update(); draw(); }, onpick: pick(pen) });
    const rows = st.mc ? [
      row('§0636', 0, '§1120'),
      row('§0637', 1, '§1119'),
    ] : [
      row('§0636', 0, '§0950'),
      row('§0637', 1, '§0638'),
    ];
    return [rot.on && section('§1731', rot.view(), rot.actions()), section('§0639', [
        h('div', { class: 'section__hint' }, st.mc
          ? '§0951'
          : '§0640'),
        colorChooser(rows)]), reference.panel()];
  }

  // --- the view ----------------------------------------------------------------------------------

  // the canvas and what holds it are made once and drawn on; the views show them (pui.dom)
  function canvasOnce() {
    if (ui) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'screen-canvas';
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', () => { st.hover = null; clearTimeout(pulse); pulse = 0; draw(); });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    const wrap = document.createElement('div');
    wrap.className = 'screen-canvas-wrap sprite-wrap';
    wrap.tabIndex = 0;
    wrap.addEventListener('keydown', onKey);
    wrap.append(canvas);
    wheelZoom(wrap, () => ui?.canvas, zoom);   // the wheel zooms
    reference.attach(wrap);
    ui = { canvas, wrap };
  }

  const barView = () => !isOpen() ? null : h('div', { class: 'screen-bar' },
    h('span', { class: 'md-title-medium' }, 'Bitmap'),
    h('span', { class: 'screen-bar__sep' }),
    select({ label: '§0641', hideLabel: true, value: st.file ?? '', dense: true, cls: 'screen-bar__sprite',
      // the open picture is the first option and carries its own path, so the select shows its name
      options: [{ value: st.file ?? '', label: st.file ?? (st.suggest ? tr('§1004', st.suggest) : '§0642') }, ...st.files.filter(f => f !== st.file).map(f => ({ value: f, label: f }))],
      onchange: v => { if (v) openFile(v); } }),
    iconButton('add', '§0633', newPicture),
    h('span', { class: 'screen-bar__sep' }),
    defaults(),
    h('span', { class: 'screen-bar__sep' }),
    brush(),
    antialias(),
    h('div', { class: 'app-bar__spacer' }));

  // what the Export button of the app bar offers here (app.js): the picture as it is edited, Koala
  // or Art Studio (its mode), the same with its reference image (.ybm), or a PNG of its 320 x 200 pixels
  function exportFormats() {
    if (!isOpen() || !st.pix) return [];
    const ext = st.mc ? 'kla' : 'art', name = st.file ?? 'picture';
    return [
      { label: st.mc ? '§0990' : '§0991', name: exportName(name, ext), description: 'C64 picture', bytes: encode },
      { label: '§2116', icon: 'wallpaper', name: exportName(name, 'ybm'), description: 'Yopaca picture',
        bytes: () => { const r = reference.bundle(); return encodeYbm({ picture: encode(), format: ext, image: r && { bytes: r.bytes, type: r.type }, reference: r?.reference }); } },
      // a program the C64 runs: LOAD and RUN show the picture until a key is pressed (bitmapprg.js)
      { label: '§0992', icon: 'play_arrow', name: exportName(name, 'prg'), description: 'C64 program',
        bytes: () => { const b = encode();
          return bitmapPrg({ bitmap: b.subarray(2, 8002), screen: b.subarray(8002, 9002), colors: st.mc ? b.subarray(9002, 10002) : null, bg: st.mc ? st.bg : 0, mc: st.mc }); } },
      { label: '§1016', icon: 'wallpaper', name: exportName(name, 'png'), type: 'image/png', description: 'PNG picture',
        bytes: () => { draw(); return pngOf(img); } },
    ];
  }

  // the range tools; multicolor turns the double wide pixels, as the sprites do: the range stretches
  const stretch = '§1955';
  const block = '§1956';
  const range = () => ({ keys: RANGE, run: (op, e) => applyRange(op, { block: !!e?.shiftKey }), note: '§1957',
    more: { left: block, right: block, up: block, down: block, ...(st.mc ? { rotl: stretch, rotr: stretch } : {}) } });
  const defaults = () => defaultTools({
    undo: () => restore(st.undo, st.redo), redo: () => restore(st.redo, st.undo), zoom,
    grid: { on: st.grid, toggle: () => { st.grid = !st.grid; update(); draw(); } },
    multicolor: { on: st.mc, toggle: () => setMode(!st.mc) },
    clear: { tip: '§0827', run: () => applyRange('clear') },
  });
  // the antialiasing switch, next to the brush: for the tools that draw lines and shapes
  const antialias = () => iconButton('blur_on',
    '§0624',
    () => { st.aa = !st.aa; update(); draw(); }, st.aa ? 'md-icon-button--selected' : '',
    { 'data-aa': '', 'aria-pressed': String(st.aa), disabled: !AA_TOOLS.has(st.tool) });
  const brush = () => [brushTools({ brush: st.brush, tool: st.tool, max: brushMax(brushGrid()), onchange: b => { st.brush = b; update(); draw(); } }),
    radiusTools({ radius: st.radius, tool: st.tool, max: radiusMax(brushGrid()), onchange: v => { st.radius = v; update(); draw(); } })];

  const StatusLine = () => h('span', { class: 'md-body-small screen-status' }, statusLine.value);

  const bodyView = () => !isOpen() ? null : h('div', { class: 'screen-body' },
    h('div', { class: 'screen-main' }, paintArea({ tools: TOOLS, current: st.tool, onselect: setTool, range: range() }, dom(ui.wrap)), h('div', { class: 'screen-foot' }, h(StatusLine, {}))),
    sidePanel('Bitmap', sideView()));

  function render() {
    if (isOpen()) {
      if (!st.pix) blank(false);
      canvasOnce();
    }
    views ??= [mount(bar, barView), mount(el, bodyView)];
    update();
    if (!isOpen()) return;                  // no project: nothing to paint, like screen and sprites
    actions.route?.();            // the address follows what is open (app.js)
    draw();
    status();
  }

  // open a picture; without one the first picture of the project (pictures/*.kla ...) is shown
  async function open(file = null) {
    if (!isOpen()) return render();
    await listFiles();
    if (!file && !st.pix && !st.file) file = st.files.find(f => /\.(kla|koa)$/i.test(f)) ?? st.files[0] ?? null;
    if (file && file !== st.file) return openFile(file);
    render();
  }

  followCurve(() => ui, () => WAIT_TOOLS.has(st.tool) && waits(st.drag), onMove, onDown,
    () => { if (closePolygon(st.drag)) onUp(); });   // Enter: the polygon closes and draws

  // Ctrl+Z and Ctrl+Y come from app.js wherever the focus is in the view - a range button just
  // clicked has it, not the canvas
  // the changed picture into its file, for the Save of the app bar: a new picture, or one whose
  // mode no longer fits the extension, asks for its path. false: that was cancelled
  async function saveChanges() {
    if (!st.pix || !st.dirty) return true;
    await save(false, { quiet: true });
    return !st.dirty;
  }

  // Escape: the curve being bent or the polygon being drawn, else the range on the canvas
  function cancel() {
    if (rot.stop(false)) return true;
    if (waits(st.drag)) { st.drag = null; draw(); return true; }   // a curve or a polygon not drawn yet
    if (!st.sel) return false;
    st.sel = null; draw(); status();
    return true;
  }

  // what a reload keeps (uistate.js): the tools, the pens and their colors, the zoom
  const KEEP = ['pen', 'penColor', 'tool', 'cell', 'grid', 'brush', 'radius', 'aa'];
  keepUi('bitmap', { save: () => pickUi(st, KEEP), load(s) { putUi(st, s, KEEP); if (!el.hidden) render(); } });

  return { open, select: file => open(file), cancel, current: () => st.file, isDirty: () => st.dirty, saveChanges, saveAs: () => save(true), exportFormats, importFormats,
    undo: () => restore(st.undo, st.redo), redo: () => restore(st.redo, st.undo) };
}
