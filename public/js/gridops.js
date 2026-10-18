// gridops.js - the range tools of the screen, sprite and char editors: shift (wrapping
// inside the range), mirror, flip, rotate (by 90 degrees, or turned in space about x, y and z),
// invert, map (swap two colors) and clear a grid of values, as a whole or
// inside a rectangle of it

const ROTATIONS = new Set(['rotl', 'rotr']);

const TRANSFORMS = {
  left: g => g.map(r => [...r.slice(1), r[0]]),
  right: g => g.map(r => [r.at(-1), ...r.slice(0, -1)]),
  up: g => [...g.slice(1), g[0]],
  down: g => [g.at(-1), ...g.slice(0, -1)],
  mirror: g => g.map(r => [...r].reverse()),
  flip: g => [...g].reverse(),
  rotr: g => g[0].map((_, c) => g.map(r => r[c]).reverse()),
  rotl: g => g[0].map((_, c) => g.map(r => r[r.length - 1 - c])),
};

export const isRotation = op => ROTATIONS.has(op);

// the map of the 'map' op that swaps two values, other values stay: swapping the pens of a
// sprite or char changes which color its pixels take, without redrawing them
export const swapValues = (a, b) => v => (v === a ? b : v === b ? a : v);

// the rectangle between two cells {x, y}, both included
export const rectBetween = (a, b) =>
  ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x) + 1, h: Math.abs(a.y - b.y) + 1 });

// rect {x, y, w, h} clipped to a w x h grid, null when nothing is left
export function clipRect(rect, w, h) {
  if (!rect) return null;
  const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
  const x1 = Math.min(w, rect.x + rect.w), y1 = Math.min(h, rect.y + rect.h);
  return x1 > x && y1 > y ? { x, y, w: x1 - x, h: y1 - y } : null;
}

// rotate: the values of area (of grid, a copy that changes) as a card turned in space about its
// middle - rx degrees about the x axis (the top tilts away), ry about the y axis (the right side
// turns away), rz about the z axis (clockwise in the plane), in that order - and seen again from
// the front: straight on, or with persp (0-100 %) in perspective, the far side smaller. A cell is
// aspect times as wide as high (multicolor: 2), so the picture keeps its proportions. The area is
// cleared to blank first, then every cell of the grid takes the value of the cell of the card it
// shows, unless that is blank - or, where the middle of the cell shows nothing, what most of the
// points inside it show (thin lines stay whole): what turns beyond the edges of the grid is cut
// off, a card seen edge on shows nothing. Returns the rectangle round what it wrote (the area when nothing)
function rotateArea(out, area, { rx = 0, ry = 0, rz = 0, persp = 0 }, blank, aspect) {
  const H = out.length, W = out[0].length;
  const { x, y, w, h } = area;
  const src = out.slice(y, y + h).map(r => r.slice(x, x + w));
  for (let r = y; r < y + h; r++) out[r].fill(blank, x, x + w);
  const rad = d => d * Math.PI / 180;
  const [ca, sa, cb, sb, cc, sc] = [rx, ry, rz].flatMap(d => [Math.cos(rad(d)), Math.sin(rad(d))]);
  // R = Rz Ry Rx: the first two columns (where the x and the y axis of the card go), and their z
  const r00 = cc * cb, r01 = cc * sb * sa - sc * ca;
  const r10 = sc * cb, r11 = sc * sb * sa + cc * ca;
  const r20 = -sb, r21 = cb * sa;
  // perspective: the eye at f before the middle - g = 1 / f, 0 straight on
  const g = (persp / 100) * 1.5 / Math.max(w * aspect, h);
  const cx = (x + w / 2) * aspect, cy = y + h / 2, e = 1e-9;
  // the value of the card at the point fx, fy of the grid (cells, fractions inside them), blank where
  // it shows nothing: dx = X / (1 + g Z), dy = Y / (1 + g Z) solved for the point u, v of the card
  const at = (fx, fy) => {
    const dx = fx * aspect - cx, dy = fy - cy;
    const a0 = r00 - dx * g * r20, a1 = r01 - dx * g * r21, b0 = r10 - dy * g * r20, b1 = r11 - dy * g * r21;
    const det = a0 * b1 - a1 * b0;
    if (Math.abs(det) < 1e-6) return blank;                          // the card edge on
    const u = (dx * b1 - a1 * dy) / det, v = (a0 * dy - dx * b0) / det;
    if (1 + g * (r20 * u + r21 * v) <= 0) return blank;              // behind the eye
    const sc0 = Math.floor((cx + u) / aspect + e) - x, sr = Math.floor(cy + v + e) - y;
    return sc0 < 0 || sr < 0 || sc0 >= w || sr >= h ? blank : src[sr][sc0];
  };
  // a cell takes the value at its middle. A line one pixel thin - tilted, squeezed or turned - may
  // fall between the middles and break, so a cell whose middle shows nothing looks at N x N points
  // inside it: how much of it the card covers, and with which value most. It takes that value when
  // it is covered at least as much as both its neighbours across the line - left and right, or above
  // and below - and not as much as both of them alike (the edge of a shape, which its middles draw)
  const N = 4, FULL = N * N;
  const vals = [], cover = [];
  for (let r = 0; r < H; r++) {
    vals.push(Array(W).fill(blank)); cover.push(new Uint8Array(W));
    for (let c = 0; c < W; c++) {
      const mid = at(c + 0.5, r + 0.5);
      if (mid !== blank) { vals[r][c] = mid; cover[r][c] = FULL; continue; }
      const count = new Map();
      let best = 0, n = 0;
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
        const v = at(c + (j + 0.5) / N, r + (i + 0.5) / N);
        if (v === blank) continue;
        n++;
        const k = (count.get(v) ?? 0) + 1;
        count.set(v, k);
        if (k > best) { best = k; vals[r][c] = v; }
      }
      cover[r][c] = n;
    }
  }
  const ridge = (k, a, b) => k >= a && k >= b && !(k === a && k === b);
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const k = cover[r][c];
      if (!k) continue;
      if (k < FULL && !ridge(k, cover[r][c - 1] ?? 0, cover[r][c + 1] ?? 0) && !ridge(k, cover[r - 1]?.[c] ?? 0, cover[r + 1]?.[c] ?? 0)) continue;
      out[r][c] = vals[r][c];
      x0 = Math.min(x0, c); y0 = Math.min(y0, r); x1 = Math.max(x1, c); y1 = Math.max(y1, r);
    }
  }
  return x1 < 0 ? area : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// grid: rows of values; op: left right up down mirror flip rotl rotr rotate invert map clear;
// rect: the part to change, null for the whole grid. blank: the value of cleared cells,
// invert(v): the inverted value, map(v): the value 'map' puts in place of v (swapValues).
// A rectangle that is not square rotates about its top
// left corner only with resize: the cells it leaves are cleared and the grid clips it.
// rotate: turned in space about the middle of the rectangle by rx, ry, rz degrees, persp the
// perspective, cells aspect times as wide as high (rotateArea) - its rect the one round the turned picture.
// Returns { grid, rect } - a copy, and the rectangle after a rotation - or null when
// the rotation is not possible.
export function regionOp(grid, op, rect, { blank = 0, invert = null, map = null, resize = false, rx = 0, ry = 0, rz = 0, persp = 0, aspect = 1 } = {}) {
  const H = grid.length, W = grid[0]?.length ?? 0;
  const out = grid.map(r => [...r]);
  const area = rect ? clipRect(rect, W, H) : { x: 0, y: 0, w: W, h: H };
  if (!area) return { grid: out, rect };
  if (op === 'rotate') return { grid: out, rect: rotateArea(out, area, { rx, ry, rz, persp }, blank, aspect) };
  const { x, y, w, h } = area;
  const turn = isRotation(op) && w !== h;
  if (turn && !resize) return null;
  const sub = out.slice(y, y + h).map(r => r.slice(x, x + w));
  const next = op === 'clear' ? sub.map(r => r.map(() => blank))
    : op === 'invert' ? sub.map(r => r.map(v => (invert ? invert(v) : v)))
      : op === 'map' ? sub.map(r => r.map(v => (map ? map(v) : v)))
        : TRANSFORMS[op](sub);
  if (turn) for (let r = y; r < y + h; r++) out[r].fill(blank, x, x + w);
  next.forEach((row, r) => row.forEach((v, c) => { if (y + r < H && x + c < W) out[y + r][x + c] = v; }));
  return { grid: out, rect: isRotation(op) ? clipRect({ x, y, w: h, h: w }, W, H) : area };
}
