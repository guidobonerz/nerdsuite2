// screenpaint.js - the pixel mode of the screen editor: pixels are painted onto the place like in
// the bitmap editor, and the chars they need go into the charset of the place (charpack.js). A
// cell keeps the one color the hardware gives it: painting with a color recolors the cell. In a
// multicolor place a cell with a color 8-15 is multicolor - its pens are the cell color (of 8), the
// two shared colors ($d022, $d023) and the background; the pens are the color rows of the
// Characters section (screen.js: placeColors). Extended
// color mode has 64 chars; the background bits of a cell stay as they are. The mouse cursor is
// hidden over the canvas: the pixel under the pointer, outlined, is the cursor - its border fades
// from black to white and back, so it shows on any color.
//
// Every stroke packs its cells as it goes: a char the charset has already (anywhere, the
// duplicate) is reused, a char only this cell shows is changed in place, else a free char is
// taken. With none free the cell is left alone, hatched red while the stroke lasts, and the
// snackbar says how many chars were missing. The bytes of the charset go into the cache of
// chr.js at once; the chars of the cells into the model (screen.js: paint). The two are undone
// together: the charset before and after every undo step of the store (a stroke, or a part of a
// slow one) is kept with the depth of the undo stack, and when the store travels the charset follows.

import { LAYOUT } from './layout.js';
import { symbols, getAttr, newId } from './adv.js';
import { PALETTE, romCharset } from './c64.js';
import { charsetKey, charsetByKey, setCharsetBytes, scriptDirectory, scriptRelative, onCharsetChange } from './chr.js';
import { tilesetByKey, tilesetKey, tilesetCharset, setTileset } from './tileset.js';
import { petsciiChar, screencode, isPetscii } from './petscii.js';
import { tools, BRUSH_TOOLS, DRAG_TOOLS, brushCells, lineCells, dragCells as dragXY, dragMods, dragTo, curveWaits } from './drawtools.js';
import { glyphBytes, usedCounts, packer, duplicates, bitAt, setBit, pairAt, setPair } from './charpack.js';
import { h, section as uiSection, button, snackbar, promptDialog, icon } from './pui.js';
import { tr } from './i18n.js';

// the tools of the pixel mode (drawtools.js): no select, no text, no object - pixels only
const PIXEL_TOOLS = tools(['pencil', 'line', 'rect', 'circle', 'curve', 'fill', 'pick'], { erase: '§0621', pick: '§0622' });
const hex2 = n => '$' + n.toString(16).padStart(2, '0');
const PULSE_MS = 1200;                       // the border of the pixel cursor fades from black to white and back in this time
// a section of the side panel of the screen editor, folded with its others
const section = (title, actions, ...content) => uiSection(title, content, actions, 'screen.collapsed');

// env: what the painter needs of the screen editor - store, st (its state: tool, color, shape,
// pixels, pen, cell), ui() (canvas, info, cells), place(), patch(), patchRect(p), rowsOf(), rebuild(),
// cellValue(c, r), paint(cells, key, brush), draw(), drawSoon(), update(), setTool(t), setColor(k), tiling()
export function createPixelPainter(env) {
  const { store, st } = env;
  const info = () => env.ui()?.info ?? null;
  const key = () => { const f = info()?.chrFile; return f ? charsetKey(f) : null; };
  const data = () => info()?.chr ?? null;                 // the live bytes of the charset (chr.js cache)
  const mcPlace = () => !!info()?.multicolor;
  const ecm = () => !!info()?.ecm;
  const limit = () => (ecm() ? 64 : 256);
  const glyphOf = code => (ecm() ? code & 63 : code);
  const mcCell = color => mcPlace() && color >= 8;         // the cell is shown multicolor
  let stroke = null;                                       // the stroke in progress: { key, pack, missing, painted, step }
  let refused = new Set();                                 // 'c,r' of the cells the last stroke could not give a char
  let strokes = 0;
  const history = [];                                      // { key, depth, before, after, applied }: the charset with the undo steps of the store

  // --- where ---------------------------------------------------------------------------

  const on = () => !!st.pixels;
  // the mode works on a place with a charset file that is not painted with tiles
  const available = () => !!key() && !!data() && !env.tiling();
  const pens = () => (mcPlace() ? ['color', 'mc1', 'mc2'] : ['color']);
  const pen = () => (pens().includes(st.pen) ? st.pen : 'color');

  // the pixel under the pointer, in hires pixels of the place (a multicolor cell paints pairs)
  function pixelAt(e) {
    const ui = env.ui(), i = info();
    const r = ui.canvas.getBoundingClientRect();
    const w = i.width * 8, hh = env.rowsOf() * 8;
    const x = Math.floor((e.clientX - r.left) / r.width * w), y = Math.floor((e.clientY - r.top) / r.height * hh);
    return { x: Math.max(0, Math.min(w - 1, x)), y: Math.max(0, Math.min(hh - 1, y)) };
  }
  // the pixels that can be painted: the whole place - a patch painted on grows to a cell outside
  // it, like with the char tools (screen.js: paint)
  const area = () => ({ x: 0, y: 0, w: info().width * 8, h: env.rowsOf() * 8 });
  const inside = (a, p) => p.x >= a.x && p.y >= a.y && p.x < a.x + a.w && p.y < a.y + a.h;
  const brushGrid = () => ({ aspect: 1, w: info().width * 8, h: env.rowsOf() * 8 });
  const brushed = cells => (BRUSH_TOOLS.has(st.tool) ? brushCells(cells, st.shape, brushGrid()) : cells);
  const dragTool = () => DRAG_TOOLS.has(st.tool);
  const dragPixels = d => brushed(dragXY(st.tool, d.start, d.end, { ...d, radius: st.radius })).filter(p => inside(area(), p));

  // --- the pixels of a cell ------------------------------------------------------------

  // the value of a pixel as shown: 0 background, else the pen (1 hires, 1-3 multicolor)
  function valueAt(x, y) {
    const d = data(), v = env.cellValue(x >> 3, y >> 3);
    const b = glyphBytes(d, glyphOf(v.code));
    return mcCell(v.color) ? pairAt(b, (x & 7) >> 1, y & 7) : bitAt(b, x & 7, y & 7);
  }

  // the pixels list painted with pen p ('color', 'mc1', 'mc2', or 'bg' for the right button):
  // the cells they touch get their new bytes and color, packed into the charset
  function applyPixels(list, p) {
    if (!stroke || !list.length) return;
    const d = data(), a = area(), pre = d.slice();
    const cells = new Map();                                 // 'c,r' -> { c, r, bytes, color, from, code }
    for (const px of list) {
      if (!inside(a, px)) continue;
      const c = px.x >> 3, r = px.y >> 3, k = `${c},${r}`;
      let cell = cells.get(k);
      if (!cell) {
        const v = env.cellValue(c, r);
        cell = { c, r, from: glyphOf(v.code), code: v.code, color: v.color, bytes: glyphBytes(d, glyphOf(v.code)).slice(), was: v.color };
        cells.set(k, cell);
      }
      // the color of the cell after this pixel: the pen's color recolors it, a shared pen makes a
      // hires cell multicolor, the background leaves it alone
      if (p === 'color') cell.color = mcPlace() ? (st.color & 7) | 8 : st.color & 15;   // a multicolor place: the cell is multicolor
      else if (p !== 'bg' && mcPlace() && cell.color < 8) cell.color |= 8;
      const mc = mcCell(cell.color);
      if (mc) setPair(cell.bytes, (px.x & 7) >> 1, px.y & 7, p === 'bg' ? 0 : p === 'mc1' ? 1 : p === 'mc2' ? 2 : 3);
      else setBit(cell.bytes, px.x & 7, px.y & 7, p === 'bg' ? 0 : 1);
    }
    const out = [];
    for (const cell of cells.values()) {
      const old = glyphBytes(d, cell.from);
      const sameBytes = cell.bytes.every((v, k) => v === old[k]);
      if (sameBytes && cell.color === cell.was) continue;
      let code = cell.code;
      if (!sameBytes) {
        const res = stroke.pack.place(cell.from, cell.bytes);
        if (!res) { refused.add(`${cell.c},${cell.r}`); stroke.missing++; continue; }
        code = ecm() ? res.code | (cell.code & 0xc0) : res.code;
      }
      out.push({ c: cell.c, r: cell.r, code, color: cell.color });
    }
    if (!out.length) { env.draw(); return; }
    setCharsetBytes(stroke.key, d);                          // the same bytes, changed in place: dirty, and the views follow
    stroke.painted = true;
    env.paint(out, 'pixels:' + strokes, false);
    // a new undo step of the store (the first of the stroke, or after a pause): its bytes before
    // are the ones this call started from; the step before it ends there
    if (store.undoStack.length !== stroke.step?.depth) {
      if (stroke.step) stroke.step.after = pre;
      stroke.step = { key: stroke.key, depth: store.undoStack.length, before: pre, after: null, applied: true };
      history.push(stroke.step);
      if (history.length > 60) history.shift();
    }
  }

  // the pixels of the fill: the pixels joined to start that show the same value (lit or not)
  function floodPixels(start) {
    const a = area();
    if (!inside(a, start)) return [];
    const want = valueAt(start.x, start.y) !== 0;
    const seen = new Set([`${start.x},${start.y}`]), out = [], queue = [start];
    while (queue.length) {
      const p = queue.pop();
      out.push(p);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const q = { x: p.x + dx, y: p.y + dy }, k = `${q.x},${q.y}`;
        if (!inside(a, q) || seen.has(k)) continue;
        seen.add(k);
        if ((valueAt(q.x, q.y) !== 0) === want) queue.push(q);
      }
    }
    return out;
  }

  // --- strokes --------------------------------------------------------------------------

  function begin() {
    const k = key(), d = data();
    if (!k || !d) return false;
    strokes++;
    refused = new Set();
    stroke = { key: k, pack: packer(d, usedCounts(store.game, k), { limit: limit() }), missing: 0, painted: false, step: null };
    return true;
  }

  function end() {
    if (!stroke) return;
    const s = stroke;
    stroke = null;
    if (s.missing) snackbar(tr('§1616', s.missing), { error: true });
    if (s.step) s.step.after = data().slice();
    env.update();
    env.draw();
  }

  // the charset follows the undo and redo steps of the store (the chars of the cells)
  function travel() {
    const n = store.undoStack.length, touched = new Set();
    for (const e of [...history].sort((a, b) => b.depth - a.depth)) {
      if (e.applied && e.depth > n) { charsetByKey(e.key)?.set(e.before); e.applied = false; touched.add(e.key); }
    }
    for (const e of [...history].sort((a, b) => a.depth - b.depth)) {
      if (!e.applied && e.depth <= n && e.after) { charsetByKey(e.key)?.set(e.after); e.applied = true; touched.add(e.key); }
    }
    for (const k of touched) { const d = charsetByKey(k); if (d) setCharsetBytes(k, d); }
  }
  store.on((type, detail) => {
    if (type === 'load') { history.length = 0; stroke = null; refused = new Set(); return; }
    if (type !== 'change') return;
    if (detail.source === 'undo') travel();
    else if (detail.source !== 'charset') {                 // a new step: the steps undone are gone
      for (let k = history.length - 1; k >= 0; k--) if (!history[k].applied) history.splice(k, 1);
    }
  });

  const penOf = e => (e.button === 2 ? 'bg' : pen());

  // the pointer events of the canvas in pixel mode: true when handled
  function onDown(e) {
    if (!on() || !available()) return false;
    const p = pixelAt(e);
    if (st.drag?.bend) { dragTo(st.drag, p, e); env.draw(); return true; }
    if (st.tool === 'pick') { pick(p); env.setTool('pencil'); return true; }
    if (!begin()) return true;
    const pn = penOf(e);
    switch (st.tool) {
      case 'pencil': st.drag = { start: p, last: p, pen: pn, px: true }; applyPixels(brushed([p]), pn); break;
      case 'fill': applyPixels(floodPixels(p), pn); end(); break;
      case 'line': case 'rect': case 'circle': case 'curve':
        st.drag = { start: p, end: p, pen: pn, px: true, ...dragMods(e) }; env.draw(); break;
    }
    return true;
  }

  // the border of the pixel cursor fades while the pointer is over the canvas: a redraw every few frames
  let pulse = 0;
  function pulsing() {
    pulse = 0;
    if (!on() || !st.hoverPx) return;
    env.drawSoon();
    pulse = setTimeout(pulsing, 50);
  }

  function onMove(e) {
    if (!on()) return false;
    const p = pixelAt(e);
    const changed = st.hoverPx?.x !== p.x || st.hoverPx?.y !== p.y;
    st.hoverPx = p;
    if (!pulse) pulse = setTimeout(pulsing, 50);
    const d = st.drag;
    if (d?.px && st.tool === 'pencil' && changed) {
      applyPixels(brushed(lineCells(d.last, p).slice(1)), d.pen);
      d.last = p;
    } else if (d?.px && changed) {
      if (d.bend) d.bend = p; else d.end = p;
      Object.assign(d, dragMods(e));
      env.drawSoon();
    } else if (changed) env.drawSoon();
    if (changed) env.status(st.hover);
    return true;
  }

  function onUp() {
    if (!on()) return false;
    const d = st.drag;
    if (!d?.px) { if (stroke) end(); return true; }
    if (curveWaits(st.tool, d)) { env.draw(); return true; }
    st.drag = null;
    if (dragTool()) applyPixels(dragPixels(d), d.pen);
    end();
    return true;
  }

  // the pick tool: the color of the cell under the pointer, and the pen its pixel is painted with
  function pick(p) {
    const v = env.cellValue(p.x >> 3, p.y >> 3);
    const val = valueAt(p.x, p.y);
    if (mcCell(v.color) && (val === 1 || val === 2)) st.pen = val === 1 ? 'mc1' : 'mc2';
    else { st.pen = 'color'; if (val) env.setColor(v.color); }
    env.update();
  }

  function cancel() {
    if (st.drag?.px) { st.drag = null; if (stroke) end(); return true; }
    return false;
  }

  // --- drawing ---------------------------------------------------------------------------

  const penColor = pn => {
    const i = info();
    if (pn === 'bg') return i.bg;
    if (pn === 'mc1') return i.multicolor[0];
    if (pn === 'mc2') return i.multicolor[1];
    return mcPlace() ? st.color & 7 : st.color;
  };

  // over the canvas: the pixels of a drag, the cells without a char, the pixel under the pointer
  function overlay(ctx, s) {
    if (!on()) return;
    const q = s / 8;
    if (st.drag?.px && dragTool()) {
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = PALETTE[penColor(st.drag.pen) & 15];
      for (const p of dragPixels(st.drag)) {
        const wide = mcCell(env.cellValue(p.x >> 3, p.y >> 3).color);
        ctx.fillRect((wide ? p.x & ~1 : p.x) * q, p.y * q, wide ? 2 * q : q, q);
      }
      ctx.globalAlpha = 1;
    }
    if (refused.size) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 64, 64, .9)';
      ctx.lineWidth = 2;
      for (const k of refused) {
        const [c, r] = k.split(',').map(Number);
        ctx.strokeRect(c * s + 1, r * s + 1, s - 2, s - 2);
        ctx.beginPath();
        ctx.moveTo(c * s + 2, r * s + 2); ctx.lineTo(c * s + s - 2, r * s + s - 2);
        ctx.moveTo(c * s + s - 2, r * s + 2); ctx.lineTo(c * s + 2, r * s + s - 2);
        ctx.stroke();
      }
      ctx.restore();
    }
    const p = st.hoverPx;                 // the pixel cursor: the only cursor of the mode, while a drag lasts too
    if (p) {
      const wide = mcPlace();             // a multicolor place paints double wide pixels: the pen makes the cell multicolor
      const v = Math.round(127.5 - 127.5 * Math.cos(Date.now() / PULSE_MS * 2 * Math.PI));   // its border fades black - white - black
      ctx.strokeStyle = `rgb(${v}, ${v}, ${v})`;
      ctx.lineWidth = 1;
      ctx.strokeRect((wide ? p.x & ~1 : p.x) * q + .5, p.y * q + .5, (wide ? 2 * q : q) - 1, q - 1);
    }
  }

  // the status line in pixel mode
  function status() {
    const p = st.hoverPx;
    if (!p || !info()) return '';
    const v = env.cellValue(p.x >> 3, p.y >> 3);
    return tr('§1624', p.x, p.y, p.x >> 3, p.y >> 3, v.code, hex2(v.code), freeCount());
  }

  // --- the charset: its use, the duplicates ----------------------------------------------

  let usedAt = null, usedNow = null, bytesChanged = 0;
  onCharsetChange(() => { bytesChanged++; });       // the char editor too: the duplicates follow the bytes
  function used() {
    const k = key(), d = data();
    if (!k || !d) return null;
    const stamp = `${k}|${store.undoStack.length}|${store.lastTime}|${limit()}|${bytesChanged}`;
    if (stamp !== usedAt) {
      const counts = usedCounts(store.game, k);
      let n = 0;
      for (let c = 0; c < limit(); c++) if (counts.get(c)) n++;
      usedNow = { used: n, max: limit(), dups: duplicates(d, limit()).size };
      usedAt = stamp;
    }
    return usedNow;
  }
  const freeCount = () => { const u = used(); return u ? u.max - u.used : 0; };

  // every screen and patch of the places with the charset, and every tile of the tilesets bound
  // to it, show the lowest of identical chars: the others are free then
  function mergeDuplicates() {
    const k = key(), d = data();
    if (!k || !d) return;
    const dup = duplicates(d, limit());
    if (!dup.size) return snackbar('§1619');
    const S = symbols(store.game);
    const remap = (code, ecmPlace) => {
      const g = ecmPlace ? code & 63 : code;
      return dup.has(g) ? dup.get(g) | (ecmPlace ? code & 0xc0 : 0) : code;
    };
    const mapLine = (line, ecmPlace) => [...line].map(ch => {
      const code = isPetscii(ch) ? ch.charCodeAt(0) & 0xff : screencode(ch, S.charset);
      const to = remap(code, ecmPlace);
      return to === code ? ch : petsciiChar(to, S.charset);
    }).join('');
    store.mutate(() => {
      for (const r of S.allPlaces) {
        const file = getAttr(r, 'charset');
        if (!file || charsetKey(file) !== k) continue;
        const ecmPlace = !!getAttr(r, 'ecm');
        for (const m of r.members) {
          if (m.kind !== 'background' && m.kind !== 'patch') continue;
          m.lines = m.lines.map(l => mapLine(l, ecmPlace));
        }
      }
    }, { source: 'structure' });
    for (const r of S.allPlaces) {
      const tiles = getAttr(r, 'tiles');
      if (!tiles) continue;
      const tk = tilesetKey(tiles), ts = tilesetByKey(tk);
      if (ts && tilesetCharset(tk, ts) === k) setTileset(tk, { ...ts, tiles: ts.tiles.map(t => ({ ...t, chars: t.chars.map(c => remap(c, false)) })) });
    }
    usedAt = null;
    snackbar(tr('§1620', dup.size, freeCount()));
    env.update();
  }

  // a place of the ROM font: a charset file of its own, a copy of the ROM set, and the place names it
  async function makeCharset() {
    const rm = env.place(), S = symbols(store.game);
    const known = new Set(S.places.map(r => getAttr(r, 'charset')).filter(Boolean).map(charsetKey));
    const base = `${scriptDirectory()}${LAYOUT.charset}/${rm.name}`;
    let path = `${base}.chr`;
    for (let k = 2; known.has(path); k++) path = `${base}${k}.chr`;
    const v = await promptDialog({
      title: tr('§1626', rm.name), icon: 'grid_view', ok: '§0124', text: tr('§1627', S.charset, rm.name),
      fields: [{ name: 'path', label: '§1263', value: path, mono: true,
        validate: p => (!/^[\w\-./]+\.(chr|bin|raw)$/i.test(p) || p.includes('..') ? '§0660' : known.has(p) ? '§0208' : null) }],
    });
    if (!v) return;
    setCharsetBytes(v.path, romCharset(S.charset).slice());
    store.mutate(() => {
      const at = rm.members.reduce((a, m, k) => (m.kind === 'attr' ? k + 1 : a), 0);
      rm.members.splice(at, 0, { id: newId(), kind: 'attr', key: 'charset', str: scriptRelative(v.path) });
    }, { source: 'structure' });
  }

  // --- views -------------------------------------------------------------------------------

  // the bar of the use of the charset, like the memory bars of the settings (usage.js)
  function usageBar() {
    const u = used();
    if (!u) return '';
    const pct = Math.round(u.used / u.max * 100);
    const level = u.used >= u.max ? 'over' : pct >= 85 ? 'high' : 'ok';
    return h('div', { class: `usage__item usage__item--${level} pixels__usage` },
      h('div', { class: 'usage__head' }, h('span', { class: 'usage__label' }, '§1614'), h('span', { class: 'usage__value' }, tr('§1615', u.used, u.max, pct))),
      h('div', { class: 'usage__bar', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': u.max, 'aria-valuenow': u.used, 'aria-label': tr('§1614') },
        h('div', { class: 'usage__fill', style: { width: `${Math.min(100, pct)}%` } })));
  }

  // the section of the side panel: the use of the charset, the duplicates - the pens are the color
  // rows of the Characters section (screen.js: placeColors)
  function sectionView() {
    if (!on()) return '';
    if (!info()) return '';
    if (env.tiling()) return section('§1613', [], h('div', { class: 'section__hint' }, '§1623'));
    if (!key()) return section('§1613', [],
      h('div', { class: 'section__hint', style: { margin: '0 0 10px' } }, '§1621'),
      button('§1622', { icon: 'grid_view', variant: 'tonal', onclick: makeCharset }));
    const u = used();
    return section('§1613', [],
      h('div', { class: 'section__hint', style: { margin: '0 0 12px' } }, '§1630'),
      usageBar(),
      h('div', { class: 'section__hint', style: { margin: '8px 0 0' } }, tr('§1628', key(), u?.used ?? 0, freeCount())),
      h('div', { style: { marginTop: '10px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
        button('§1617', { icon: 'auto_fix_high', variant: 'tonal', disabled: !u?.dups, onclick: mergeDuplicates, cls: 'pixels__merge' }),
        h('span', { class: 'section__hint', style: { margin: 0 } }, u?.dups ? tr('§1618', u.dups) : '§1619')));
  }

  function toggle() {
    st.pixels = !st.pixels;
    st.drag = null;
    if (stroke) end();
    if (st.pixels && !PIXEL_TOOLS.some(t => t.key === st.tool)) st.tool = 'pencil';
    // close enough to see a pixel: 4 screen pixels a C64 pixel at least; chars again at 4 at most
    if (st.pixels && st.cell < 32) { st.cell = 32; env.rebuild(); }
    if (!st.pixels && st.cell > 32) { st.cell = 32; env.rebuild(); }
    if (!st.pixels && !['pencil', 'line', 'rect', 'circle', 'curve', 'fill', 'pick'].includes(st.tool)) st.tool = 'pencil';
    refused = new Set();
    st.hoverPx = null;
    clearTimeout(pulse); pulse = 0;
    cursor();
    env.update();
    env.draw();
    env.status(st.hover);
  }

  // the mouse cursor over the canvas: none in pixel mode, the pixel cursor drawn on the canvas is the only one
  function cursor() {
    const ui = env.ui();
    if (ui) ui.canvas.style.cursor = st.pixels ? 'none' : '';
  }

  return {
    on, available, toggle, tools: () => PIXEL_TOOLS, onDown, onMove, onUp, cancel, overlay, status, section: sectionView,
    pen, setPen(p) { st.pen = p; env.update(); },
    grid: brushGrid,                       // the pixels of the place: the radius of the box tool is of them
    cursor,
    leave() { st.hoverPx = null; clearTimeout(pulse); pulse = 0; },
    free: freeCount,
    icon: () => icon('grain'),
  };
}
