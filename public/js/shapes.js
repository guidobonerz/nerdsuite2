// shapes.js - the rectangle, circle, ellipse, curve and polygon tools of the screen, sprite, char and
// bitmap editors: the cells {x, y} of a shape dragged from a to b

// the outline of the ellipse that fits the box between two corners (A. Zingl's
// Bresenham ellipse, exact for boxes of even and odd size)
function ellipseRect(x0, y0, x1, y1) {
  const out = [];
  const set = (x, y) => out.push({ x, y });
  let a = Math.abs(x1 - x0), b = Math.abs(y1 - y0), b1 = b & 1;
  let dx = 4 * (1 - a) * b * b, dy = 4 * (b1 + 1) * a * a;
  let err = dx + dy + b1 * a * a;
  if (x0 > x1) { x0 = x1; x1 += a; }
  if (y0 > y1) y0 = y1;
  y0 += (b + 1) >> 1;
  y1 = y0 - b1;
  a = 8 * a * a;
  b1 = 8 * b * b;
  do {
    set(x1, y0); set(x0, y0); set(x0, y1); set(x1, y1);
    const e2 = 2 * err;
    if (e2 <= dy) { y0++; y1--; err += dy += a; }
    if (e2 >= dx || 2 * err > dy) { x0++; x1--; err += dx += b1; }
  } while (x0 <= x1);
  while (y0 - y1 <= b) {             // flat ellipses: the tips
    set(x0 - 1, y0); set(x1 + 1, y0++);
    set(x0 - 1, y1); set(x1 + 1, y1--);
  }
  return out;
}

function unique(cells) {
  const seen = new Set();
  return cells.filter(p => {
    const k = `${p.x},${p.y}`;
    return !seen.has(k) && seen.add(k);
  });
}

// every row from its leftmost to its rightmost cell
function filled(cells) {
  const rows = new Map();
  for (const { x, y } of cells) {
    const r = rows.get(y);
    rows.set(y, r ? [Math.min(r[0], x), Math.max(r[1], x)] : [x, x]);
  }
  return [...rows].flatMap(([y, [x0, x1]]) => Array.from({ length: x1 - x0 + 1 }, (_, k) => ({ x: x0 + k, y })));
}

// the cells of the quadratic Bezier curve from a to b that the control point c pulls towards
// it, one pixel thin: points along it no farther apart than a cell (it moves at most twice as
// fast as its hull is long), without the corner cells
// where it steps diagonally
function curveCells(a, c, b) {
  const n = Math.max(1, Math.ceil(2 * (Math.hypot(c.x - a.x, c.y - a.y) + Math.hypot(b.x - c.x, b.y - c.y))));
  const out = [];
  const near = (p, q) => Math.abs(p.x - q.x) <= 1 && Math.abs(p.y - q.y) <= 1;
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    const p = { x: Math.round(u * u * a.x + 2 * u * t * c.x + t * t * b.x), y: Math.round(u * u * a.y + 2 * u * t * c.y + t * t * b.y) };
    const last = out.at(-1);
    if (last && last.x === p.x && last.y === p.y) continue;
    if (out.length > 1 && near(out.at(-2), p)) out.pop();
    out.push(p);
  }
  return out;
}

// the box from (x0, y0) to (x1, y1) with rounded corners: a cell is in the box when its middle
// is inside the rounded shape - in a corner, inside the quarter ellipse of ry rows and rx
// columns (ry: the radius, at most half the box; rx: ry / aspect) a little in from its edge,
// so a radius of 1 takes the corner cell. Filled, or its outline: the cells of the box next to
// a cell outside it
function roundedBox(x0, y0, x1, y1, radius, aspect, fill) {
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const ry = Math.max(0, Math.min(radius, Math.floor(h / 2), Math.floor(w * aspect / 2)));
  const rx = Math.max(1, Math.round(ry / aspect));
  const inside = (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    if (!ry) return true;
    const px = x + 0.5, py = y + 0.5;
    const cx = px < x0 + rx ? x0 + rx : px > x1 + 1 - rx ? x1 + 1 - rx : null;
    const cy = py < y0 + ry ? y0 + ry : py > y1 + 1 - ry ? y1 + 1 - ry : null;
    if (cx === null || cy === null) return true;
    return Math.hypot((px - cx) / rx, (py - cy) / ry) <= (ry - 0.5) / ry;
  };
  const cells = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!inside(x, y)) continue;
      if (fill || !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1)) cells.push({ x, y });
    }
  }
  return cells;
}

// the cells of the line from a to b (Bresenham, as drawtools.js lineCells)
function lineBetween(a, b) {
  const out = [];
  let { x: x0, y: y0 } = a;
  const dx = Math.abs(b.x - x0), dy = -Math.abs(b.y - y0), sx = x0 < b.x ? 1 : -1, sy = y0 < b.y ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    out.push({ x: x0, y: y0 });
    if (x0 === b.x && y0 === b.y) return out;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

// the polygon through the corners pts: its sides, the last one back to the first when closed;
// fill (closed only): the cells whose middle is inside it (even-odd), with its sides
export function polygonCells(pts, closed, fill) {
  const sides = [];
  for (let i = 0; i + 1 < pts.length; i++) sides.push([pts[i], pts[i + 1]]);
  if (closed && pts.length > 2) sides.push([pts.at(-1), pts[0]]);
  const cells = pts.length === 1 ? [{ ...pts[0] }] : sides.flatMap(([a, b]) => lineBetween(a, b));
  if (fill && closed && pts.length > 2) {
    const ys = pts.map(p => p.y);
    for (let y = Math.min(...ys); y <= Math.max(...ys); y++) {
      const cy = y + 0.5, xs = [];
      for (const [a, b] of sides) {
        if ((a.y + 0.5 <= cy) === (b.y + 0.5 <= cy)) continue;     // the side does not cross the middle row
        xs.push(a.x + 0.5 + (cy - a.y - 0.5) * (b.x - a.x) / (b.y - a.y));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let x = Math.ceil(xs[k] - 0.5); x + 0.5 <= xs[k + 1]; x++) cells.push({ x, y });
      }
    }
  }
  return unique(cells);
}

// tool: 'rect' (a and b are corners of its box), 'circle' (the ellipse in the box from a to
// b; ctrl: a is the center of the box; alt: a circle - the box is as wide as high) or 'curve'
// (from a to b, bent towards its control point bend; without one a line).
// shift fills rectangles and circles. aspect: how many times wider than high a cell is
// (2 for multicolor pixels), so circles stay round. radius: the corners of the rectangle are
// rounded, quarter ellipses of radius rows (and radius / aspect columns), at most half the box
// (roundedBox). 'polygon': through the corners poly and, while it is open, on to b (the pointer);
// closed it goes back to its first corner, shift fills it.
export function shapeCells(tool, a, b, { shift = false, ctrl = false, alt = false, aspect = 1, bend = null, radius = 0, poly = null, closed = false } = {}) {
  if (tool === 'rect') {
    const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)], [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
    if (radius > 0) return roundedBox(x0, y0, x1, y1, radius, aspect, shift);
    const cells = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) if (shift || y === y0 || y === y1 || x === x0 || x === x1) cells.push({ x, y });
    }
    return cells;
  }
  if (tool === 'circle') {
    let { x: x1, y: y1 } = b;
    if (alt) {                        // a circle: the larger side of the box, in pixels, for both
      const r = Math.max(Math.abs(x1 - a.x) * aspect, Math.abs(y1 - a.y));
      x1 = a.x + (x1 < a.x ? -1 : 1) * Math.round(r / aspect);
      y1 = a.y + (y1 < a.y ? -1 : 1) * Math.round(r);
    }
    const x0 = ctrl ? 2 * a.x - x1 : a.x, y0 = ctrl ? 2 * a.y - y1 : a.y;   // ctrl: a in the middle
    const cells = ellipseRect(x0, y0, x1, y1);
    return unique(shift ? filled(cells) : cells);
  }
  if (tool === 'curve') return unique(curveCells(a, bend ?? a, b));
  if (tool === 'polygon') return polygonCells(closed ? poly : [...(poly ?? [a]), b], closed, shift);
  return [];
}
