// walkarea.js - the walk area of a place ('walk_area (X, Y) ...' without its block areas), as the compiler cuts it
// (advc/adv/walkarea.go) and the engine walks it (engine/walkarea.s, wazone.s): the same zones,
// the same edges to the walk unit, the same nearest point and the same route. The editor draws
// them and checks the polygon with it; editor/test/fixtures/walkarea.json holds what the
// compiler computes for a few areas, and the tests compare.
//
// Points are [x, y]: x in walk units (2 pixels), y in pixels (the feet of an actor).

export const MAX_WALK_CORNERS = 16;
export const MAX_WALK_ZONES = 16;
export const MAX_COND_BLOCKS = 3;     // block areas with 'unless' in a place: the compiler cuts 2^n areas

// the walk area pts with block areas blocks ([{ pts, cond }]) blocked: those without a condition
// always, those with one unless open(block) - the compiler's area for that way they are
export const walkAreaWith = (pts, blocks, open = () => false) => walkArea(pts, blocks.filter(b => !b.cond || !open(b)).map(b => b.pts));

// n / d rounded to the nearest integer, halves away from zero (d > 0), like divRound in Go
const divRound = (n, d) => (n >= 0 ? Math.trunc((2 * n + d) / (2 * d)) : -Math.trunc((-2 * n + d) / (2 * d)));
// x of an edge dy pixels below its x1: an arithmetic shift, like the engine
const xAt = (x1, slope, dy) => x1 + Math.floor((slope * dy) / 256);

const orient = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
function segmentsTouch(p1, p2, p3, p4) {
  const d1 = orient(p3, p4, p1), d2 = orient(p3, p4, p2), d3 = orient(p1, p2, p3), d4 = orient(p1, p2, p4);
  if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  const on = (a, b, p) => Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]);
  return (d1 === 0 && on(p3, p4, p1)) || (d2 === 0 && on(p3, p4, p2)) || (d3 === 0 && on(p1, p2, p3)) || (d4 === 0 && on(p1, p2, p4));
}

// the flat values of the attribute ([x, y, x, y, ...], numbers) as points
export const walkPoints = values => {
  const pts = [];
  for (let k = 0; k + 1 < values.length; k += 2) pts.push([Number(values[k]), Number(values[k + 1])]);
  return pts;
};

// what is wrong with a polygon of the walk area ('walk_area' or 'block_area'), or null
function polygonError(what, pts) {
  const n = pts.length;
  if (n < 3 || n > MAX_WALK_CORNERS) return `${what} needs 3-${MAX_WALK_CORNERS} corners, not ${n}`;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    if (a[0] === b[0] && a[1] === b[1]) return `${what}: corner ${a[0]} ${a[1]} comes twice in a row`;
    const dy = Math.abs(b[1] - a[1]);
    if (dy !== 0 && Math.abs(b[0] - a[0]) > 127 * dy) {
      return `${what}: the edge from ${a[0]} ${a[1]} to ${b[0]} ${b[1]} is too flat: make it horizontal or at most 127 walk units wide per pixel of height`;
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsTouch(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) {
        return `${what}: the edges from corner ${i + 1} and from corner ${j + 1} cross (the corners must go around the area once)`;
      }
    }
  }
  return null;
}

// the edges of a polygon that are not horizontal, the top end first
const polygonEdges = pts => pts.flatMap((a, i) => {
  let b = pts[(i + 1) % pts.length];
  if (a[1] === b[1]) return [];
  if (a[1] > b[1]) [a, b] = [b, a];
  return [{ x1: a[0], y1: a[1], x2: b[0], y2: b[1] }];
});

// the y above and below where edge e crosses edge f inside both (crossingYs in walkarea.go)
function crossingYs(e, f) {
  const dxe = e.x2 - e.x1, dye = e.y2 - e.y1, dxf = f.x2 - f.x1, dyf = f.y2 - f.y1;
  let den = dxe * dyf - dye * dxf;
  if (den === 0) return [];
  let tn = (f.x1 - e.x1) * dyf - (f.y1 - e.y1) * dxf, un = (f.x1 - e.x1) * dye - (f.y1 - e.y1) * dxe;
  if (den < 0) { den = -den; tn = -tn; un = -un; }
  if (tn <= 0 || tn >= den || un <= 0 || un >= den) return [];
  const num = e.y1 * den + dye * tn, lo = Math.trunc(num / den);
  return lo * den === num ? [lo] : [lo, lo + 1];
}

// the area of polygon pts without what the polygons of blocked cover (its 'block_area's): {
// zones, next } or { error }. A zone is { y1, y2, xl1, xr1, sl, sr }
export function walkArea(pts, blocked = []) {
  const err = polygonError('walk_area', pts) ?? blocked.reduce((e, b) => e ?? polygonError('block_area', b), null);
  if (err) return { error: err };
  const rings = [polygonEdges(pts), ...blocked.map(polygonEdges)];
  const ys = [...new Set([...pts, ...blocked.flat()].map(p => p[1]))];
  for (let i = 0; i < rings.length; i++) {
    for (let j = i + 1; j < rings.length; j++) {
      for (const e of rings[i]) for (const f of rings[j]) for (const y of crossingYs(e, f)) if (!ys.includes(y)) ys.push(y);
    }
  }
  ys.sort((a, b) => a - b);
  const zones = [];
  const edgeAt = (c, y) => divRound(c.x1 * (c.y2 - c.y1) + (c.x2 - c.x1) * (y - c.y1), c.y2 - c.y1);
  const slope = c => divRound((c.x2 - c.x1) * 256, c.y2 - c.y1);
  for (let k = 0; k + 1 < ys.length; k++) {
    const ya = ys[k], yb = ys[k + 1], mid2 = ya + yb;
    const spansOf = ring => {
      const edges = ring.filter(e => e.y1 <= ya && e.y2 >= yb).map(e => {
        const num = 2 * e.x1 * (e.y2 - e.y1) + (e.x2 - e.x1) * (mid2 - 2 * e.y1);
        return { order: Math.trunc((num * 1000) / (e.y2 - e.y1)), e };
      }).sort((p, q) => p.order - q.order);
      const out = [];
      for (let e = 0; e + 1 < edges.length; e += 2) out.push({ l: edges[e], r: edges[e + 1] });
      return out;
    };
    let walk = spansOf(rings[0]);
    for (const ring of rings.slice(1)) {          // without what the block areas cover
      for (const h of spansOf(ring)) {
        walk = walk.flatMap(s => {
          if (h.r.order <= s.l.order || h.l.order >= s.r.order) return [s];
          return [...(h.l.order > s.l.order ? [{ l: s.l, r: h.l }] : []), ...(h.r.order < s.r.order ? [{ l: h.r, r: s.r }] : [])];
        });
      }
    }
    for (const s of walk) {
      if (s.r.order - s.l.order < 2000) continue;   // narrower than a walk unit: a sliver beside a block area
      zones.push({ y1: ya, y2: yb, xl1: edgeAt(s.l.e, ya), xr1: edgeAt(s.r.e, ya), sl: slope(s.l.e), sr: slope(s.r.e) });
    }
  }
  if (!zones.length) return { error: blocked.length ? 'walk_area has no inside: the block areas cover it' : 'walk_area has no inside: its corners do not span a height' };
  if (zones.length > MAX_WALK_ZONES) return { error: `walk_area is cut into ${zones.length} zones, at most ${MAX_WALK_ZONES}: fewer corners at different heights` };
  const area = { zones, next: [] };
  routeTable(area);
  return area;
}

// x, y clamped into zone z: y into its height, then x between its edges there (wa_in_zone)
export function inZone(area, z, x, y) {
  const w = area.zones[z];
  const py = Math.min(Math.max(y, w.y1), w.y2);
  const [l, r] = zoneBounds(area, z, py);
  return [Math.min(Math.max(x, l), r), py];
}

// the x of the edges of zone z at y
export function zoneBounds(area, z, y) {
  const w = area.zones[z];
  return [xAt(w.xl1, w.sl, y - w.y1), xAt(w.xr1, w.sr, y - w.y1)];
}

const portalY = (area, i, j) => {
  const a = area.zones[i], b = area.zones[j];
  return a.y2 === b.y1 ? a.y2 : a.y1 === b.y2 ? a.y1 : -1;
};

// the walk units zones i and j share at the y where they meet: [lo, hi], or null
export function portal(area, i, j) {
  const y = portalY(area, i, j);
  if (y < 0) return null;
  const [l1, r1] = zoneBounds(area, i, y), [l2, r2] = zoneBounds(area, j, y);
  const lo = Math.max(l1, l2), hi = Math.min(r1, r2);
  return hi >= lo ? { y, lo, hi } : null;
}

function routeTable(area) {
  const n = area.zones.length;
  const nb = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (area.zones[i].y2 !== area.zones[j].y1) continue;
      const p = portal(area, i, j);
      if (p && p.hi - p.lo >= 1) { nb[i].push(j); nb[j].push(i); }
    }
  }
  nb.forEach(l => l.sort((a, b) => a - b));
  area.next = Array.from({ length: n }, () => Array(n).fill(0));
  for (let b = 0; b < n; b++) {
    const dist = Array(n).fill(-1);
    dist[b] = 0;
    const queue = [b];
    while (queue.length) {
      const z = queue.shift();
      for (const m of nb[z]) if (dist[m] < 0) { dist[m] = dist[z] + 1; queue.push(m); }
    }
    for (let z = 0; z < n; z++) {
      area.next[z][b] = z;
      if (z === b) continue;
      if (dist[z] < 0) { area.next[z][b] = 0x80 | nearestReachable(area, z, b, nb); continue; }   // a block area cuts b off
      const m = nb[z].find(x => dist[x] === dist[z] - 1);
      if (m != null) area.next[z][b] = m;
    }
  }
}

// the zone that zone z can walk to nearest to the middle of zone b (the lowest number wins a tie)
function nearestReachable(area, z, b, nb) {
  const w = area.zones[b], ym = Math.trunc((w.y1 + w.y2) / 2);
  const [l, r] = zoneBounds(area, b, ym), xm = Math.trunc((l + r) / 2);
  const seen = new Set([z]), queue = [z];
  while (queue.length) for (const m of nb[queue.shift()]) if (!seen.has(m)) { seen.add(m); queue.push(m); }
  let best = z, bestD = -1;
  area.zones.forEach((_, q) => {
    if (!seen.has(q)) return;
    const [px, py] = inZone(area, q, xm, ym), d = Math.abs(xm - px) + Math.abs(ym - py);
    if (bestD < 0 || d < bestD) { best = q; bestD = d; }
  });
  return best;
}

// the point of the area nearest to x, y (|dx| + |dy|, the first zone wins a tie): { zone, x, y }
export function clampToArea(area, x, y) {
  let best = null;
  area.zones.forEach((w, z) => {
    const py = Math.min(Math.max(y, w.y1), w.y2);
    const [l, r] = zoneBounds(area, z, py);
    const px = Math.min(Math.max(x, l), r);
    const d = Math.abs(x - px) + Math.abs(y - py);
    if (!best || d < best.d) best = { d, zone: z, x: px, y: py };
  });
  return { zone: best.zone, x: best.x, y: best.y };
}

// the points an actor at x, y walks through to tx, ty: the portals, then the target (one a block
// area cuts off: the nearest point it can reach)
export function walkRoute(area, x, y, tx, ty) {
  let z = clampToArea(area, x, y).zone;
  let fz = clampToArea(area, tx, ty).zone;
  if (area.next[z][fz] & 0x80) {                   // out of reach: to the nearest point of the zone nearest to it
    fz = area.next[z][fz] & 0x7f;
    [tx, ty] = inZone(area, fz, tx, ty);
  }
  const pts = [];
  for (let guard = 0; z !== fz && guard < area.zones.length; guard++) {
    const nz = area.next[z][fz];
    if (nz === z) break;
    const p = portal(area, z, nz);
    x = Math.min(Math.max(x, p.lo), p.hi);
    y = p.y;
    pts.push([x, y]);
    z = nz;
  }
  pts.push([tx, ty]);
  return pts;
}

// the outline of a zone as four points, for drawing: top left, top right, bottom right, bottom left
export function zoneOutline(area, z) {
  const w = area.zones[z];
  const [l2, r2] = zoneBounds(area, z, w.y2);
  return [[w.xl1, w.y1], [w.xr1, w.y1], [r2, w.y2], [l2, w.y2]];
}
