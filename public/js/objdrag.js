// objdrag.js - move and resize object hotspots and walk-to points on a place canvas
//
// Used by the screen editor and the inspector place preview. The canvas shows the
// whole place, one character cell is canvas.width / place width pixels.

import { t } from './i18n.js';
import { placeRows, getAttr } from './adv.js';
import { placeWidth, setObjAttr, numValue } from './advgen.js';
import { objectsInPlace, objectRect, constMap, actorsInPlace, actorPos, actorBox, actorSize, layeredShift, moveLayered, placeInfo, defaultWalkto } from './c64.js';

const CURSORS = {
  move: 'move', actor: 'move', walkto: 'grab', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize',
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// walk-to point of an object in canvas pixels (default: below the hotspot, like the compiler)
function walkPoint(game, place, obj, s) {
  const consts = constMap(game);
  const r = objectRect(obj, consts, game);
  const wt = r.walkto ?? defaultWalkto(placeInfo(game, place), r);
  return { x: wt.x * s / 4, y: (wt.y - 8) * s / 8 };
}

// {obj, part} under a canvas position. Resize handles only on the selected object.
export function hitTest(game, place, px, py, s, selectedId) {
  // actors are drawn on top of the hotspots
  for (const a of actorsInPlace(game, place).reverse()) {
    const b = actorBox(actorPos(game, place, a), ...actorSize(game, a));
    const u = s / 8;
    if (px >= b.x * u && px < (b.x + b.w) * u && py >= b.y * u && py < (b.y + b.h) * u) return { obj: a, part: 'actor' };
  }
  const consts = constMap(game);
  const objs = objectsInPlace(game, place);
  const sel = objs.find(o => o.id === selectedId);
  if (sel) {
    const p = walkPoint(game, place, sel, s);
    if (Math.hypot(px - p.x, py - p.y) <= Math.max(6, s * 0.5)) return { obj: sel, part: 'walkto' };
  }
  const t = clamp(s / 3, 3, 6);
  for (const o of [sel, ...objs.slice().reverse()]) {
    if (!o) continue;
    const r = objectRect(o, consts, game);
    const x0 = r.col * s, y0 = r.row * s, x1 = (r.col + r.w) * s, y1 = (r.row + r.h) * s;
    if (px < x0 - t || px > x1 + t || py < y0 - t || py > y1 + t) continue;
    if (o === sel) {                     // resizing an object on layers gives it a hotspot of its own
      const v = Math.abs(py - y0) <= t ? 'n' : Math.abs(py - y1) <= t ? 's' : '';
      const hz = Math.abs(px - x0) <= t ? 'w' : Math.abs(px - x1) <= t ? 'e' : '';
      if (v || hz) return { obj: o, part: v + hz };
    }
    if (px >= x0 && px < x1 && py >= y0 && py < y1) return { obj: o, part: 'move' };
  }
  return null;
}

// arrow keys: move by one cell, or resize with shift; an object on layers moves its layers
export function nudgeObject(store, place, obj, dc, dr, resize, source) {
  const consts = constMap(store.game);
  const width = placeWidth(place, consts);
  const r = objectRect(obj, consts, store.game);
  if (r.layer && !resize) {
    const d = layeredShift(r, dc, dr, width, placeRows(place, store.game));
    store.mutate(() => moveLayered(obj, r, d.dc, d.dr, consts), { key: `nudge:${obj.id}:layer`, source });
    return;
  }
  store.mutate(() => {
    if (resize && r.layer && !r.own) setObjAttr(obj, 'at', [String(r.col), String(r.row)]);
    if (resize) setObjAttr(obj, 'size', [String(clamp(r.w + dc, 1, width - r.col)), String(clamp(r.h + dr, 1, placeRows(place, store.game) - r.row))]);
    else setObjAttr(obj, 'at', [String(clamp(r.col + dc, 0, width - r.w)), String(clamp(r.row + dr, 0, placeRows(place, store.game) - r.h))]);
  }, { key: `nudge:${obj.id}:${resize}`, source });
}

// opts: store, place(), selected(), enabled(event), source, selectOnDown,
//       onSelect(id), onHover(id), onChange(), onDone(), onPreview(rect), onCreate(rect)
export function attachObjectDrag(canvas, o) {
  let drag = null, token = 0, hoverId = null;

  const geom = () => {
    const place = o.place();
    const consts = constMap(o.store.game);
    const width = placeWidth(place, consts);
    return { place, consts, width, rows: placeRows(place, o.store.game), s: canvas.width / width };
  };
  const pos = e => {
    const r = canvas.getBoundingClientRect();
    return { px: (e.clientX - r.left) * canvas.width / r.width, py: (e.clientY - r.top) * canvas.height / r.height };
  };
  const cellOf = (g, px, py) => ({ c: clamp(Math.floor(px / g.s), 0, g.width - 1), r: clamp(Math.floor(py / g.s), 0, g.rows - 1) });
  const rectOf = (a, b) => ({ col: Math.min(a.c, b.c), row: Math.min(a.r, b.r), w: Math.abs(a.c - b.c) + 1, h: Math.abs(a.r - b.r) + 1 });
  const consume = e => { e.preventDefault(); e.stopImmediatePropagation(); };

  canvas.addEventListener('pointerdown', e => {
    if (!o.enabled(e) || e.button !== 0 || !o.place()) return;
    consume(e);
    const g = geom();
    const { px, py } = pos(e);
    const hit = hitTest(o.store.game, g.place, px, py, g.s, o.selected());
    canvas.setPointerCapture(e.pointerId);
    token++;
    if (hit) {
      const r = hit.part === 'actor' ? actorPos(o.store.game, g.place, hit.obj) : objectRect(hit.obj, g.consts, o.store.game);
      drag = { ...hit, r, px, py, moved: false };
      if (o.selectOnDown && hit.obj.id !== o.selected()) o.onSelect?.(hit.obj.id);
    } else if (o.onCreate) {
      const c = cellOf(g, px, py);
      drag = { create: true, a: c, b: c };
      o.onPreview?.(rectOf(c, c));
    } else {
      drag = null;
    }
  }, true);

  canvas.addEventListener('pointermove', e => {
    if (!o.place()) return;
    if (!drag && !o.enabled(e)) {             // not working on objects now (screen editor: Shift is up)
      if (hoverId) { hoverId = null; o.onHover?.(null); }
      return;
    }
    e.stopImmediatePropagation();
    const g = geom();
    const { px, py } = pos(e);
    if (!drag) {
      const hit = hitTest(o.store.game, g.place, px, py, g.s, o.selected());
      canvas.style.cursor = hit ? CURSORS[hit.part] : o.onCreate ? 'crosshair' : 'default';
      const how = !hit ? '' : hit.part === 'move' || hit.part === 'actor' ? '§1127' : hit.part === 'walkto' ? '§1128' : '§1129';
      canvas.title = hit ? `${hit.obj.name} - ${t(how)}` : '';          // the name of the game stays
      const id = hit?.obj.id ?? null;
      if (id !== hoverId) { hoverId = id; o.onHover?.(id); }
      return;
    }
    if (drag.create) {
      drag.b = cellOf(g, px, py);
      o.onPreview?.(rectOf(drag.a, drag.b));
      return;
    }
    const { obj, part, r } = drag;
    const dc = Math.round((px - drag.px) / g.s), dr = Math.round((py - drag.py) / g.s);
    let apply;
    if (part === 'actor') {
      const x = clamp(r.x + Math.round((px - drag.px) * 4 / g.s), 0, g.width * 4 - 1);
      const y = clamp(r.y + Math.round((py - drag.py) * 8 / g.s), 0, 199);
      const cur = actorPos(o.store.game, g.place, obj);
      if (cur.x === x && cur.y === y) return;
      apply = () => setObjAttr(obj, 'at', [String(x), String(y)]);
    } else if (part === 'walkto') {
      const x = clamp(Math.round(px * 4 / g.s), 0, g.width * 4 - 1);
      const y = clamp(Math.round(py * 8 / g.s) + 8, 0, 199);
      const cur = objectRect(obj, g.consts, o.store.game).walkto;
      if (cur && cur.x === x && cur.y === y) return;
      apply = () => setObjAttr(obj, 'walkto', [String(x), String(y)]);
    } else {
      let { col, row, w, h } = r;
      if (part === 'move') {
        col = clamp(r.col + dc, 0, g.width - r.w);
        row = clamp(r.row + dr, 0, g.rows - r.h);
      } else {
        if (part.includes('w')) { col = clamp(r.col + dc, 0, r.col + r.w - 1); w = r.w + r.col - col; }
        if (part.includes('e')) w = clamp(r.w + dc, 1, g.width - r.col);
        if (part.includes('n')) { row = clamp(r.row + dr, 0, r.row + r.h - 1); h = r.h + r.row - row; }
        if (part.includes('s')) h = clamp(r.h + dr, 1, g.rows - r.row);
      }
      const cur = objectRect(obj, g.consts, o.store.game);
      if (part === 'move' && cur.layer) {   // its layers go along, and stay inside the place
        const d = layeredShift(cur, r.col + dc - cur.col, r.row + dr - cur.row, g.width, g.rows);
        if (!d.dc && !d.dr) return;
        apply = () => moveLayered(obj, cur, d.dc, d.dr, g.consts);
      } else {
        if (cur.col === col && cur.row === row && cur.w === w && cur.h === h) return;
        apply = () => {                       // resized on layers: a hotspot of its own, at and size
          setObjAttr(obj, 'at', [String(col), String(row)]);
          if (cur.layer || w !== cur.w || h !== cur.h || obj.attrs.some(a => a.key === 'size')) setObjAttr(obj, 'size', [String(w), String(h)]);
        };
      }
    }
    o.store.mutate(apply, { key: `objdrag:${token}`, source: o.source });
    drag.moved = true;
    o.onChange?.();
  }, true);

  const up = e => {
    if (!drag) return;
    e.stopImmediatePropagation();
    const d = drag;
    drag = null;
    if (d.create) {
      o.onPreview?.(null);
      o.onCreate(rectOf(d.a, d.b));
    } else if (d.moved) {
      o.onDone?.();
    } else if (!o.selectOnDown) {
      o.onSelect?.(d.obj.id);
    }
  };
  canvas.addEventListener('pointerup', up, true);
  canvas.addEventListener('pointercancel', up, true);
  canvas.addEventListener('pointerleave', () => {
    if (!drag && hoverId) { hoverId = null; o.onHover?.(null); }
  });
}
