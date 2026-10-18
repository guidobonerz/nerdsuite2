// c64.js - C64 palette and place renderer
//
// Characters are drawn from the bytes of the C64 character ROM (chargen.js) or of the
// place's charset file, pixel by pixel. The C64 Pro Mono font (fonts/, (c) Style) is only
// the font of C64 text in the page: the maps in the code views, the texts of Play.

import { walkPoints, walkAreaWith, clampToArea, zoneOutline } from './walkarea.js';
import {
  symbols, getAttr, objectHome, objectStartPlace, placeRows, gameRows, DEFAULT_SPRITES, SPRITE_COLS, SPRITE_ROWS, SPRITE_DEFAULTS, MC_PIXELS, spriteWidth,
  costumeFrame, costumeSize, viewAnim, defaultFrame, layerMulticolor, animSequence, setSpriteGeometry } from './adv.js';
import { numValue, placeWidth, setObjAttr, behindRects, behindPolygons } from './advgen.js';
import { resolveMap } from './petscii.js';
import { charsetData, CHARSET_SIZE } from './chr.js';
import { CHARGEN } from './chargen.js';
import { VIC2_COLORS, onVideoChange, colorMask, mcPens, isMcCell, video, ATARI_REGS, atariCellColors } from './video.js';
import { atariFont } from './atarifont.js';
import { machineFont } from './romfonts.js';

// the colours of the machine of the project (video.js): the C64's, the VIC-20's, the 128 of the TED ...
// One array that changes its contents, so every editor that imports it draws in the new colours
export const PALETTE = [...VIC2_COLORS];

// the palette as pixels of an ImageData (little endian: 0xAABBGGRR)
const PIXELS = [];
const toPixel = c => (0xff000000 | parseInt(c.slice(5, 7), 16) << 16 | parseInt(c.slice(3, 5), 16) << 8 | parseInt(c.slice(1, 3), 16)) >>> 0;
function usePalette(colors) {
  // as many entries as a colour value can reach (video.js colorMask): the CPC's 27 in 32, the rest black
  const all = [...colors, ...Array(Math.max(0, colorMask() + 1 - colors.length)).fill('#000000')];
  PALETTE.splice(0, PALETTE.length, ...all);
  PIXELS.splice(0, PIXELS.length, ...all.map(toPixel));
}
usePalette(VIC2_COLORS);
onVideoChange(v => { usePalette(v.palette.colors); setSpriteGeometry(v.sprite); });   // the sprites of the machine too (adv.js)

// the font of C64 text in the page (css/app.css)
export const C64_FONT = '"C64 Pro Mono"';

export function constMap(game) {
  return Object.fromEntries(symbols(game).consts.map(c => [c.name, c.value]));
}

export function colorIndex(v, consts, fallback = 0) {
  const n = numValue(v, consts);
  return n == null ? fallback : n & colorMask();
}

export function placeInfo(game, place) {
  const S = symbols(game);
  const consts = constMap(game);
  const attr = (k, d) => getAttr(place, k)?.[0] ?? d;
  const width = placeWidth(place, consts);
  const info = {
    consts,
    width,
    rows: placeRows(place, game),
    bg: colorIndex(attr('bgcolor', '0'), consts),
    border: colorIndex(attr('border', '0'), consts),
    textcolor: colorIndex(attr('textcolor', '15'), consts, 15),
    walkbox: (getAttr(place, 'walkbox') ?? ['0', '100', String(width * 4 - 1), String((gameRows(game) + 1) * 8 - 1)]).map(v => numValue(v, consts) ?? 0),
    screenFile: getAttr(place, 'screen'),
    charset: place.canvas?.charset ?? S.charset,              // the directory art: upper case, whatever the game's
    chrFile: getAttr(place, 'charset') ?? null,
    multicolor: getAttr(place, 'multicolor')?.map((v, k) => colorIndex(v, consts, 8 + k)) ?? null,
    // extended color mode: $d022-$d024, the backgrounds 2-4 of the chars 64-255 (bits 6-7 of a screen code)
    ecm: getAttr(place, 'ecm')?.map((v, k) => colorIndex(v, consts, 2 + k)) ?? null,
  };
  if (info.ecm) info.multicolor = null;                         // the VIC shows nothing with both
  info.chr = info.chrFile ? charsetData(info.chrFile) : null;      // custom charset bytes once loaded
  if (video().cells === 'atari') atariLook(info, place, consts);
  // the behind areas as the engine keeps them (strips of cells), and as the editor draws them
  info.behind = behindRects(place, consts, width, info.rows);
  info.behindPolys = behindPolygons(place, consts);
  // a walk area: its corners, its zones (walkarea.js, null when the polygon is wrong) and the box
  // around it, where the walkbox was. Its block areas ('block_area', [{ pts, cond }]) are cut out of
  // the zones - all of them, as the compiler's area before the conditions are read
  info.blocks = placeBlocks(place, consts);
  info.blockPolys = info.blocks.map(b => b.pts);
  const wa = getAttr(place, 'walkarea');
  if (wa) {
    info.walkPts = walkPoints(wa.map(v => numValue(v, consts) ?? 0));
    const area = walkAreaWith(info.walkPts, info.blocks);
    info.walkarea = area.error ? null : area;
    const xs = info.walkPts.map(p => p[0]), ys = info.walkPts.map(p => p[1]);
    info.walkbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  const bg = place.members.find(m => m.kind === 'background');
  Object.assign(info, resolveMap(bg?.lines ?? [], bg?.colors, width, info.rows, info.textcolor, info.charset));
  info.colors = cellColors(info, info.chars, info.colors);
  return info;
}

// an Atari screen (video.js 'atari'): the colours of its cells come from its chars and its five colour registers
// ('registers' COLOR0-COLOR4), the 256 codes are 128 glyphs of its font - ANTIC 2 (no 'multicolor') shows codes
// 128-255 inverse, ANTIC 4 the same glyphs in COLOR3 for their 11 pairs
const atariViews = new WeakMap();                 // font -> { 2: its 256 codes in ANTIC 2, 4: in ANTIC 4 }
function atariView(font, antic4) {
  if (!atariViews.has(font)) atariViews.set(font, {});
  const views = atariViews.get(font), key = antic4 ? 4 : 2;
  if (!views[key]) {
    const out = new Uint8Array(2048);
    out.set(font.subarray(0, 1024));
    for (let k = 0; k < 1024; k++) out[1024 + k] = antic4 ? font[k] : font[k] ^ 0xff;
    views[key] = out;
  }
  return views[key];
}
function atariLook(info, place, consts) {
  const regs = getAttr(place, 'registers')?.map((v, k) => colorIndex(v, consts, ATARI_REGS[k])) ?? [...ATARI_REGS];
  while (regs.length < 5) regs.push(ATARI_REGS[regs.length]);
  const antic4 = !!info.multicolor;
  info.atari = { regs, antic4 };
  info.chr = atariView(info.chr ?? atariFont(), antic4);
  info.bg = antic4 ? regs[4] : regs[2];
  info.border = regs[4];
  info.textcolor = antic4 ? regs[2] : regs[1];
  info.multicolor = antic4 ? [regs[0], regs[1]] : null;
  info.ecm = null;
}
// the colours of the cells of chars on an Atari screen (patches, brushes); others keep theirs
export const cellColors = (info, chars, colors) => (info.atari ? atariCellColors(chars, info.atari.regs, info.atari.antic4) : colors);

// the areas an actor is behind, like the engine (ds_behind in depth.s): the sprites of an actor
// are one box, its lower edge the feet. It is behind an area while its feet are below the area's
// top edge and above its base - the line the wall of the area runs along (ds_wall): its bottom
// edge, the lowest edge of its polygon for a strip of one - and the box (24 * W wide) reaches
// across its columns. p: the feet in walk units, cw: its sprites across
export const behindAreas = (info, p, cw = 1) => (info.behind ?? []).filter(([col, row, w, h, base = row + h]) =>
  (row + 1) * 8 < p.y && p.y < (base + 1) * 8 && p.x * 2 - 12 * cw < (col + w) * 8 && p.x * 2 + 12 * cw > col * 8);

export const isBehind = (info, p, cw = 1) => behindAreas(info, p, cw).length > 0;

// a pixel of the place (x, y in pixels) is a visible pixel of a char in one of the areas: a set
// pixel whose color is not the background of the place - in a multicolor cell the color of its
// pair ($d022, $d023 or the cell's own). chr: the charset bytes
export function scenery(info, chr, areas, x, y) {
  const col = x >> 3, row = y >> 3;
  if (x < 0 || y < 0 || !areas.some(([c, r, w, h]) => c <= col && col < c + w && r <= row && row < r + h)) return false;
  const k = row * info.width + col, code = info.chars?.[k] ?? 32, color = info.colors?.[k] ?? 0;
  const g = chr[(code & (info.ecm ? 63 : 0xff)) * 8 + (y & 7)];
  if (info.multicolor && color & 8) {
    const v = g >> (6 - (x & 6)) & 3;
    return v !== 0 && (v === 3 ? color & 7 : info.multicolor[v - 1]) !== info.bg;
  }
  return (g >> (7 - (x & 7)) & 1) !== 0 && (color & 15) !== info.bg;
}

export function objectsInPlace(game, place) {
  return symbols(game).objects.filter(o => objectHome(game, o) === place || objectStartPlace(game, o) === place.name);
}

// the block areas of a place: [{ pts, cond }] - the corners (walk units, feet pixels) and the
// condition text that opens it ('unless COND'), null for one that is always blocked
export function placeBlocks(place, consts) {
  return place.members.filter(m => m.kind === 'attr' && m.key === 'blockarea')
    .map(m => ({ pts: walkPoints(m.values.map(v => numValue(v, consts) ?? 0)), cond: m.cond || null }));
}

export function actorsInPlace(game, place) {
  return symbols(game).actors.filter(a => objectHome(game, a) === place || objectStartPlace(game, a) === place.name);
}

// start position of an actor (feet, walk units); default like the compiler: at the front of the
// walkbox, or the point of the walk area nearest to it
export function actorPos(game, place, actor) {
  const consts = constMap(game);
  const at = actor.attrs.find(x => x.key === 'at')?.values;
  const wb = getAttr(place, 'walkbox');
  const wa = !at && getAttr(place, 'walkarea');
  if (wa) {
    const pts = walkPoints(wa.map(v => numValue(v, consts) ?? 0)), area = walkAreaWith(pts, placeBlocks(place, consts));
    if (!area.error) {
      const p = clampToArea(area, 80, Math.max(...pts.map(q => q[1])));
      return { x: p.x, y: p.y };
    }
  }
  return { x: numValue(at?.[0] ?? '80', consts) ?? 80, y: numValue(at?.[1] ?? wb?.[3] ?? '120', consts) ?? 120 };
}

// the default walk-to point of an object with hotspot r (place columns and rows) in a place
// (placeInfo): below the hotspot on the front edge of the walkbox, or the point of the walk area
// nearest to the feet below the hotspot - like the compiler
export function defaultWalkto(info, r) {
  if (info.walkarea) {
    const p = clampToArea(info.walkarea, (r.col * 2 + r.w) * 2, (r.row + r.h) * 8);
    return { x: p.x, y: p.y };
  }
  const [x1, , x2, y2] = info.walkbox;
  return { x: Math.min(Math.max((r.col * 2 + r.w) * 2, x1), x2), y: y2 };
}

// sprite box of an actor in place pixels: 24 x 21, feet 8 rows above... as the engine places it
// a W x H sprite costume is centered on the feet like the engine places it
export const actorBox = (p, w = 1, h = 1) => ({ x: p.x * 2 - 12 - (w - 1) * 12, y: p.y - 9 - 21 * h, w: 24 * w, h: 21 * h });

// the size of an actor's costume in sprites [W, H]
export function actorSize(game, actor) {
  const name = actor.attrs.find(x => x.key === 'costume')?.values[0];
  return costumeSize(name && name !== 'default' ? symbols(game).costumes.find(c => c.name === name) : null);
}

// an actor behind scenery, like the engine masks it (engine/mask.s): drawn on a canvas of its
// own, without its pixels over visible char pixels of the areas it is behind - a multicolor
// costume loses whole pairs. b: its box in place pixels, u: canvas pixels per place pixel
export function drawBehind(ctx, info, areas, u, b, mc, paint) {
  const chr = info.chr ?? romCharset(info.charset);
  if (typeof document === 'undefined') { paint(ctx); return; }
  const x0 = Math.max(0, Math.floor(b.x * u)), y0 = Math.max(0, Math.floor(b.y * u));
  const x1 = Math.min(ctx.canvas.width, Math.ceil((b.x + b.w) * u)), y1 = Math.min(ctx.canvas.height, Math.ceil((b.y + b.h) * u));
  if (x1 <= x0 || y1 <= y0) return;
  const off = document.createElement('canvas');
  off.width = x1 - x0;
  off.height = y1 - y0;
  const octx = off.getContext('2d');
  octx.imageSmoothingEnabled = false;
  octx.translate(-x0, -y0);
  paint(octx);
  const img = octx.getImageData(0, 0, off.width, off.height), px = img.data;
  const hidden = new Map();
  const hides = (x, y) => {                   // a pixel of the place, a pair for a multicolor sprite
    const key = y * 4096 + x;
    if (!hidden.has(key)) hidden.set(key, mc ? scenery(info, chr, areas, x & ~1, y) || scenery(info, chr, areas, x | 1, y) : scenery(info, chr, areas, x, y));
    return hidden.get(key);
  };
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = ((y - y0) * off.width + (x - x0)) * 4;
      if (px[o + 3] && hides(Math.floor(x / u), Math.floor(y / u))) px[o + 3] = 0;
    }
  }
  octx.putImageData(img, 0, 0);
  ctx.drawImage(off, x0, y0);
}

function drawActors(ctx, game, place, info, s, opts) {
  const S = symbols(game);
  const u = s / 8;
  const actorColor = colorIndex(S.colors.find(c => c.key === 'actor')?.value ?? '7', info.consts, 7);
  // back to front like the engine (engine/depth.s): the actor further down is in front; on the
  // same y the one first in the script is in front, so it is drawn last
  const order = actorsInPlace(game, place).map((a, i) => ({ a, i, p: actorPos(game, place, a) }))
    .sort((m, n) => m.p.y - n.p.y || n.i - m.i);
  for (const { a, p } of order) {
    const attr = key => a.attrs.find(x => x.key === key)?.values?.[0];
    const costume = attr('costume');
    const cos = costume && S.costumes.find(c => c.name === costume);
    const [cw, ch] = costumeSize(cos);
    const b = actorBox(p, cw, ch);
    const stand = S.sprites.find(sp => sp.name === 'stand');
    const color = colorIndex(attr('color') ?? String(actorColor), info.consts, actorColor);
    const face = attr('face') ?? 'right';
    const view = cos && viewAnim(cos, 'stand', face);
    const paint = c => cos
      ? drawCostumeFrame(c, game, cos, (view && animSequence(view.anim)[0]) ?? defaultFrame(cos) ?? cos.frames[0]?.name, b.x, b.y, u, color, view ? view.mirror : face === 'left')
      : drawSprite(c, stand?.lines ?? DEFAULT_SPRITES.stand, !!stand?.multicolor, b.x, b.y, u, [color, ...spriteColors(game)], face === 'left');
    const areas = behindAreas(info, p, cw);
    if (areas.length) drawBehind(ctx, info, areas, u, b, !!(cos ? cos.multicolor : stand?.multicolor), paint);
    else paint(ctx);
    const sel = a.id === opts.selected, hov = a.id === opts.hover;
    if (sel || hov) {
      ctx.strokeStyle = sel ? '#ffd54f' : '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(b.x * u, b.y * u, b.w * u, b.h * u);
    }
    if (sel || hov || s >= 12) {
      ctx.font = `500 ${Math.max(10, s * 0.8)}px Roboto, sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const tw = ctx.measureText(a.name).width + 8;
      ctx.fillStyle = sel ? '#ffd54f' : 'rgba(80, 20, 90, .8)';
      ctx.fillRect(b.x * u, Math.max(0, b.y * u - s), tw, s);
      ctx.fillStyle = sel ? '#000' : '#fff';
      ctx.fillText(a.name, b.x * u + 4, Math.max(0, b.y * u - s) + s * 0.1);
    }
  }
}

// shared multicolor sprite colors [sprite1, sprite2]
export function spriteColors(game) {
  const S = symbols(game), consts = constMap(game);
  return ['sprite1', 'sprite2'].map(key =>
    colorIndex(S.colors.find(c => c.key === key)?.value ?? String(SPRITE_DEFAULTS[key]), consts, SPRITE_DEFAULTS[key]));
}

// a costume frame as the game shows it: the frame, then the layers it has, each a sprite of
// its own in its color and mode (a later one in front). hidden: layer names to leave out ('' is
// the costume's own frame)
export function drawCostumeFrame(ctx, game, c, frame, x, y, u, color, mirror = false, hidden = new Set()) {
  const shared = spriteColors(game), consts = constMap(game), [sw, sh] = costumeSize(c);
  const parts = partColors(c, color, consts);
  // the frame and its merged layers: each part in its own color when the costume has colors
  const body = art => (parts ? drawParts(ctx, art, !!c.multicolor, x, y, u, parts, shared, mirror, sw, sh)
    : drawSprite(ctx, art, !!c.multicolor, x, y, u, [color, ...shared], mirror, sw, sh));
  if (!hidden.has('')) body(costumeFrame(c, frame));
  for (const l of c.layers) {
    const art = l.frames.find(f => f.name === frame)?.lines;
    if (!art || hidden.has(l.name)) continue;
    drawSprite(ctx, art, layerMulticolor(c, l), x, y, u, [colorIndex(l.color ?? '0', consts), ...shared], mirror, sw, sh);
  }
}

// the sprite color of each part of a costume, row by row: its 'colors', else the actor's
// color (null: the costume has no colors, one color for the whole frame)
export function partColors(c, color, consts) {
  if (!c?.colors?.length) return null;
  const [sw, sh] = costumeSize(c);
  return Array.from({ length: sw * sh }, (_, k) => (c.colors[k] != null ? colorIndex(c.colors[k], consts, color) : color));
}

// W x H art part by part, each in its color. Mirrored the whole frame is mirrored, like the
// compiler does it, so the art of a part and its color move to the other side together
function drawParts(ctx, lines, multicolor, x, y, u, parts, shared, mirror, sw, sh) {
  const w = spriteWidth(multicolor);
  for (let row = 0; row < sh; row++) {
    for (let col = 0; col < sw; col++) {
      const art = (lines || []).slice(row * SPRITE_ROWS, (row + 1) * SPRITE_ROWS).map(l => l.padEnd(w * sw, '.').slice(col * w, (col + 1) * w));
      const at = mirror ? sw - 1 - col : col;
      drawSprite(ctx, art, multicolor, x + at * SPRITE_COLS, y + row * SPRITE_ROWS, u, [parts[row * sw + col], ...shared], mirror);
    }
  }
}

// sprite art with its top left at x/y (hires pixels), u canvas pixels per hires pixel.
// colors: [sprite color, shared color 1, shared color 2]
export function drawSprite(ctx, lines, multicolor, x, y, u, colors, mirror = false, sw = 1, sh = 1) {
  const w = spriteWidth(multicolor) * sw, k = multicolor ? 2 : 1;
  (lines || []).slice(0, SPRITE_ROWS * sh).forEach((line, yy) => {
    const l = line.padEnd(w, '.').slice(0, w);
    for (let xx = 0; xx < w; xx++) {
      const ch = l[mirror ? w - 1 - xx : xx];
      const v = multicolor ? MC_PIXELS[ch] : ch !== '.' && ch !== ' ' ? 2 : 0;
      if (!v) continue;
      ctx.fillStyle = PALETTE[colors[v === 2 ? 0 : v === 1 ? 1 : 2] & 15];
      ctx.fillRect((x + xx * k) * u, (y + yy) * u, k * u, u);
    }
  });
}

// a patch's rectangle in place cells
export function patchRect(p, consts) {
  const lines = [...p.lines];
  while (lines.length && !lines.at(-1)) lines.pop();
  return { col: numValue(p.col, consts) ?? 0, row: numValue(p.row, consts) ?? 0, w: Math.max(0, ...lines.map(l => l.length)), h: lines.length };
}

// move patch p by dc columns and dr rows
export function movePatch(p, dc, dr, consts) {
  p.col = String((numValue(p.col, consts) ?? 0) + dc);
  p.row = String((numValue(p.row, consts) ?? 0) + dr);
}

// the shift by dc, dr of an object on layers (objectRect r), cut so that its hotspot and its
// layers stay inside a place of width x rows
export function layeredShift(r, dc, dr, width, rows) {
  const lo = (a, b) => Math.min(a.col, b.col), hi = (a, b) => Math.max(a.col + a.w, b.col + b.w);
  const top = (a, b) => Math.min(a.row, b.row), bot = (a, b) => Math.max(a.row + a.h, b.row + b.h);
  const b = r.bounds ?? r;
  return {
    dc: Math.max(-lo(r, b), Math.min(width - hi(r, b), dc)),
    dr: Math.max(-top(r, b), Math.min(rows - bot(r, b), dr)),
  };
}

// move an object on layers (objectRect r) by dc, dr: its layers, and its own hotspot with them
export function moveLayered(obj, r, dc, dr, consts) {
  r.layers.forEach(p => movePatch(p, dc, dr, consts));
  if (r.own) setObjAttr(obj, 'at', [String(r.col + dc), String(r.row + dr)]);
}

// an object's hotspot in place cells. With the game, an object on layers ('layer PATCH, ...')
// covers the rectangles of those patches: layers are the patches, layer the first one, bounds
// the rectangle they cover. With at and size it has a hotspot of its own (own) that moves with them.
export function objectRect(obj, consts, game = null) {
  const v = (key, k, d) => numValue(obj.attrs.find(a => a.key === key)?.values[k] ?? d, consts) ?? 0;
  const walkto = obj.attrs.some(a => a.key === 'walkto') ? { x: v('walkto', 0, '0'), y: v('walkto', 1, '0') } : null;
  const names = (game && obj.attrs.find(a => a.key === 'layer')?.values) || [];
  const layers = names.map(n => symbols(game).patches.find(p => p.name === n)).filter(Boolean);
  if (layers.length) {
    const rs = layers.map(p => patchRect(p, consts));
    const col = Math.min(...rs.map(q => q.col)), row = Math.min(...rs.map(q => q.row));
    const bounds = { col, row, w: Math.max(...rs.map(q => q.col + q.w)) - col, h: Math.max(...rs.map(q => q.row + q.h)) - row };
    const own = obj.attrs.some(a => a.key === 'at') && obj.attrs.some(a => a.key === 'size');
    const hot = own ? { col: v('at', 0, '0'), row: v('at', 1, '0'), w: v('size', 0, '1'), h: v('size', 1, '1') } : bounds;
    return { ...hot, walkto, layer: layers[0], layers, bounds, own };
  }
  return { col: v('at', 0, '0'), row: v('at', 1, '0'), w: v('size', 0, '1'), h: v('size', 1, '1'), walkto };
}

// the character ROM of a case set ('upper' or 'lower') as it is (chargen.js): what the char editor
// resets to and traces
// - the ROM of the machine of the project (romfonts.js): another Commodore's in the same two sets, a machine of
// other codes its 256 chars whatever the set
export const romFont = set => machineRom(set) ?? CHARGEN.subarray(set === 'upper' ? 0 : CHARSET_SIZE, set === 'upper' ? CHARSET_SIZE : 2 * CHARSET_SIZE);
function machineRom(set) {
  const f = machineFont();
  if (f.data.buffer === CHARGEN.buffer) return null;                  // the C64's
  return f.kind === 'codes' ? f.data : f.data.subarray(set === 'upper' ? 0 : CHARSET_SIZE, set === 'upper' ? CHARSET_SIZE : 2 * CHARSET_SIZE);
}

// the game's panel glyphs at $1d-$1f in every ROM set the engine copies: the vertical line and the
// arrow buttons of the panel instead of ] and the up and left arrows (panelGlyphs in
// advc/adv/compile.go, engine/panel.s)
export const PANEL_GLYPHS = [
  0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18,   // $1d: the vertical line
  0x18, 0x18, 0x18, 0x3c, 0x3c, 0x3c, 0x7e, 0x00,   // $1e: up
  0x00, 0x7e, 0x3c, 0x3c, 0x3c, 0x18, 0x18, 0x18,   // $1f: down
];
const GAME_ROM = (() => {
  const rom = CHARGEN.slice();
  for (const set of [0, CHARSET_SIZE]) rom.set(PANEL_GLYPHS, set + 0x1d * 8);
  return rom;
})();
// the ROM set as the game shows it: the ROM with the panel glyphs over it - for the places with
// the ROM font, the panel, the text font, a new charset made from the ROM
export const romCharset = set => machineRom(set) ?? GAME_ROM.subarray(set === 'upper' ? 0 : CHARSET_SIZE, set === 'upper' ? CHARSET_SIZE : 2 * CHARSET_SIZE);

// one character cell: screen code, position, size, colors. chr: the bytes of the place's
// charset file, else the ROM characters of the case set charset; mc: [$d022, $d023] of a
// multicolor place; ecm: [$d022, $d023, $d024] of an extended color place
export function drawCell(ctx, code, x, y, s, fg, bg, charset, chr = null, mc = null, ecm = null) {
  if (ecm) drawGlyph(ctx, chr ?? romCharset(charset), code & 63, x, y, s, fg & colorMask(), ecmBack(code, bg, ecm));
  else drawGlyph(ctx, chr ?? romCharset(charset), code, x, y, s, fg, bg, mc);
}

// extended color mode: bits 6-7 of the screen code pick the background of the cell - $d021
// (bg), or $d022-$d024 (ecm); its pixels are char 0-63
export const ecmBack = (code, bg, ecm) => (code & 0xc0 ? ecm[(code >> 6) - 1] : bg);

// width x height cells of charset bytes, s canvas pixels a cell, at x/y: the pixels written into an
// ImageData, then one drawImage - a whole screen far quicker than a canvas call per pixel. A cell
// size of 8n is drawn at 8 pixels a cell and scaled n times; any other size at its own size, where
// a C64 pixel has the edges round(k * s / 8) in its cell: a scaling drawImage rounds the edges of
// 2.5 pixels one way or the other, and a cell drawn alone would not match the same cell in a screen. bg: the background color; mc: [$d022, $d023] of a
// multicolor place, where a color with bit 3 makes a cell multicolor: its bit pairs in the colours of
// the machine (video.js mcPens: the C64 00 background, 01 mc[0], 10 mc[1], 11 color & 7); ecm:
// [$d022-$d024] of an extended color place (ecmBack)
let blitCanvas = null, blitImg = null;
function blit(ctx, data, chars, colors, width, height, bg, mc, x, y, size, ecm = null) {
  size = Math.round(size);
  if (width <= 0 || height <= 0 || size <= 0) return;
  const s = size % 8 ? size : 8;                // the pixels a cell in the ImageData
  const W = width * s, H = height * s;
  if (blitImg?.width !== W || blitImg.height !== H) blitImg = new ImageData(W, H);
  const px = new Uint32Array(blitImg.data.buffer);
  const edge = Array.from({ length: 9 }, (_, k) => Math.round(k * s / 8));
  const m = colorMask(), back = PIXELS[bg & m];
  const pens = Array.from({ length: width * height }, (_, k) => {
    const fg = colors[k];
    if (ecm) return [PIXELS[ecmBack(chars[k], bg, ecm) & m], PIXELS[fg & m]];
    return mc && isMcCell(fg) ? mcPens(bg, mc, fg).map(c => PIXELS[c & m]) : [back, PIXELS[fg & m]];
  });
  for (let r = 0; r < height; r++) {
    for (let row = 0; row < 8; row++) {
      const y0 = r * s + edge[row], y1 = r * s + edge[row + 1];
      if (y1 <= y0) continue;
      const line = y0 * W;
      for (let c = 0; c < width; c++) {
        const k = r * width + c, pen = pens[k], byte = data[(chars[k] & (ecm ? 63 : 0xff)) * 8 + row], at = line + c * s;
        const multi = pen.length === 4;
        for (let b = 0; b < 8; b++) {
          const v = multi ? pen[(byte >> (6 - (b & 6))) & 3] : pen[(byte >> (7 - b)) & 1];
          for (let q = at + edge[b], end = at + edge[b + 1]; q < end; q++) px[q] = v;
        }
      }
      for (let yy = y0 + 1; yy < y1; yy++) px.copyWithin(yy * W, line, line + W);   // the pixel's other lines
    }
  }
  blitCanvas ??= document.createElement('canvas');
  if (blitCanvas.width < W || blitCanvas.height < H) { blitCanvas.width = Math.max(blitCanvas.width, W); blitCanvas.height = Math.max(blitCanvas.height, H); }
  blitCanvas.getContext('2d').putImageData(blitImg, 0, 0);
  const smooth = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(blitCanvas, 0, 0, W, H, x, y, width * size, height * size);
  ctx.imageSmoothingEnabled = smooth;
}

// a character from charset bytes, s canvas pixels a side at x/y: rectangles, a run of pixels of one
// color in a row each - for one character far quicker than blit's ImageData (the char editor draws
// its 256 characters on every stroke), with the same edges round(k * s / 8), so it has the pixels
// of the same character in a screen. mc: as in blit
export function drawGlyph(ctx, data, code, x, y, s, fg, bg, mc = null) {
  s = Math.round(s);
  const edge = Array.from({ length: 9 }, (_, k) => Math.round(k * s / 8));
  const multi = mc && isMcCell(fg), step = multi ? 2 : 1, m = colorMask();
  const pens = multi ? mcPens(bg, mc, fg) : [bg, fg];
  ctx.fillStyle = PALETTE[bg & m];
  ctx.fillRect(x, y, s, s);
  for (let r = 0; r < 8; r++) {
    const byte = data[(code & 0xff) * 8 + r];
    if (!byte) continue;
    const value = c => (multi ? (byte >> (6 - c)) & 3 : (byte >> (7 - c)) & 1);
    for (let c = 0; c < 8;) {
      const v = value(c);
      let e = c + step;
      while (e < 8 && value(e) === v) e += step;
      if (v) {
        ctx.fillStyle = PALETTE[pens[v] & m];
        ctx.fillRect(x + edge[c], y + edge[r], edge[e] - edge[c], edge[r + 1] - edge[r]);
      }
      c = e;
    }
  }
}

// draw a width x height map at cell position col0/row0
export function drawMap(ctx, info, chars, colors, width, height, col0, row0, s) {
  blit(ctx, info.chr ?? romCharset(info.charset), chars, colors, width, height, info.bg, info.multicolor, col0 * s, row0 * s, s, info.ecm);
}

export function patchCells(game, patch, place, info) {
  const S = symbols(game);
  const inPlace = place && place.members.includes(patch);
  const lines = [...patch.lines];
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  const width = Math.max(0, ...lines.map(l => l.length));
  const m = resolveMap(lines, patch.colors, width, lines.length, inPlace ? info.textcolor : 15, info.charset);
  return { width, height: lines.length, ...m, colors: cellColors(info, m.chars, m.colors) };
}

// draw a place. opts: cell (px per char), patches (names to overlay), overlays (bool),
// selected (object id), hover (object id)
export function drawPlace(canvas, game, place, opts = {}) {
  const s = opts.cell ?? 8;
  const info = placeInfo(game, place);
  canvas.width = info.width * s;
  canvas.height = info.rows * s;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  if (info.screenFile) {
    ctx.fillStyle = PALETTE[info.bg];
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = PALETTE[info.textcolor];
    ctx.font = `500 ${s * 1.4}px Roboto, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(`screen "${info.screenFile}"`, canvas.width / 2, canvas.height / 2);
  } else {
    drawMap(ctx, info, info.chars, info.colors, info.width, info.rows, 0, 0, s);
  }

  const S = symbols(game);
  for (const name of opts.patches ?? []) {
    const p = S.patches.find(x => x.name === name);
    if (!p) continue;
    const pc = patchCells(game, p, place, info);
    const col = numValue(p.col, info.consts) ?? 0, row = numValue(p.row, info.consts) ?? 0;
    drawMap(ctx, info, pc.chars, pc.colors, pc.width, pc.height, col, row, s);
  }

  if (opts.overlays) drawOverlays(ctx, game, place, info, s, opts);
  return info;
}

// walkbox or walk area (not in a place shown without actors, and not with opts.walkbox false), object
// hotspots and the selected object's walk-to point. opts.zones: the zones of the walk area too
export function drawOverlays(ctx, game, place, info, s, opts = {}) {
  const px = s / 8;
  const [x1, y1, x2, y2] = info.walkbox;
  // walk units, feet y -> canvas: a walk unit is 2 pixels, the feet at y stand in the row above
  const at = ([x, y]) => [x * 2 * px, (y - 8) * px];
  if (opts.walkbox !== false && !place._noActors) {
    ctx.lineWidth = Math.max(1, px);
    ctx.setLineDash([4 * px, 3 * px]);
    ctx.strokeStyle = info.walkPts && !info.walkarea ? 'rgba(255, 82, 82, .9)' : 'rgba(0, 255, 200, .9)';
    if (info.walkPts) {                       // the polygon; red while it is wrong
      ctx.beginPath();
      info.walkPts.forEach((p, k) => ctx[k ? 'lineTo' : 'moveTo'](...at(p)));
      ctx.closePath();
      ctx.stroke();
      if (opts.zones && info.walkarea) {      // the zones the compiler cuts it into
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(0, 255, 200, .10)';
        ctx.strokeStyle = 'rgba(0, 255, 200, .35)';
        ctx.lineWidth = 1;
        info.walkarea.zones.forEach((z, k) => {
          ctx.beginPath();
          zoneOutline(info.walkarea, k).forEach((p, j) => ctx[j ? 'lineTo' : 'moveTo'](...at(p)));
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        });
      }
    } else {
      ctx.strokeRect(x1 * 2 * px, (y1 - 8) * px, (x2 - x1) * 2 * px, (y2 - y1) * px);
    }
    // the block areas: not walked on - always (solid), or unless their condition holds (dashed);
    // the one under the pointer (blockSel) filled
    info.blocks?.forEach((b, k) => {
      ctx.beginPath();
      b.pts.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](...at(p)));
      ctx.closePath();
      ctx.fillStyle = opts.blockSel === k ? 'rgba(255, 152, 0, .35)' : b.cond ? 'rgba(255, 152, 0, .08)' : 'rgba(255, 152, 0, .18)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 152, 0, .95)';
      ctx.lineWidth = Math.max(1, px);
      ctx.setLineDash(b.cond ? [5, 3] : []);
      ctx.stroke();
    });
    // the behind areas: their chars hide the actors behind them, and their bottom edge is a
    // wall - the feet of an actor may stand on it but not step over it (engine/depth.s)
    // A polygon is the cells whose middle is inside it (the strips of info.behind): the cells
    // filled, the polygon as a line, the one under the pointer (behindSel) brighter
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255, 110, 220, .22)';
    info.behind?.forEach(([col, row, w, h]) => ctx.fillRect(col * s, row * s, w * s, h * s));
    info.behindPolys?.forEach((pts, k) => {       // (in walk units and feet pixels, like the walk area)
      ctx.beginPath();
      pts.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](...at(p)));
      ctx.closePath();
      if (opts.behindSel === k) { ctx.fillStyle = 'rgba(255, 110, 220, .2)'; ctx.fill(); }
      ctx.strokeStyle = 'rgba(255, 110, 220, .95)';
      ctx.lineWidth = Math.max(1, px);
      ctx.setLineDash([5, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    });
    ctx.strokeStyle = '#ff6edc';                   // the wall of every strip: at the base of its area (of its polygon)
    ctx.lineWidth = Math.max(2, 3 * px / 2);
    ctx.beginPath();
    info.behind?.forEach(([col, row, w, h, base = row + h]) => { ctx.moveTo(col * s, base * s - 1); ctx.lineTo((col + w) * s, base * s - 1); });
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.font = `500 ${Math.max(10, s * 0.8)}px Roboto, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  for (const o of objectsInPlace(game, place)) {
    const r = objectRect(o, info.consts, game);
    const sel = o.id === opts.selected, hov = o.id === opts.hover;
    ctx.lineWidth = sel ? 3 * px / 2 + 1 : Math.max(1, px);
    ctx.strokeStyle = sel ? '#ffd54f' : hov ? '#ffffff' : 'rgba(255,255,255,.55)';
    ctx.fillStyle = sel ? 'rgba(255, 213, 79, .18)' : hov ? 'rgba(255,255,255,.12)' : 'transparent';
    ctx.fillRect(r.col * s, r.row * s, r.w * s, r.h * s);
    ctx.strokeRect(r.col * s + .5, r.row * s + .5, r.w * s - 1, r.h * s - 1);
    if (sel || hov || s >= 12) {
      const label = o.name;
      const tw = ctx.measureText(label).width + 8;
      ctx.fillStyle = sel ? '#ffd54f' : 'rgba(0,0,0,.7)';
      ctx.fillRect(r.col * s, Math.max(0, r.row * s - s), tw, s);
      ctx.fillStyle = sel ? '#000' : '#fff';
      ctx.fillText(label, r.col * s + 4, Math.max(0, r.row * s - s) + s * 0.1);
    }
    if (sel) {
      const wt = r.walkto ?? defaultWalkto(info, r);
      const cx = wt.x * 2 * px, cy = (wt.y - 8) * px;
      ctx.strokeStyle = '#ffd54f';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 3 * px, 0, Math.PI * 2);
      ctx.moveTo(cx - 6 * px, cy); ctx.lineTo(cx + 6 * px, cy);
      ctx.moveTo(cx, cy - 6 * px); ctx.lineTo(cx, cy + 6 * px);
      ctx.stroke();
      if (opts.handles) {
        const hs = Math.max(6, s / 3);
        const xs = [r.col, r.col + r.w / 2, r.col + r.w].map(v => v * s);
        const ys = [r.row, r.row + r.h / 2, r.row + r.h].map(v => v * s);
        ctx.fillStyle = '#ffd54f';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        xs.forEach((x, i) => ys.forEach((y, j) => {
          if (i === 1 && j === 1) return;
          ctx.fillRect(x - hs / 2, y - hs / 2, hs, hs);
          ctx.strokeRect(x - hs / 2 + .5, y - hs / 2 + .5, hs - 1, hs - 1);
        }));
      }
    }
  }
  drawActors(ctx, game, place, info, s, opts);
  if (opts.preview) {
    const p = opts.preview;
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = '#ffd54f';
    ctx.lineWidth = 2;
    ctx.strokeRect(p.col * s + 1, p.row * s + 1, p.w * s - 2, p.h * s - 2);
    ctx.setLineDash([]);
  }
}
