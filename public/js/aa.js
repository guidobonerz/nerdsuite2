// aa.js - antialiased drawing for the bitmap editor: how much of each pixel a line, box, circle,
// curve or pencil stroke covers, and the palette color between the pen and the background that
// a covered part of a pixel gets.
//
// The shapes are the ideal ones through the middles of the pixels the tools use (shapes.js), as
// polylines; a pixel is covered by how near its middle comes to them, measured with the brush:
// round brushes by the distance, square ones by the larger of the two offsets. Coordinates are in
// pixels, x scaled by how the brush stretches a multicolor pixel (brushCells), so the brush has
// its width in both modes. Coverage 1 is the pen, less a color between the pen and the
// background: the C64 color nearest to their mix, or nothing when that is the background.

import { PALETTE } from './c64.js';

const RGB = PALETTE.map(hex => [1, 3, 5].map(k => parseInt(hex.slice(k, k + 2), 16)));
const MIN_COVER = 0.1;                    // less: the pixel is left alone

// the C64 color of a pixel covered by cov between pen and bg (palette indices)
export function shadeOf(cov, pen, bg) {
  if (cov >= 0.999 || pen === bg) return pen;
  const [p, b] = [RGB[pen], RGB[bg]], want = b.map((v, k) => v + (p[k] - v) * cov);
  let best = bg, dist = Infinity;
  RGB.forEach((c, i) => {
    // weighted like the eye sees it: green most, blue least
    const d = 3 * (c[0] - want[0]) ** 2 + 4 * (c[1] - want[1]) ** 2 + 2 * (c[2] - want[2]) ** 2;
    if (d < dist) { dist = d; best = i; }
  });
  return best;
}

// the brush as the geometry sees it: half its height, how much wider a unit of x is, the metric
function pen(brush, size, aspect) {
  return { half: size / 2, kx: size / Math.max(1, Math.round(size / aspect)), square: brush?.shape !== 'circle' };
}

// the distance of point (px, py) to the segment a-b: euclidean, or square (the larger offset)
function distance(px, py, ax, ay, bx, by, square) {
  const dx = bx - ax, dy = by - ay, u0 = ax - px, v0 = ay - py;
  if (!square) {
    const len = dx * dx + dy * dy, t = len ? Math.max(0, Math.min(1, -(u0 * dx + v0 * dy) / len)) : 0;
    return Math.hypot(u0 + t * dx, v0 + t * dy);
  }
  // max(|u(t)|, |v(t)|) is convex and piecewise linear in t: its least value is at an end or where a
  // part of it turns (u or v is 0, or |u| = |v|)
  const at = t => Math.max(Math.abs(u0 + t * dx), Math.abs(v0 + t * dy));
  let best = Math.min(at(0), at(1));
  for (const t of [dx && -u0 / dx, dy && -v0 / dy, dx !== dy && (v0 - u0) / (dx - dy), dx !== -dy && -(u0 + v0) / (dx + dy)]) {
    if (typeof t === 'number' && t > 0 && t < 1) best = Math.min(best, at(t));
  }
  return best;
}

// the polylines of a shape dragged from a to b (pixels), as shapeCells draws it: {paths, inside}
// with inside(x, y) true for the middles of the pixels a filled shape covers
export function aaShape(tool, a, b, { shift = false, ctrl = false, alt = false, aspect = 1, bend = null, poly = null, closed = false } = {}) {
  const mid = p => ({ x: p.x + 0.5, y: p.y + 0.5 });
  if (tool === 'line' || tool === 'pencil') return { paths: [[mid(a), mid(b)]] };
  if (tool === 'rect') {
    const x0 = Math.min(a.x, b.x) + 0.5, x1 = Math.max(a.x, b.x) + 0.5, y0 = Math.min(a.y, b.y) + 0.5, y1 = Math.max(a.y, b.y) + 0.5;
    return { paths: [[{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }, { x: x0, y: y0 }]],
      inside: shift ? (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1 : null };
  }
  if (tool === 'circle') {
    let { x: x1, y: y1 } = b;
    if (alt) {
      const r = Math.max(Math.abs(x1 - a.x) * aspect, Math.abs(y1 - a.y));
      x1 = a.x + (x1 < a.x ? -1 : 1) * Math.round(r / aspect);
      y1 = a.y + (y1 < a.y ? -1 : 1) * Math.round(r);
    }
    const x0 = ctrl ? 2 * a.x - x1 : a.x, y0 = ctrl ? 2 * a.y - y1 : a.y;
    const cx = (x0 + x1) / 2 + 0.5, cy = (y0 + y1) / 2 + 0.5, rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
    const n = Math.max(24, Math.ceil(2 * Math.PI * Math.max(rx * aspect, ry) * 1.5));
    const path = Array.from({ length: n + 1 }, (_, i) => ({ x: cx + rx * Math.cos(2 * Math.PI * i / n), y: cy + ry * Math.sin(2 * Math.PI * i / n) }));
    return { paths: [path], inside: shift && rx && ry ? (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1 : null };
  }
  if (tool === 'curve') {
    const c = bend ?? a, [p, q, r] = [mid(a), mid(c), mid(b)];
    const n = Math.max(1, Math.ceil(2 * (Math.hypot(q.x - p.x, q.y - p.y) + Math.hypot(r.x - q.x, r.y - q.y))));
    return { paths: [Array.from({ length: n + 1 }, (_, i) => {
      const t = i / n, u = 1 - t;
      return { x: u * u * p.x + 2 * u * t * q.x + t * t * r.x, y: u * u * p.y + 2 * u * t * q.y + t * t * r.y };
    })] };
  }
  if (tool === 'polygon') {                     // its sides; closed, back to the first corner - Shift fills it
    const pts = (closed ? poly : [...(poly ?? [a]), b]).map(mid);
    if (closed && pts.length > 2) pts.push(pts[0]);
    const inside = shift && closed && pts.length > 3 ? (x, y) => {
      let n = false;
      for (let i = 0; i + 1 < pts.length; i++) {
        const p = pts[i], q = pts[i + 1];
        if ((p.y > y) !== (q.y > y) && x < p.x + (y - p.y) * (q.x - p.x) / (q.y - p.y)) n = !n;
      }
      return n;
    } : null;
    return { paths: [pts], inside };
  }
  return { paths: [] };
}

// how much of each pixel of a w x h grid the shape covers: [{x, y, cov}], cov in (0, 1].
// paths: polylines in pixels (middles at .5), inside: see aaShape; size: the brush size in pixels
export function coverage({ paths, inside = null }, { brush, size = 1, aspect = 1, w, h }) {
  const { half, kx, square } = pen(brush, size, aspect), reach = half + 0.5;
  const cov = new Map();
  const put = (x, y, c) => {
    if (c < MIN_COVER) return;
    const key = y * w + x;
    if (c > (cov.get(key) ?? 0)) cov.set(key, Math.min(1, c));
  };
  for (const path of paths) {
    for (let i = 0; i < Math.max(1, path.length - 1); i++) {
      const a = path[i], b = path[i + 1] ?? a;
      const ax = a.x * kx, bx = b.x * kx;
      const xa = Math.max(0, Math.floor((Math.min(ax, bx) - reach) / kx - 0.5)), xb = Math.min(w - 1, Math.ceil((Math.max(ax, bx) + reach) / kx - 0.5));
      const ya = Math.max(0, Math.floor(Math.min(a.y, b.y) - reach - 0.5)), yb = Math.min(h - 1, Math.ceil(Math.max(a.y, b.y) + reach - 0.5));
      for (let y = ya; y <= yb; y++) {
        for (let x = xa; x <= xb; x++) put(x, y, reach - distance((x + 0.5) * kx, y + 0.5, ax, a.y, bx, b.y, square));
      }
    }
  }
  if (inside) {
    const xs = paths.flat().map(p => p.x), ys = paths.flat().map(p => p.y);
    const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(w - 1, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (inside(x + 0.5, y + 0.5)) put(x, y, 1);
  }
  return [...cov].map(([key, c]) => ({ x: key % w, y: Math.floor(key / w), cov: c }));
}
