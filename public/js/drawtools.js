// drawtools.js - the drawing tools the screen, sprite, char and bitmap editors share: the tools
// with their icons, tips and shortcut keys, the toolbox, and the cells a drag draws
// (lines, boxes, ellipses, circles, curves and polygons; shapes.js does the geometry).
//
// A tool is { key, icon, shortcut, tip, group }. Every tool is defined here once (TOOLS);
// an editor picks the ones it has with tools(), and the toolbox shows those only.

import { h, iconButton, slider } from './pui.js';
import { shapeCells } from './shapes.js';
import { tr } from './i18n.js';

// every tool of the graphics editors, in toolbox order. The groups, apart by a separator:
// move (select and move), draw, place (the tools of a place or a sprite) and, below, the range
// tools (RANGE_TOOLS). {erase} and {pick}: filled in by tools()
const TOOLS = [
  { group: 'move', key: 'object', icon: 'navigation', shortcut: 'o', tip: '§0830' },
  { group: 'move', key: 'layer', icon: 'near_me', shortcut: 'd', tip: '§0831' },
  { group: 'move', key: 'select', icon: 'highlight_alt', shortcut: 's', tip: '§0625' },
  { group: 'move', key: 'hand', icon: 'pan_tool', shortcut: 'h', tip: '§0623' },
  { group: 'draw', key: 'pencil', icon: 'edit', shortcut: 'p', tip: 'Pencil (P) - right mouse button {erase}' },
  { group: 'draw', key: 'line', icon: 'horizontal_rule', shortcut: 'l', tip: '§0696' },
  { group: 'draw', key: 'rect', icon: 'crop_square', shortcut: 'r', tip: '§0697' },
  { group: 'draw', key: 'circle', icon: 'radio_button_unchecked', shortcut: 'q', tip: '§0955' },
  { group: 'draw', key: 'curve', icon: 'looks', shortcut: 'a', tip: '§0698' },
  { group: 'draw', key: 'polygon', icon: 'pentagon', shortcut: 'y', tip: '§2114' },
  { group: 'draw', key: 'fill', icon: 'format_color_fill', shortcut: 'g', tip: '§0699' },
  { group: 'draw', key: 'pick', icon: 'colorize', shortcut: 'i', tip: 'Pick {pick} (I)' },
  { group: 'draw', key: 'paint', icon: 'format_paint', shortcut: 'c', tip: '§0737' },
  { group: 'draw', key: 'text', icon: 'title', shortcut: 't', tip: '§0738' },
  { group: 'place', key: 'walkbox', icon: 'directions_walk', shortcut: 'w', tip: '§0795' },
  { group: 'place', key: 'block', icon: 'block', shortcut: 'k', tip: '§1720' },
  { group: 'place', key: 'behind', icon: 'visibility_off', shortcut: 'h', tip: '§0796' },
  { group: 'place', key: 'hotspot', icon: 'my_location', shortcut: 'h', tip: '§0871' },
];
const GROUPS = ['move', 'draw', 'place'];

// the drawing tools every editor has: pencil, line, box, circle, curve, fill, pick
export const DRAW = ['pencil', 'line', 'rect', 'circle', 'curve', 'fill', 'pick'];
// and with the polygon: the bitmap, sprite and char editors
export const DRAW_POLY = ['pencil', 'line', 'rect', 'circle', 'curve', 'polygon', 'fill', 'pick'];

// an editor's tools by key, in toolbox order. erase: what the right mouse button does with the
// pencil; pick: what the pick tool picks; tips: the editor's own tips by key, more: added to them
export function tools(keys, { erase = 'erases', pick = tr('§0695'), tips = {}, more = {} } = {}) {
  return TOOLS.filter(t => keys.includes(t.key)).map(t => ({ ...t,
    tip: (tips[t.key] ?? t.tip.replace('{erase}', erase).replace('{pick}', pick)) + (more[t.key] ?? '') }));
}

// the tools that draw what a drag spans, from where you press to where you let go
export const DRAG_TOOLS = new Set(['line', 'rect', 'circle', 'curve', 'polygon']);
// the tools whose drag waits for more strokes after the first: the curve for its bend, the polygon
// for its corners - they draw (and take their undo step) only at the end
export const WAIT_TOOLS = new Set(['curve', 'polygon']);

// The brush of the graphics editors: a square or a circle that the pencil, the line, the box,
// the circle and the curve draw with (the screen: color only too) - every cell they draw is the
// middle of one. { shape: 'square' | 'circle', size }: 1 up to the width or the height of the
// grid { w, h, aspect }, whichever is smaller (brushMax). A multicolor pixel is double wide:
// the brush takes half as many of them across (aspect 2), so it keeps its shape
export const BRUSH_TOOLS = new Set(['pencil', ...DRAG_TOOLS]);
export const defaultBrush = () => ({ shape: 'square', size: 1 });
export const brushMax = ({ w = Infinity, h = Infinity, aspect = 1 }) => Math.max(1, Math.min(h, Math.floor(w * aspect)));

// the rows {dy, l, r} of a brush around the cell it is at: its cells from dx l to r
const footprints = new Map();
function footprint(shape, size, aspect) {
  const id = `${shape}${size}:${aspect}`;
  if (footprints.has(id)) return footprints.get(id);
  const w = Math.max(1, Math.round(size / aspect)), hgt = size, rows = [];
  for (let j = 0; j < hgt; j++) {
    const dy = j + 0.5 - hgt / 2;
    // the circle: the cells whose middle lies inside it, a quarter cell in from its edge (3: a plus)
    const inside = i => shape !== 'circle' || size <= 2 || Math.hypot((i + 0.5 - w / 2) * (hgt / w), dy) <= hgt / 2 - 0.25;
    let l = 0, r = w - 1;
    while (l < r && !inside(l)) l++;
    while (r > l && !inside(r)) r--;
    const x0 = (w - 1) >> 1;
    rows.push({ dy: j - ((hgt - 1) >> 1), l: l - x0, r: r - x0 });
  }
  footprints.set(id, rows);
  return rows;
}

// the cells {x, y} a brush paints along cells, each one once, inside the grid of w x h cells;
// a brush of size 1: cells themselves. The brush is at most brushMax of the grid
export function brushCells(cells, brush, { aspect = 1, w = Infinity, h = Infinity } = {}) {
  const size = Math.min(brush?.size ?? 1, brushMax({ w, h, aspect }));
  if (size <= 1) return cells;
  const rows = footprint(brush.shape, size, aspect), spans = new Map();
  for (const { x, y } of cells) {
    for (const f of rows) {
      const yy = y + f.dy, a = Math.max(0, x + f.l), b = Math.min(w - 1, x + f.r);
      if (yy < 0 || yy >= h || a > b) continue;
      if (!spans.has(yy)) spans.set(yy, []);
      spans.get(yy).push([a, b]);
    }
  }
  // row by row: the spans of the brushes merged, so a cell is there once
  const out = [];
  for (const [y, list] of spans) {
    list.sort((p, q) => p[0] - q[0]);
    let end = -Infinity;
    for (const [a, b] of list) {
      for (let x = Math.max(a, end + 1); x <= b; x++) out.push({ x, y });
      end = Math.max(end, b);
    }
  }
  return out;
}

// the brush in the bar above the editor: square or circle, and its size on a slider, 1 to max.
// It is for the tools that draw with it (tools, BRUSH_TOOLS); with another tool it shows, but
// cannot change. o: { brush, tool, max, tools, onchange(brush) }
export function brushTools({ brush, tool, max, tools = BRUSH_TOOLS, onchange }) {
  const off = !tools.has(tool), set = more => onchange({ ...brush, ...more });
  const which = tools.has('paint') ? '§1958' : '§1959';
  const shape = (key, ic, tip) => iconButton(ic, off ? tip + which : tip, () => set({ shape: key }),
    brush.shape === key ? 'md-icon-button--selected' : '', { 'data-brush': key, 'aria-pressed': String(brush.shape === key), disabled: off });
  return h('div', { class: 'default-tools brush-tools' },
    shape('square', 'brush_square', '§0703'), shape('circle', 'brush_circle', '§0704'),
    slider({ tip: off ? '§0705' + which : tr('§0707', max), cls: 'brush-tools__size', min: 1, max, value: Math.min(brush.size, max),
      disabled: off, format: v => tr('§0706', v), oninput: v => set({ size: v }) }));
}

// the modifier keys of a drag, kept while it lasts: shift fills, ctrl centers, alt rounds (circle)
export const dragMods = e => ({ shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey });

// The curve takes two strokes: the first drags its line, then the pointer bends it - the curve
// follows it - and the second stroke draws it where you let go (its control point, a quadratic
// Bezier). curveWaits(tool, d) at the end of a stroke: true when drag d stays and waits for its
// bend, false when it is done and draws
//
// The polygon takes a stroke for each side: the first one drags its first side (a click: its first
// corner), then a click puts each further corner, the side to the pointer following it. A click on
// the first corner closes it, so does a second click on the last one (a double click) or Enter;
// Shift at the end fills it. Escape drops it
export function curveWaits(tool, d) {
  if (tool === 'polygon') {
    if (!d.poly) d.poly = d.start.x === d.end.x && d.start.y === d.end.y ? [d.start] : [d.start, d.end];
    return !d.closed;
  }
  if (tool !== 'curve' || d.bend) return false;
  if (['x', 'y', 'c', 'r'].every(k => d.start[k] === d.end[k])) return false;   // a click: a dot
  d.bend = d.end;
  return true;
}

// a drag that waits for its next stroke: a curve for its bend, a polygon for its next corner
export const waits = d => !!(d?.bend || (d?.poly && !d.closed));

// a press while drag d waits: the curve's bend; the polygon's next corner - on its first corner
// (with 3 at least) or again on its last one it closes (curveWaits says it is done)
export function strokeDown(d, p, e) {
  if (!d.poly) return dragTo(d, p, e);
  const same = q => q.x === p.x && q.y === p.y;
  if (same(d.poly.at(-1)) || (d.poly.length > 2 && same(d.poly[0]))) d.closed = true;
  else d.poly.push(p);
  d.end = p;
  Object.assign(d, dragMods(e));
}
// Enter: the waiting polygon closes
export function closePolygon(d) {
  if (!d?.poly || d.closed) return false;
  d.closed = true;
  return true;
}

// the pointer moves drag d on: the end of its line, or the bend of a waiting curve
export function dragTo(d, p, e) {
  if (d.bend) d.bend = p; else d.end = p;
  Object.assign(d, dragMods(e));
}

// The curve follows the pointer beyond the grid as well - its end and its bend may lie outside,
// the editor clips its cells at the border. While it waits for its bend the canvas has no pointer
// capture: the pointer anywhere in the page bends it, a click anywhere draws it - but on a control
// (a tool, a field, a menu), which does its own work. The click is the curve's alone: it does not
// reach what lies under it. parts(): {canvas} of the editor; waiting(): true while a curve waits
const CONTROLS = 'button, input, select, textarea, a, label, [role="button"], [role="menuitem"], [contenteditable], .md-menu, .md-dialog-scrim';
// onEnter: Enter while it waits (the polygon closes and draws)
export function followCurve(parts, waiting, onMove, onDown, onEnter = null) {
  const outside = e => {
    const canvas = parts()?.canvas;
    return !!canvas?.isConnected && !!canvas.offsetParent && e.target !== canvas && waiting();
  };
  addEventListener('pointermove', e => { if (outside(e)) onMove(e); }, true);
  addEventListener('pointerdown', e => {
    if (!outside(e) || e.target.closest?.(CONTROLS)) return;
    e.stopPropagation();
    onDown(e);
  }, true);
  if (onEnter) {
    addEventListener('keydown', e => {
      const canvas = parts()?.canvas;
      if (e.key !== 'Enter' || !canvas?.isConnected || !canvas.offsetParent || !waiting() || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
      e.preventDefault();
      e.stopPropagation();
      onEnter(e);
    }, true);
  }
}

// the range tools: shift, mirror, flip, rotate, invert (clear is a default tool), with their keys
export const RANGE_TOOLS = [
  { key: 'left', icon: 'west', keys: ['ArrowLeft'], tip: '§0685' },
  { key: 'right', icon: 'east', keys: ['ArrowRight'], tip: '§0686' },
  { key: 'up', icon: 'north', keys: ['ArrowUp'], tip: '§0687' },
  { key: 'down', icon: 'south', keys: ['ArrowDown'], tip: '§0688' },
  { key: 'mirror', icon: 'flip', keys: ['m'], tip: '§0689' },
  { key: 'flip', icon: 'swap_vert', keys: ['v'], tip: '§0690' },
  { key: 'rotl', icon: 'rotate_left', keys: [','], tip: '§0691' },
  { key: 'rotr', icon: 'rotate_right', keys: ['.'], tip: '§0702' },
  { key: 'rotate', icon: 'public', keys: ['/'], tip: '§1730' },
  { key: 'invert', icon: 'invert_colors', keys: ['x'], tip: '§0693' },
  { key: 'smooth', icon: 'auto_fix_high', keys: ['j'], tip: '§2115' },
];
// the range tools of the screen editor; the bitmap, sprite and char editors have the edge smoother too
export const RANGE = RANGE_TOOLS.map(t => t.key).filter(k => k !== 'smooth');
export const RANGE_SMOOTH = RANGE_TOOLS.map(t => t.key);

// the turn of the range tool 'rotate': a section of the side panel, shown while it is on, with the
// angles about the x, y and z axis and the perspective. o: { preview() - the canvas shows r.turn
// while r.on (and the picture as it is once it is off), apply(turn) - one undo step, refresh() -
// the side panel again }. Reset puts every slider back to 0, Apply keeps the turn, Cancel (or
// stop(false), Esc) leaves the picture as it was. The perspective given last is proposed again
const NO_TURN = { rx: 0, ry: 0, rz: 0, persp: 0 };
let lastPersp = 0;
export function rotation(o) {
  const r = { on: false, turn: { ...NO_TURN }, resets: 0 };
  r.start = () => {
    if (r.on) return;
    Object.assign(r, { on: true, turn: { ...NO_TURN, persp: lastPersp } });
    o.preview(); o.refresh();
  };
  // ends the turn - keep: applied; false when it was not on
  r.stop = (keep = false) => {
    if (!r.on) return false;
    r.on = false;
    lastPersp = r.turn.persp;
    o.preview();
    if (keep) o.apply({ ...r.turn });
    o.refresh();
    return true;
  };
  const row = (key, label, min, max, unit) => slider({ label, min, max, value: r.turn[key], format: v => v + unit, cls: 'rotate-panel__slider',
    oninput: v => { r.turn = { ...r.turn, [key]: v }; o.preview(); } });
  // the content of the section
  r.view = () => h('div', { class: 'rotate-panel', key: r.resets },   // a reset: the sliders anew
    row('rx', '§1732', -180, 180, '°'), row('ry', '§1733', -180, 180, '°'), row('rz', '§1734', -180, 180, '°'),
    row('persp', '§1735', 0, 100, ' %'),
    h('div', { class: 'section__hint' }, '§1736'));
  // the icons of its title bar: reset, apply and - most right - cancel
  r.actions = () => h('div', { class: 'rotate-panel__actions' },
    iconButton('restart_alt', '§1737', () => { r.turn = { ...NO_TURN }; r.resets++; o.preview(); o.refresh(); }, 'md-icon-button--sm'),
    iconButton('check', '§1738', () => r.stop(true), 'md-icon-button--sm'),
    iconButton('close', '§0006', () => r.stop(false), 'md-icon-button--sm'));
  return r;
}
const sep = () => h('span', { class: 'screen-tools__sep' });

// the range operation a key runs: one of keys (the editor's range tools), Delete clears; null for
// other keys
export function rangeForKey(keys, e) {
  if (e.key === 'Delete') return 'clear';
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return RANGE_TOOLS.find(t => keys.includes(t.key) && t.keys.includes(k))?.key ?? null;
}

// the default tools of every graphics editor, in the bar above it: undo, redo, zoom out and in,
// grid, multicolor and clear. o: { undo(), redo(), zoom(+1 / -1), grid: { on, toggle() },
// multicolor: { on, toggle(), locked: why it cannot change or null }, modes: more mode switches
// right after it, clear: { tip, run() } }
export function defaultTools(o) {
  const mc = o.multicolor;
  const mcAttrs = { 'data-default': 'multicolor', 'aria-pressed': String(mc.on), disabled: !!mc.locked };
  const mcTip = mc.locked ?? (mc.on ? '§0824' : '§0825');
  return h('div', { class: 'default-tools' },
    iconButton('undo', 'Undo (Ctrl+Z)', o.undo), iconButton('redo', 'Redo (Ctrl+Y)', o.redo),
    iconButton('zoom_out', '§0700', () => o.zoom(-1)), iconButton('zoom_in', '§0701', () => o.zoom(1)),
    iconButton('grid_on', '§0682', o.grid.toggle, o.grid.on ? 'md-icon-button--selected' : '', { 'data-default': 'grid', 'aria-pressed': String(o.grid.on) }),
    iconButton('colors', mcTip, mc.locked ? null : mc.toggle, mc.on ? 'md-icon-button--selected' : '', mcAttrs),
    o.modes ?? '',
    iconButton('delete_sweep', o.clear.tip, o.clear.run, '', { 'data-default': 'clear' }));
}

// a mode switch of the bar with a short text (ECM): pressed while the mode is on
export const modeButton = (label, tip, onclick, on, attrs = {}) => h('button', {
  class: `md-icon-button mode-button ${on ? 'md-icon-button--selected' : ''}`, type: 'button', 'data-tip': tip, 'aria-label': tip,
  'aria-pressed': String(!!on), ...attrs, onclick: e => { e.stopPropagation(); onclick?.(e); },
}, label);

// The paint area: the toolbox left of the canvas, then the canvas (canvasWrap). The toolbox shows
// what the editor has right now, nothing else: its tools (tools()) group by group, the current
// one highlighted, then its range tools. The object and layer arrows toggle: clicking the
// selected one again selects the pencil. o: { tools, current, onselect(key),
// range: { keys (of RANGE), run(key), tips: own tips by key, more: added to them by key,
// note: added to every tip } } - run(key, click event)
export const TOGGLE_TOOLS = new Set(['object', 'layer']);
export function paintArea(o, canvasWrap) {
  const button = t => {
    const on = o.current === t.key;
    const pick = () => o.onselect(on && TOGGLE_TOOLS.has(t.key) ? 'pencil' : t.key);
    return iconButton(t.icon, t.tip, pick, on ? 'md-icon-button--selected' : '', { 'data-tool': t.key, 'aria-pressed': String(on) });
  };
  const r = o.range ?? { keys: [] };
  const range = RANGE_TOOLS.filter(t => r.keys.includes(t.key))
    .map(t => iconButton(t.icon, (r.tips?.[t.key] ?? t.tip) + (r.more?.[t.key] ?? '') + (r.note ?? ''), e => r.run(t.key, e), '', { 'data-range': t.key }));
  const groups = [...GROUPS.map(g => o.tools.filter(t => t.group === g).map(button)), range].filter(g => g.length);
  return h('div', { class: 'paint-area' },
    h('div', { class: 'screen-tools screen-tools--vertical' }, groups.flatMap((g, k) => (k ? [sep(), g] : [g]))),
    canvasWrap);
}

// The mouse wheel over the canvas box of a graphics editor zooms - a step of the editor's own zoom
// (zoom(+1 | -1), as + and -) - and keeps the point under the pointer where it is. A trackpad's small
// steps add up to one, a pinch (the wheel with Ctrl) zooms as well; with Shift the wheel scrolls
// the box. canvas(): the canvas now (the editor may make a new one)
const WHEEL_STEP = 60;                 // pixels of wheel a zoom step: a notch of a mouse wheel is 100
export function wheelZoom(wrap, canvas, zoom) {
  let sum = 0, last = 0;
  wrap.addEventListener('wheel', e => {
    e.preventDefault();
    if (e.shiftKey) {
      wrap.scrollLeft += e.deltaX;
      wrap.scrollTop += e.deltaY;
      return;
    }
    if (e.timeStamp - last > 300) sum = 0;     // a new turn of the wheel starts from nothing
    last = e.timeStamp;
    sum += e.deltaMode ? e.deltaY * 40 : e.deltaY;
    if (Math.abs(sum) < WHEEL_STEP) return;
    const dir = sum < 0 ? 1 : -1;
    sum = 0;
    const cv = canvas(), r = cv?.getBoundingClientRect();
    if (!r?.width || !r.height) return zoom(dir);
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    zoom(dir);
    const keep = () => {
      const q = canvas()?.getBoundingClientRect();
      if (!q?.width) return;
      wrap.scrollLeft += q.left + fx * q.width - e.clientX;
      wrap.scrollTop += q.top + fy * q.height - e.clientY;
    };
    keep();
    requestAnimationFrame(keep);             // an editor that draws in the next frame
  }, { passive: false });
}

// The cursor of a brush: the outline of the cells it covers where it paints - its shape and its size,
// a cell cw x ch canvas pixels (the zoom; a multicolor pixel double wide) - drawn with ctx's stroke
// style and line width, on the edges between a cell of it and one outside it
export function outlineCells(ctx, cells, cw, ch) {
  const has = new Set(cells.map(p => `${p.x},${p.y}`)), out = (x, y) => !has.has(`${x},${y}`);
  const half = ctx.lineWidth / 2;            // the line inside the cells, so the edge of the canvas does not cut it
  ctx.beginPath();
  for (const { x, y } of cells) {
    const x0 = x * cw, y0 = y * ch, x1 = x0 + cw, y1 = y0 + ch;
    if (out(x, y - 1)) { ctx.moveTo(x0, y0 + half); ctx.lineTo(x1, y0 + half); }
    if (out(x, y + 1)) { ctx.moveTo(x0, y1 - half); ctx.lineTo(x1, y1 - half); }
    if (out(x - 1, y)) { ctx.moveTo(x0 + half, y0); ctx.lineTo(x0 + half, y1); }
    if (out(x + 1, y)) { ctx.moveTo(x1 - half, y0); ctx.lineTo(x1 - half, y1); }
  }
  ctx.stroke();
}

// the tool a shortcut key selects, null for other keys
export function toolForKey(tools, key) {
  return tools.find(t => t.shortcut === key)?.key ?? null;
}

// the cells {x, y} of the line from a to b (Bresenham)
export function lineCells(a, b) {
  const cells = [];
  let { x: x0, y: y0 } = a;
  const { x: x1, y: y1 } = b;
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    cells.push({ x: x0, y: y0 });
    if (x0 === x1 && y0 === y1) return cells;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

// the cells {x, y} a drag tool draws from a to b, with the drag's modifiers (dragMods);
// aspect: how many times wider than high a cell is (2 for multicolor pixels); bend: the
// control point of a curve, none yet: a line
export function dragCells(tool, a, b, { shift = false, ctrl = false, alt = false, aspect = 1, bend = null, radius = 0, poly = null, closed = false } = {}) {
  return tool === 'line' ? lineCells(a, b) : shapeCells(tool, a, b, { shift, ctrl, alt, aspect, bend, radius, poly, closed });
}

// The corners of the box tool: rounded with a radius of 0 (square) up to half the grid of w x h
// cells, whichever side is smaller (radiusMax). radiusTools: its slider in the bar, next to the
// brush, shown with the box tool only. o: { radius, tool, max, onchange(radius) }
export const radiusMax = ({ w = Infinity, h = Infinity }) => Math.max(0, Math.floor(Math.min(w, h) / 2));
export function radiusTools({ radius, tool, max, onchange }) {
  if (tool !== 'rect') return null;
  return h('div', { class: 'default-tools brush-tools radius-tools' },
    slider({ tip: tr('§1631', max), cls: 'brush-tools__size', min: 0, max, value: Math.min(radius, max),
      format: v => tr('§1632', v), oninput: onchange }));
}
