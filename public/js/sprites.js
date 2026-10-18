// sprites.js - pixel editor for the cursor and the actor costumes
//
// Sprites are 24x21 pixels. Hires art has one character per pixel ('.' clear, 'X' set).
// Multicolor art has 12 double wide pixels: '.' clear, 'X' the sprite color, '1' and '2'
// the shared colors ($d025 / $d026). Actors face right; the engine mirrors the frames facing
// left, unless the costume has an animation for that direction ('walk_left', 'walk_front',
// 'walk_back'). An actor that stands still for the costume's idle time plays 'idle'.
//
// A costume has named frames, layers and animations. A layer holds frames of the same
// names: a merged layer is painted into the costume's frames by the compiler (in the
// costume's mode), the overlay layer is a sprite of its own in front of them, with its
// own mode and color. The canvas shows the other visible layers dimmed; hiding a layer
// only changes the editor.

import { t, tr } from './i18n.js';
import {
  symbols, newId, COLOR_NAMES, UI_DEFAULTS, SPRITE_COLS, SPRITE_ROWS, DEFAULT_SPRITES, builtinCursor,
  cursorHotspot, decodeSprite, encodeSprite, convertSprite, costumeFrame, DEFAULT_ANIM_SPEED, MAX_ANIM_FRAMES,
  costumeSize, MAX_ACTOR_SPRITES, DIRECTIONS, defaultFrame, DEFAULT_IDLE, MAX_IDLE, layerMulticolor, mostLayers, animView,
  mirrorPartner, animPlays, animSequence, ANIM_PLAYS, MAX_VARY,
} from './adv.js';
import { uniqueName, renameSymbol, numValue } from './advgen.js';
import { PALETTE, constMap, colorIndex, drawSprite, drawCostumeFrame, spriteColors, partColors } from './c64.js';
import {
  h, dh, dom, mount, signal, icon, iconButton, button, field, select, checkbox, dialog, promptDialog, snackbar,
  section as uiSection, sidePanel, slider, openMenu, confirmRemove, segmented,
} from './pui.js';
import { sizePicker } from './sizes.js';
import { costumeToFile, costumeFromFile, blocksToArt, spriteToFile, spriteBlocks, sprPath, spritePath } from './gfxfile.js';
import { parseSpd } from './padfiles.js';
import { pngOf, pixelCanvas, exportName, importName } from './export.js';
import { speedSlider } from './animui.js';
import { referenceLayer } from './trace.js';
import { colorChooser } from './colorchooser.js';
import { regionOp, rectBetween, clipRect, swapValues } from './gridops.js';
import { tools, RANGE_SMOOTH as RANGE, rotation, rangeForKey, DRAG_TOOLS, BRUSH_TOOLS, defaultBrush, brushCells, brushMax, brushTools, radiusMax, radiusTools, defaultTools, toolForKey, lineCells, dragCells as dragXY } from './drawtools.js';
import { paintArea, dragMods, dragTo, curveWaits, followCurve, DRAW_POLY, WAIT_TOOLS, waits, strokeDown, closePolygon, wheelZoom, outlineCells } from './drawtools.js';
import { keepUi, pick as pickUi, put as putUi } from './uistate.js';

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// words of the costume syntax that cannot name a frame, layer or animation
const KEYWORDS = new Set(['speed', 'frame', 'layer', 'anim', 'overlay', 'multicolor', 'hires', 'color', 'once', 'off', 'default']);
// the tools of the sprites (drawtools.js): select and draw, the hot spot only for the cursor
const TOOLS = ['select', ...DRAW_POLY];
const TIPS = { erase: 'clears', pick: 'pen' };
const toolsOf = target => tools(target === 'cursor' ? [...TOOLS, 'hotspot'] : TOOLS, TIPS);
// pixel values are the multicolor bit pairs, see decodeSprite
const PEN_LABELS = ['clear', '§0644', '§0872', '§0645'];
const PEN_CHARS = '.1X2';
const TOP_SETTINGS = ['verb', 'color', 'control', 'media', 'platform', 'charset'];
const ZOOM = [12, 16, 20, 24, 28, 32, 40];
const STRIP_SCALE = 8;                    // screen pixels per sprite pixel in the frame strip
const blankArt = (w = 1, h = 1) => Array(SPRITE_ROWS * h).fill('.'.repeat(SPRITE_COLS * w));

export function createSpriteEditor(el, store, actions, bar) {
  const st = {
    target: 'default',          // 'cursor', 'default' or the id of a costume
    frame: 'stand', frameId: null, layer: '',  // layer: '' the costume's own frames, else a layer name
    // the layers of the frame selected for the frame tools ('' the frame itself): selecting a frame
    // selects all its layers, a layer can be taken out and back in; kept as the ones taken out
    unpicked: new Set(), pickedFor: null,
    tool: 'pencil', pen: 2, cell: 24, grid: true, brush: defaultBrush(), radius: 0,
    bg: 0, previewColor: null, hover: null, drag: null,
    anim: null, tick: 0, step: 0, playing: true, hidden: new Set(),
    range: null,                  // frames marked in the grid panel: {target, anchor, frames}
    sel: null,                    // the range selected on the canvas: {x, y, w, h} in pixels
    swapAll: false,               // swap colors in all frames of the sprite
    clip: null,                   // Ctrl+C: the pixels of a frame or of its range {x, y, grid, mc, from}
    // anim: the animation opened in the side panel; its frames are highlighted in the grid
  };
  let ui = null;                          // what the editor draws on: the canvas and the preview, made once, and the strip of frames
  let views = null;                       // the mounted bar and body (pui.mount)
  const update = () => { views?.forEach(v => v.update()); if (ui) drawPreview(); };
  // the turn of the range tool 'rotate' (drawtools.js): while it is on, the canvas shows the frame
  // drawn on turned - the range, or the whole frame - and Apply turns the frames apply() changes
  const rot = rotation({ preview: () => draw(), apply: t => apply('rotate', { turned: true, ...t }), refresh: () => render() });
  const shownPixels = () => (rot.on ? regionOp(pixels(), 'rotate', st.sel, { blank: 0, aspect: multicolor() ? 2 : 1, ...rot.turn }).grid : pixels());
  const statusLine = signal('');
  let stroke = 0;
  let timer = 0;
  // the image to trace (trace.js): one per sprite, placed on the canvas of all its frames
  const refKey = (name = costume()?.name) => `sprite:${name ?? st.target}`;
  const reference = referenceLayer({
    key: () => refKey(),
    area: () => { const [sw, sh] = size(); return { w: SPRITE_COLS * sw, h: SPRITE_ROWS * sh }; },
    redraw: () => draw(), rerender: () => update(),
  });

  // --- model -------------------------------------------------------------------------

  const S = () => symbols(store.game);
  const costume = () => (st.target === 'cursor' || st.target === 'default' ? null : store.node(st.target));
  const layer = () => costume()?.layers.find(l => l.name === st.layer) ?? null;
  // the layers of the frame shown: a layer belongs to the frames it has a frame of its own in -
  // added there, empty until drawn on; the other frames do not have it
  const frameLayers = (frame = st.frame) => (costume()?.layers ?? []).filter(l => l.frames.some(f => f.name === frame));
  // the selected layers of the frame shown ('' the frame itself)
  const picked = () => ['', ...frameLayers().map(l => l.name)].filter(n => !st.unpicked.has(n));
  const spriteNode = name => S().sprites.find(sp => sp.name === name);
  // the built-in art of a sprite: the cursor the game picked (cursor arrow ...), stand and walk
  const builtin = name => (name === 'cursor' ? builtinCursor(S()).lines : DEFAULT_SPRITES[name]);
  const frames = () => (st.target === 'cursor' ? ['cursor'] : costume() ? costume().frames.map(f => f.name) : ['stand', 'walk']);
  const art = (frame = st.frame) => {
    const c = costume(), l = layer();
    if (!c) return spriteNode(frame)?.lines ?? builtin(frame);
    return (l ? l.frames.find(f => f.name === frame)?.lines : costumeFrame(c, frame)) ?? [];
  };
  // the mode of what is edited: a layer has its own (unset: the costume's)
  const multicolor = () => {
    const c = costume(), l = layer();
    if (l) return layerMulticolor(c, l);
    return !!(c ? c.multicolor : spriteNode(st.target === 'cursor' ? 'cursor' : 'stand')?.multicolor);
  };
  const size = () => costumeSize(costume());       // [W, H] in sprites
  const pixels = (frame = st.frame) => decodeSprite(art(frame), multicolor(), ...size());
  const penOrder = () => (multicolor() ? [2, 1, 3, 0] : [2, 0]);

  function normalize() {
    if (costume()?.kind !== 'costume') st.target = S().costumes[0]?.id ?? 'default';
    if (!costume() || (st.layer && !layer())) st.layer = '';
    if (!frames().includes(st.frame)) {     // renamed, moved or undone: follow the frame's id
      const f = st.frameId && costume()?.frames.find(x => x.id === st.frameId);
      st.frame = f ? f.name : frames()[0];
    }
    st.frameId = costume()?.frames.find(f => f.name === st.frame)?.id ?? null;
    if (st.layer && !frameLayers().some(l => l.name === st.layer)) st.layer = '';   // another frame: its own layers
    const pickKey = `${st.target}|${st.frame}`;
    if (st.pickedFor !== pickKey) { st.pickedFor = pickKey; st.unpicked.clear(); }   // another frame: all its layers
    st.unpicked = new Set([...st.unpicked].filter(n => n === '' || frameLayers().some(l => l.name === n)));
    if (!penOrder().includes(st.pen)) st.pen = 2;
    if (st.tool === 'hotspot' && st.target !== 'cursor') st.tool = 'pencil';
    if (st.anim && !costume()?.anims.some(a => a.name === st.anim)) st.anim = null;
    if (st.range) {                         // frames renamed or deleted meanwhile
      const rc = store.node(st.range.target);
      st.range.frames = rc?.kind === 'costume' ? st.range.frames.filter(f => rc.frames.some(x => x.name === f)) : [];
      if (!st.range.frames.length) st.range = null;
    }
    const [sw, sh] = size();
    st.sel = clipRect(st.sel, (multicolor() ? SPRITE_COLS / 2 : SPRITE_COLS) * sw, SPRITE_ROWS * sh);
  }

  const gameColor = (key, fallback) =>
    colorIndex(S().colors.find(c => c.key === key)?.value ?? String(fallback), constMap(store.game), fallback);

  // actors that wear the selected costume
  function wearers() {
    if (st.target === 'cursor') return [];
    const c = costume();
    return S().actors.filter(a => {
      const name = a.attrs.find(x => x.key === 'costume')?.values[0];
      return c ? name === c.name : !name || name === 'default';
    });
  }

  // the sprite color of the costume's own frames (an actor's color, only a preview)
  function bodyColor() {
    if (st.previewColor != null && !wearers().length) return st.previewColor;
    const fallback = gameColor('actor', UI_DEFAULTS.actor);
    const v = wearers()[0]?.attrs.find(x => x.key === 'color')?.values[0];
    return v == null ? fallback : colorIndex(v, constMap(store.game), fallback);
  }

  function spriteColor() {
    if (st.target === 'cursor') return gameColor('cursor', UI_DEFAULTS.cursor);
    if (layer()) return colorIndex(layer().color ?? '0', constMap(store.game));
    return bodyColor();
  }

  // color of each pixel value: [background, shared 1, sprite, shared 2]
  const colors = () => {
    const [mc1, mc2] = spriteColors(store.game);
    return [st.bg, mc1, spriteColor(), mc2];
  };

  function hotspot() {
    const sp = spriteNode('cursor');
    if (sp?.hotspot) return sp.hotspot.map(v => numValue(v, constMap(store.game)) ?? 0);
    if (!sp && builtinCursor(S()).hotspot) return builtinCursor(S()).hotspot;
    return cursorHotspot(art('cursor'), multicolor());
  }

  // --- changes -----------------------------------------------------------------------

  // insert a top level item after the last one of the first kind list that exists
  function insertTop(g, node, kindLists) {
    let at = -1;
    for (const kinds of kindLists) {
      g.items.forEach((x, k) => { if (kinds.includes(x.kind)) at = k; });
      if (at >= 0) break;
    }
    g.items.splice(at + 1, 0, node);
  }

  function spriteItem(g, name) {
    let sp = g.items.find(x => x.kind === 'sprite' && x.name === name);
    if (!sp) {
      sp = { id: newId(), kind: 'sprite', name, blank: true, lines: [...(spriteNode(name)?.lines ?? builtin(name))] };
      // the arrow and the hand point with their tip: the sprite made of them keeps it
      const hs = name === 'cursor' && !spriteNode(name) ? builtinCursor(S()).hotspot : null;
      if (hs) sp.hotspot = hs.map(String);
      insertTop(g, sp, [['sprite'], TOP_SETTINGS]);
    }
    return sp;
  }

  // grids: {frame: pixels} of what is edited. Built-in sprites become script sprites on
  // the first change. A layer frame stays when it is erased: the layer keeps its frame
  function commit(grids, mc, key = null) {
    store.mutate(g => {
      const c = costume(), l = layer();
      for (const [frame, grid] of Object.entries(grids)) {
        const lines = encodeSprite(grid, mc);
        if (!c) {
          const node = spriteItem(g, frame);
          node.lines = lines;
          if (mc) node.multicolor = true; else delete node.multicolor;
        } else if (l) {
          const i = l.frames.findIndex(f => f.name === frame);
          if (i >= 0) l.frames[i].lines = lines;
          else {
            const order = c.frames.map(f => f.name);
            const at = l.frames.filter(f => order.indexOf(f.name) < order.indexOf(frame)).length;
            l.frames.splice(at, 0, { id: newId(), name: frame, lines });
          }
        } else {
          const f = c.frames.find(x => x.name === frame);
          if (f) f.lines = lines;
        }
      }
    }, { key, source: 'sprites' });
  }

  function paintCells(cells, value, key = null) {
    const grid = pixels();
    let changed = false;
    for (const { x, y } of cells) {
      if (grid[y]?.[x] !== undefined && grid[y][x] !== value) { grid[y][x] = value; changed = true; }
    }
    if (changed) commit({ [st.frame]: grid }, multicolor(), key);
  }

  // Ctrl+C: the frame of the layer drawn on, or the range selected on the canvas
  function copy() {
    const r = st.sel, grid = pixels();
    const part = r ? grid.slice(r.y, r.y + r.h).map(row => row.slice(r.x, r.x + r.w)) : grid;
    st.clip = { x: r?.x ?? 0, y: r?.y ?? 0, grid: part, mc: multicolor(), from: st.frame };
    snackbar(r ? tr('§0946', r.w, r.h, st.frame) : tr('§0947', st.frame));
  }

  // Ctrl+V: into the frame shown, or into every marked frame - a range at the range selected
  // now, else where it was copied from; what does not fit is cut off. One undo step
  function paste() {
    const cl = st.clip;
    if (!cl) return snackbar('§0948');
    if (cl.mc !== multicolor()) return snackbar(tr(st.layer ? '§1993' : '§1992', cl.mc ? '§1011' : '§1010', cl.mc ? '§1010' : '§1011'), { error: true });
    const c = costume(), marked = c && markedFrames(c);
    const x0 = st.sel?.x ?? cl.x, y0 = st.sel?.y ?? cl.y, grids = {};
    for (const f of marked ? [...new Set(marked)] : [st.frame]) {
      const grid = pixels(f);
      cl.grid.forEach((row, y) => row.forEach((v, x) => { if (grid[y0 + y]?.[x0 + x] !== undefined) grid[y0 + y][x0 + x] = v; }));
      grids[f] = grid;
    }
    commit(grids, multicolor(), `paste-${++stroke}`);
    const n = Object.keys(grids).length;
    snackbar(`Pasted ${cl.grid.length === pixels().length && !st.sel ? tr('§1109', cl.from) : 'the range'} into ${n > 1 ? `${n} frames` : tr('§1109', st.frame)}`);
  }

  // the bar tools: the range selected on the canvas, else the whole frame - in every
  // frame marked in the grid below, else in the current one; all: in every frame of the
  // sprite. One undo step. opts: more options of regionOp (map)
  // the frame tools: the frame, the range, the marked frames or all frames - in the selected layers
  // (none selected: the layer drawn on), each in its own mode and only in the frames that have it;
  // one undo step
  function apply(op, { all = false, confirmed = false, ...opts } = {}) {
    if (op === 'rotate' && !opts.turned) return rot.start();   // turned in space: the section of the turn
    if (op !== 'rotate') rot.stop(false);
    const c = costume(), marked = c && markedFrames(c);
    const targets = all ? frames() : marked ? [...new Set(marked)] : [st.frame];
    if (op === 'clear' && !confirmed) {             // asks first: the range, the marked frames or the frame
      const what = st.sel ? tr('§1462', st.sel.w, st.sel.h) : targets.length > 1 ? tr('§1463', targets.length) : tr('§1464', targets[0]);
      const layers = c && picked().length > 1 ? tr('§1465', picked().join(', ')) : null;
      confirmRemove({ what, detail: layers, kind: 'clear:sprites', verb: 'clear' }).then(ok => ok && apply(op, { all, confirmed: true, ...opts }));
      return;
    }
    // (each commit renders at once and normalizes: the selection is put back afterwards)
    const drawn = st.layer, unpicked = new Set(st.unpicked), pickedFor = st.pickedFor, sel0 = st.sel, key = `frame-tools-${++stroke}`;
    const names = c && picked().length ? picked() : [drawn];
    let sel = sel0;
    try {
      for (const name of names) {
        st.layer = name;
        const l = layer(), mc = multicolor(), grids = {};
        for (const f of targets) {
          if (l && !l.frames.some(x => x.name === f)) continue;       // a frame without this layer
          // invert: hires pixels are 0 or 2 (the sprite color), multicolor pixels the bit pairs 0-3
          const r = regionOp(pixels(f), op, sel0, { blank: 0, invert: v => (mc ? 3 - v : (v ? 0 : 2)), resize: !!sel0, aspect: mc ? 2 : 1, ...opts });
          if (!r) return snackbar('§0873', { error: true });
          grids[f] = r.grid;
          sel = sel0 && r.rect;
        }
        if (Object.keys(grids).length) commit(grids, mc, names.length > 1 ? key : null);
      }
    } finally {
      st.layer = drawn;
      st.unpicked = unpicked;
      st.pickedFor = pickedFor;
    }
    st.sel = sel;
    update();
    draw();
  }
  const otherFrame = () => { const fs = frames(); return fs[(fs.indexOf(st.frame) + 1) % fs.length]; };

  // swap colors, in the side panel: the pairs of multicolor pens (hires has two values: that is
  // invert). The pixels of the one pen take the other: the picture keeps its shape, the colors
  // move - in this frame (the range, the marked frames) or, with the checkbox, in every frame
  function swapSection() {
    const pens = [[2, '§0637'], [1, '§0650'], [3, '§0651']], pal = colors();
    const swatch = v => h('span', { class: 'swap-swatch', style: { background: PALETTE[pal[v] & 15] } });
    const many = frames().length > 1, all = many && st.swapAll;
    const pairs = [];
    for (let i = 0; i < pens.length; i++) {
      for (let j = i + 1; j < pens.length; j++) {
        const [a, la] = pens[i], [b, lb] = pens[j];
        pairs.push(h('button', { class: 'md-chip md-chip--sm swap-pair', type: 'button', 'data-tip': tr('§0652', la, lb),
          onclick: () => apply('map', { map: swapValues(a, b), all }) }, swatch(a), icon('swap_horiz'), swatch(b)));
      }
    }
    return h('div', { class: 'swap-colors' },
      h('div', { class: 'section__hint', style: { margin: '14px 0 8px' } }, all ? '§0874' : '§0875'),
      h('div', { class: 'inline-actions' }, pairs),
      many ? checkbox('§0876', st.swapAll, v => { st.swapAll = v; update(); }) : '');
  }
  const copyOther = () => commit({ [st.frame]: pixels(otherFrame()) }, multicolor());

  // hires <-> multicolor: the costume's frames with its merged layers, or the overlay layer. The
  // bits stay and are read the other way (convertSprite, adv.js), so switching back gives the frame
  // as it was, drawn on or not
  const switched = (lines, from, mc, sw = 1, sh = 1) => encodeSprite(convertSprite(decodeSprite(lines, from, sw, sh), mc), mc);

  function setMode(mc) {
    const from = multicolor();
    if (mc === from) return;
    const c = costume(), l = layer();
    if (!c) {
      commit(Object.fromEntries(frames().map(f => [f, decodeSprite(switched(encodeSprite(decodeSprite(art(f), from), from), from, mc), mc)])), mc);
    } else {
      const convert = list => list.forEach(f => { f.lines = switched(encodeSprite(decodeSprite(f.lines, from, ...size()), from), from, mc, ...size()); });
      store.mutate(() => {
        const flag = (node, on) => { if (on) node.multicolor = true; else delete node.multicolor; };
        if (l) { convert(l.frames); l.multicolor = mc; }        // the layer: its own mode from now on
        else {
          c.layers.filter(x => x.multicolor == null).forEach(x => { x.multicolor = from; });   // the layers keep theirs
          convert(c.frames);
          flag(c, mc);
        }
      }, { source: 'sprites' });
    }
    render();
  }

  function setHotspot(px, y) {
    store.mutate(g => {
      const sp = spriteItem(g, 'cursor');
      if (px == null) delete sp.hotspot;
      else sp.hotspot = [String(px), String(y)];
    }, { source: 'sprites' });
  }

  // part k (row by row) of a costume of more than one sprite gets color v: 'colors' in the
  // script. The parts before it without a color keep the color they show now
  function setPartColor(k, v) {
    const c = costume(), shown = partColors(c, bodyColor(), constMap(store.game)) ?? [];
    const [w, hh] = costumeSize(c);
    store.mutate(() => {
      const x = costume();
      const list = Array.from({ length: Math.max(k + 1, x.colors?.length ?? 0) }, (_, i) => x.colors?.[i] ?? COLOR_NAMES[shown[i] ?? bodyColor()]);
      list[k] = COLOR_NAMES[v];
      x.colors = list.slice(0, w * hh);
    }, { source: 'sprites' });
    refresh();
    update();
  }

  // the sprite color is the color of the actors that wear the sprite; without one it is only a preview
  function setWearerColor(who, k) {
    if (!who.length) st.previewColor = k;
    else {
      store.mutate(() => who.forEach(a => {
        const at = a.attrs.find(x => x.key === 'color');
        if (at) at.values = [COLOR_NAMES[k]];
        else a.attrs.push({ key: 'color', values: [COLOR_NAMES[k]] });
      }), { source: 'sprites' });
    }
    refresh();
    update();
  }

  function setColor(key, k) {
    store.mutate(g => {
      const it = g.items.find(x => x.kind === 'color' && x.key === key);
      if (it) it.value = COLOR_NAMES[k];
      else insertTop(g, { id: newId(), kind: 'color', key, value: COLOR_NAMES[k] }, [['color'], ['control', 'media', 'platform', 'charset']]);
    }, { source: 'sprites' });
    update();
  }

  function addCostume() {
    const src = costume();
    const frameCopy = src ? src.frames.map(f => ({ id: newId(), name: f.name, ...(f.default ? { default: true } : {}), lines: [...f.lines] }))
      : ['stand', 'walk'].map(name => ({ id: newId(), name, lines: [...(spriteNode(name)?.lines ?? DEFAULT_SPRITES[name])] }));
    const mc = src ? !!src.multicolor : !!spriteNode('stand')?.multicolor;
    let node = null;
    store.mutate(g => {
      node = { id: newId(), kind: 'costume', name: uniqueName(g, 'costume', 'costume'), blank: true, frames: frameCopy, layers: [], anims: [],
        ...(src?.size ? { size: [...src.size] } : {}), ...(src?.colors ? { colors: [...src.colors] } : {}) };
      if (mc) node.multicolor = true;
      insertTop(g, node, [['costume'], ['sprite'], TOP_SETTINGS]);
    }, { source: 'sprites' });
    st.target = node.id;
    st.frame = 'stand';
    st.layer = '';
    render();
  }

  // --- import (the Import button of the app bar: app.js, export.js) ---------------------

  // a new costume from the parts of an imported file, named after it; the view shows it
  function addImported(name, parts) {
    let node = null;
    store.mutate(g => {
      node = { id: newId(), kind: 'costume', name: uniqueName(g, importName(name, 'sprite'), 'costume'), blank: true, anims: [], ...parts };
      node.frames = node.frames.map(f => ({ id: newId(), ...f }));
      node.layers = (node.layers ?? []).map(l => ({ id: newId(), ...l, frames: l.frames.map(f => ({ id: newId(), ...f })) }));
      insertTop(g, node, [['costume'], ['sprite'], TOP_SETTINGS]);
    }, { source: 'sprites' });
    st.target = node.id;
    st.frame = node.frames[0].name;
    st.layer = '';
    st.anim = null;
    st.hidden.clear();
    render();
    return node;
  }

  // a sprite file of yopaca (.spr): its frames, layers, mode, size and colors
  function importSpr(bytes, name) {
    const parts = { file: name };
    costumeFromFile(parts, bytes);
    delete parts.file;
    const node = addImported(name, parts);
    snackbar(tr('§1013', name, node.name, node.frames.length, node.frames.length > 1 ? 's' : ''));
  }

  // C64 sprite blocks (.bin): 64 bytes each (63 without the pad byte), a load address before them
  // is dropped. The file does not tell the mode and how many sprites a frame is: the dialog asks
  async function importBlocks(bytes, name) {
    let d = bytes.length % 64 === 2 || (bytes.length % 64 && bytes.length % 63 === 2) ? bytes.subarray(2) : bytes;
    if (d.length % 64 && d.length % 63 === 0) {                   // 63 byte blocks: the pad byte back
      const n = d.length / 63, out = new Uint8Array(n * 64);
      for (let k = 0; k < n; k++) out.set(d.subarray(k * 63, k * 63 + 63), k * 64);
      d = out;
    }
    const blocks = Math.floor(d.length / 64);
    if (!blocks) throw new Error(tr('§1997', bytes.length));
    const sizes = ['1x1', '2x1', '1x2', '2x2', '3x2', '2x3'].filter(s => s[0] * s[2] <= Math.min(blocks, MAX_ACTOR_SPRITES));
    const v = await promptDialog({
      title: tr('§1008'), icon: 'person', ok: 'Import',
      text: tr('§1998', name, blocks, blocks > 1 ? 's' : ''),
      fields: [
        { name: 'mode', label: '§1009', radios: [{ value: 'hires', label: '§1010' }, { value: 'mc', label: '§1011' }] },
        { name: 'size', label: '§1012', options: sizes.map(s => ({ value: s, label: s.replace('x', ' × ') })) },
      ],
    });
    if (!v) return;
    const [sw, sh] = v.size.split('x').map(Number), mc = v.mode === 'mc', per = sw * sh;
    const count = Math.min(Math.floor(blocks / per), 255);
    const frames = Array.from({ length: count }, (_, k) => ({ name: `frame${k + 1}`, ...(k ? {} : { default: true }),
      lines: blocksToArt(d.subarray(k * per * 64, (k + 1) * per * 64), mc, sw, sh) }));
    const node = addImported(name, { frames, layers: [], ...(mc ? { multicolor: true } : {}), ...(per > 1 ? { size: [String(sw), String(sh)] } : {}) });
    const rest = blocks - count * per;
    snackbar(tr('§1999', name, node.name, count, count > 1 ? 's' : '', rest ? tr('§2000', rest, rest > 1 ? 's' : '') : ''));
  }

  // a SpritePad project (.spd, padfiles.js) as a costume: a frame per sprite - per tile of W x H
  // sprites when it has tiles -, an overlay sprite as the layer 'overlay' of its frame, the mode of
  // the first sprite; one sprite color for all of them becomes the costume's, else the actor's
  // color shows them. Its shared colors become the game's sprite1 / sprite2 when the player says so
  async function importSpd(bytes, name) {
    const p = parseSpd(bytes, name);
    if (!p.sprites.length) throw new Error(tr('§2001', name));
    const over = new Set();                       // the sprites that are an overlay of another one
    p.sprites.forEach((s, k) => { if (s.overlay && p.sprites[k + p.overlay]) over.add(k + p.overlay); });
    const sw = p.tiles?.w ?? 1, sh = p.tiles?.h ?? 1;
    if (sw * sh > MAX_ACTOR_SPRITES) throw new Error(tr('§2002', name, sw, sh, MAX_ACTOR_SPRITES));
    const groups = (p.tiles ? p.tiles.list : p.sprites.map((_, k) => [k])).filter(g => !over.has(g[0])).slice(0, 255);
    const mc = p.sprites[groups[0][0]].multicolor;
    const blocks = g => { const out = new Uint8Array(g.length * 64); g.forEach((k, i) => out.set(p.sprites[k]?.data ?? new Uint8Array(64), i * 64)); return out; };
    const frames = groups.map((g, k) => ({ name: `frame${k + 1}`, ...(k ? {} : { default: true }), lines: blocksToArt(blocks(g), mc, sw, sh) }));
    const layered = groups.map((g, k) => [k, g.map(i => (p.sprites[i]?.overlay ? i + p.overlay : -1))]).filter(([, o]) => o.some(i => i >= 0));
    const layers = [];
    if (layered.length) {
      const first = p.sprites[layered[0][1].find(i => i >= 0)];
      layers.push({ name: 'overlay', ...(first.multicolor ? { multicolor: true } : { hires: true }), color: COLOR_NAMES[first.color],
        frames: layered.map(([k, o]) => ({ name: frames[k].name, lines: blocksToArt(blocks(o.map(i => (i >= 0 ? i : -1))), first.multicolor, sw, sh) })) });
    }
    const used = [...new Set(groups.flat().map(k => p.sprites[k]?.color ?? 0))];
    const parts = sw * sh;
    const colors = used.length === 1 ? { colors: Array(parts).fill(COLOR_NAMES[used[0]]) } : {};
    const shared = spriteColors(store.game);
    let take = false;
    if (mc && (shared[0] !== p.colors.mc1 || shared[1] !== p.colors.mc2)) {
      const v = await promptDialog({
        title: tr('§1692'), icon: 'person', ok: 'Import',
        text: tr('§1697', name, frames.length),
        fields: [{ name: 'shared', label: '§1698', value: 'file', radios: [
          { value: 'file', label: tr('§1699', COLOR_NAMES[p.colors.mc1], COLOR_NAMES[p.colors.mc2]) },
          { value: 'game', label: tr('§1700', COLOR_NAMES[shared[0]], COLOR_NAMES[shared[1]]) }] }],
      });
      if (!v) return;
      take = v.shared === 'file';
    }
    if (take) { setColor('sprite1', p.colors.mc1); setColor('sprite2', p.colors.mc2); }
    const node = addImported(name, { frames, layers, ...(mc ? { multicolor: true } : {}), ...(parts > 1 ? { size: [String(sw), String(sh)] } : {}), ...colors });
    const notes = [used.length > 1 ? tr('§1701', used.map(c => COLOR_NAMES[c]).join(', ')) : '', p.anims ? tr('§1702', p.anims) : ''].join('');
    snackbar(tr('§1694', name, node.name, frames.length, layers.length ? tr('§1703', layered.length) : '', notes));
  }

  const importFormats = () => (!store.game ? [] : [
    { label: '§1017', icon: 'person', accept: '.spr', open: importSpr },
    { label: '§1692', icon: 'person', accept: '.spd', open: importSpd },
    { label: '§1007', icon: 'person', accept: '.bin,.raw,.prg', open: importBlocks },
  ]);

  function resetBuiltIn() {
    const custom = frames().map(spriteNode).filter(Boolean);
    store.mutate(g => { g.items = g.items.filter(x => !custom.includes(x)); }, { source: 'sprites' });
    render();
  }

  // --- frames, layers and animations of a costume -------------------------------------

  // a name for a frame or a layer. fresh: the name of a new one - the proposed name is an answer;
  // else it is a rename, and the name as it was changes nothing
  async function askName(title, value, taken, text = '', fresh = false) {
    const v = await promptDialog({
      title, icon: 'label', ok: 'OK', text,
      fields: [{ name: 'name', label: '§1293', value, mono: true,
        validate: n => (!NAME_RE.test(n) ? '§0404' : KEYWORDS.has(n) ? tr('§0877', n)
          : taken.includes(n) && (fresh || n !== value) ? tr('§0121', n) : null) }],
    });
    return v && (fresh || v.name !== value) ? v.name : null;
  }

  // one undo step that changes the costume, then the side panel and canvas again
  function change(fn) {
    store.mutate(() => fn(costume()), { source: 'sprites' });
    normalize();
    render();
  }

  async function newFrame(copy) {
    const c = costume();
    const names = c.frames.map(f => f.name);
    const name = await askName(copy ? tr('§0878', st.frame) : '§0879', uniqueFrameName(names, copy ? st.frame : 'frame'), names, '', true);
    if (!name) return;
    change(x => {
      const at = x.frames.findIndex(f => f.name === st.frame) + 1;
      x.frames.splice(at, 0, { id: newId(), name, lines: copy ? [...costumeFrame(x, st.frame)] : blankArt(...costumeSize(x)) });
      if (copy) {
        for (const l of x.layers) {
          const f = l.frames.find(y => y.name === st.frame);
          if (f) l.frames.splice(l.frames.indexOf(f) + 1, 0, { id: newId(), name, lines: [...f.lines] });
        }
      }
    });
    st.frame = name;
    render();
  }

  // a name not taken yet: base itself, else base2, base3 ... - a word of the costume syntax
  // ('layer', 'frame') is no name, a new layer is layer1, layer2 ...
  function uniqueFrameName(names, base) {
    if (!names.includes(base) && !KEYWORDS.has(base)) return base;
    for (let k = KEYWORDS.has(base) && base !== 'frame' ? 1 : 2; ; k++) if (!names.includes(base + k)) return base + k;
  }

  async function renameFrame() {
    const c = costume(), old = st.frame;
    const name = await askName(tr('§0880', old), old, c.frames.map(f => f.name),
      '§0881');
    if (name) renameFrameTo(old, name);
  }

  // the animations that show a frame, as a sentence for the side panel
  function animsWith(c, frame) {
    const names = c.anims.filter(a => a.frames.includes(frame)).map(a => a.name);
    return names.length ? tr('§1067', names.length > 1 ? 's' : '', names.join(', ')) : '';
  }

  // why a frame of costume c cannot be named n (null: it can)
  const frameNameError = (c, n) => (!NAME_RE.test(n) ? '§0404'
    : KEYWORDS.has(n) ? tr('§0877', n) : c.frames.some(f => f.name === n) ? tr('§0121', n) : null);

  // the layers and animations follow the new name
  function renameFrameTo(old, name) {
    change(x => {
      // the frame 'stand' without a default flag stays the default under its new name
      if (old === defaultFrame(x) && !x.frames.some(f => f.default)) x.frames.find(f => f.name === old).default = true;
      for (const list of [x.frames, ...x.layers.map(l => l.frames)]) list.forEach(f => { if (f.name === old) f.name = name; });
      x.anims.forEach(a => { a.frames = a.frames.map(f => (f === old ? name : f)); });
    });
    if (st.range) st.range.frames = st.range.frames.map(f => (f === old ? name : f));
    st.frame = name;
    render();
  }

  async function deleteFrame() {
    const c = costume(), name = st.frame;
    if (name === defaultFrame(c)) return snackbar('§0882');
    const anims = c.anims.filter(a => a.frames.includes(name)).map(a => a.name);
    if (!(await confirmRemove({ what: tr('§1464', name), detail: anims.length ? tr('§1466', anims.join(', ')) : null, kind: 'sprite-frame' }))) return;
    if (costume() !== c || st.frame !== name) return;
    change(x => {
      x.frames = x.frames.filter(f => f.name !== name);
      x.layers.forEach(l => { l.frames = l.frames.filter(f => f.name !== name); });
      x.anims.forEach(a => { a.frames = a.frames.filter(f => f !== name); });
      x.anims = x.anims.filter(a => a.frames.length || a.mirror);
      dropMirrors(x);
    });
    snackbar(tr('§0883', name, c.name), { action: 'Undo', onaction: () => store.undo() });
  }

  // the art of a frame for another size: cut off or filled with clear pixels
  const resizeArt = (lines, mc, w, hh) => {
    const cols = (mc ? SPRITE_COLS / 2 : SPRITE_COLS) * w;
    return Array.from({ length: SPRITE_ROWS * hh }, (_, y) => (lines[y] ?? '').padEnd(cols, '.').slice(0, cols));
  };

  // the costume becomes W x H sprites: all its frames and layers get that size
  function setSize(w, hh) {
    const c = costume();
    if (!Number.isInteger(w) || !Number.isInteger(hh) || w < 1 || hh < 1 || w > MAX_ACTOR_SPRITES || hh > MAX_ACTOR_SPRITES) {
      return snackbar(tr('§0884', MAX_ACTOR_SPRITES), { error: true });
    }
    const sprites = w * hh * (1 + mostLayers(c));
    if (sprites > MAX_ACTOR_SPRITES) {
      return snackbar(tr('§0885', w, hh, sprites, MAX_ACTOR_SPRITES), { error: true });
    }
    change(x => {
      const fit = (list, mc) => list.forEach(f => { f.lines = resizeArt(f.lines, mc, w, hh); });
      fit(x.frames, !!x.multicolor);
      x.layers.forEach(l => fit(l.frames, layerMulticolor(x, l)));
      if (w === 1 && hh === 1) delete x.size;
      else x.size = [String(w), String(hh)];
      if (x.colors) {                       // a color per sprite: the parts that are left
        x.colors = w * hh > 1 ? x.colors.slice(0, w * hh) : [];
        if (!x.colors.length) delete x.colors;
      }
    });
  }

  const sizeHint = c => {
    const [w, hh] = costumeSize(c);
    return tr('§0886', w * SPRITE_COLS, hh * SPRITE_ROWS, w * hh * (1 + mostLayers(c)), MAX_ACTOR_SPRITES);
  };

  // a layer for the frame shown: a new one, or one the sprite has in other frames (a cap on the
  // next walking frame too)
  function addLayerMenu(e) {
    const c = costume(), here = new Set(frameLayers().map(l => l.name));
    const others = c.layers.filter(l => !here.has(l.name));
    if (!others.length) return addLayer();
    openMenu(e.currentTarget, [
      { label: '§0757', icon: 'add', onclick: addLayer },
      { divider: true },
      { header: '§0758' },
      ...others.map(l => ({ label: l.name, icon: 'stack', onclick: () => useLayer(l.name) })),
    ]);
  }

  // the layer gets an empty frame of the frame shown (in the order of the costume's frames):
  // from now on it belongs to that frame, drawn on or not
  function addLayerFrame(x, l, frame) {
    if (l.frames.some(f => f.name === frame)) return;
    const order = x.frames.map(f => f.name);
    const at = l.frames.filter(f => order.indexOf(f.name) < order.indexOf(frame)).length;
    const mc = layerMulticolor(x, l);                           // empty, in the layer's mode
    l.frames.splice(at, 0, { id: newId(), name: frame, lines: encodeSprite(decodeSprite([], mc, ...costumeSize(x)), mc) });
  }

  function useLayer(name) {
    const frame = st.frame;
    change(x => addLayerFrame(x, x.layers.find(l => l.name === name), frame));
    st.layer = name;
    render();
  }

  async function addLayer() {
    const c = costume(), frame = st.frame;
    const name = await askName('§0756', uniqueFrameName(c.layers.map(l => l.name), 'layer'), c.layers.map(l => l.name),
      '§0765', true);
    if (!name) return;
    change(x => {
      const l = { name, frames: [] };
      x.layers.push(l);
      addLayerFrame(x, l, frame);
    });
    st.layer = name;
    render();
  }

  async function renameLayer(l) {
    const name = await askName(tr('§0887', l.name), l.name, costume().layers.map(x => x.name));
    if (!name) return;
    const hidden = st.hidden.delete(l.name);
    change(x => { x.layers.find(y => y.name === l.name).name = name; });
    if (hidden) st.hidden.add(name);
    st.layer = name;
    render();
  }

  // the layer leaves the frame shown; without a frame left it leaves the sprite
  async function deleteLayer(l) {
    const frame = st.frame, only = l.frames.length === 1;
    if (!(await confirmRemove({ what: tr('§1467', l.name, frame), detail: only ? '§1468' : null, kind: 'sprite-layer', verb: 'remove' }))) return;
    change(x => {
      const y = x.layers.find(z => z.name === l.name);
      y.frames = y.frames.filter(f => f.name !== frame);
      if (!y.frames.length) x.layers = x.layers.filter(z => z !== y);
    });
    if (st.layer === l.name) st.layer = '';
    snackbar(tr('§0761', l.name, frame), { action: 'Undo', onaction: () => store.undo() });
    render();
  }

  function setLayerColor(k) {
    const name = st.layer;
    store.mutate(() => { costume().layers.find(l => l.name === name).color = COLOR_NAMES[k]; }, { source: 'sprites' });
    refresh();
    update();
  }

  // a range is marked by drag, shift+click or ctrl+click (picked), not by the plain click that picks a frame
  const isMarked = r => !!r && (r.frames.length > 1 || !!r.picked);
  // the frames of a costume marked in the grid, or null
  const markedFrames = c => (st.range?.target === c.id && isMarked(st.range) ? [...st.range.frames] : null);

  // a new animation of the marked frames: walk, stand, talk or idle and a direction fill in its
  // name, which can be changed; an animation of that name gets the marked frames
  async function addAnim() {
    const c = costume(), marked = markedFrames(c);
    if (!marked) {
      dialog({
        title: tr('§0888'), icon: 'select_all',
        content: h('div', { class: 'md-body-medium' },
          '§0889'),
        actions: [{ label: 'OK', value: true, variant: 'filled' }],
      });
      return;
    }
    if (marked.length > MAX_ANIM_FRAMES) return snackbar(tr('§0890', MAX_ANIM_FRAMES), { error: true });
    const nameOf = ({ role, dir }) => (dir ? `${role}_${dir}` : role);
    let auto = 'stand';                   // the name the radios filled in; a typed name stays
    const follow = (_, dlg) => {
      const v = dlg.values();
      if (v.name !== auto) return;
      auto = nameOf(v);
      dlg.set('name', auto);
    };
    const n = marked.length;
    const v = await promptDialog({
      title: tr('§0891'), icon: 'animation', ok: '§0124',
      text: `Of the ${n} marked frame${n > 1 ? 's' : ''}. 'stand' plays while the actor stands, 'walk' while it walks, 'talk' while it talks, 'idle' once it has stood still for the idle time of the sprite; a direction without its own animation shows the one for all directions, mirrored facing left. Another name makes an animation that 'animate ACTOR NAME' plays. An animation of that name gets these frames.`,
      fields: [
        { name: 'role', label: '§2027', value: 'stand', onchange: follow,
          radios: ['walk', 'stand', 'talk', 'idle'].map(r => ({ value: r, label: r })) },
        { name: 'dir', label: '§0398', value: '', onchange: follow,
          radios: [{ value: '', label: '§0892' }, ...DIRECTIONS.map(d => ({ value: d, label: d }))] },
        { name: 'name', label: '§1293', value: auto, mono: true,
          validate: x => (!NAME_RE.test(x) ? '§0404' : KEYWORDS.has(x) ? tr('§0877', x) : null) },
      ],
    });
    if (!v) return;
    change(x => {
      const a = x.anims.find(y => y.name === v.name);
      if (a) a.frames = [...marked];
      else x.anims.push({ name: v.name, frames: [...marked], speed: null });
    });
    selectAnim(v.name);
  }

  // open (select) an animation in the side panel, or close it (null)
  function selectAnim(name) {
    st.anim = name;
    st.step = 0;
    st.tick = 0;
    st.playing = true;
    update();
    markGrid();
  }

  async function deleteAnim(name) {
    const a = costume()?.anims.find(x => x.name === name);
    const mirrored = costume()?.anims.find(x => x.mirror && mirrorPartner(x.name) === name);
    const detail = a?.mirror ? null : [a ? tr('§1452', a.frames.length) : '', mirrored ? tr('§1678', mirrored.name) : ''].filter(Boolean).join(' ') || null;
    if (!(await confirmRemove({ what: tr('§1469', name), detail, kind: 'sprite-anim' }))) return;
    change(x => {
      x.anims = x.anims.filter(a => a.name !== name);
      dropMirrors(x);
    });
    snackbar(tr('§0893', name), { action: 'Undo', onaction: () => store.undo() });
  }

  // a 'mirror' animation goes with the animation it mirrors
  function dropMirrors(x) {
    x.anims = x.anims.filter(a => !a.mirror || x.anims.some(b => !b.mirror && b.name === mirrorPartner(a.name)));
  }

  // 'mirror' on or off for the animation of costume x named name: on, it plays its partner
  // mirrored and has no frames; off, it gets a copy of the partner's frames and speed to draw
  // its own. The animation is made when the costume has none of that name.
  function setMirror(x, name, on) {
    const partner = x.anims.find(b => b.name === mirrorPartner(name) && !b.mirror);
    let a = x.anims.find(b => b.name === name);
    if (!a) {
      if (!on) return;
      a = { name, frames: [], speed: null };
      x.anims.splice(x.anims.indexOf(partner) + 1, 0, a);
    }
    if (on) Object.assign(a, { mirror: true, frames: [], speed: null });
    else {
      delete a.mirror;
      Object.assign(a, { frames: [...(partner?.frames ?? [])], speed: partner?.speed ?? null });
    }
  }

  // --- tools -------------------------------------------------------------------------

  // the cells the line, box, circle or curve tool draws for drag d
  const dragTool = () => DRAG_TOOLS.has(st.tool);
  // the grid the brush paints in (drawtools.js): the pixels of the sprite, double wide in multicolor
  const brushGrid = () => {
    const [sw, sh] = size(), mc = multicolor();
    return { aspect: mc ? 2 : 1, w: SPRITE_COLS * sw >> (mc ? 1 : 0), h: SPRITE_ROWS * sh };
  };
  // the cells the brush paints along cells, with the tools that draw with it
  const brushed = cells => (BRUSH_TOOLS.has(st.tool) ? brushCells(cells, st.brush, brushGrid()) : cells);
  // inside the sprite: the curve may reach beyond it
  const dragCells = d => {
    const [sw, sh] = size(), cols = SPRITE_COLS * sw >> (multicolor() ? 1 : 0), rows = SPRITE_ROWS * sh;
    return brushed(dragXY(st.tool, d.start, d.end, { ...d, aspect: multicolor() ? 2 : 1, radius: st.radius })).filter(p => p.x >= 0 && p.y >= 0 && p.x < cols && p.y < rows);
  };

  function floodCells(grid, start, value) {
    const from = grid[start.y][start.x];
    if (from === value) return [];
    const seen = new Set(), cells = [], stack = [start];
    while (stack.length) {
      const { x, y } = stack.pop();
      if (grid[y]?.[x] !== from || seen.has(y * 64 + x)) continue;
      seen.add(y * 64 + x);
      cells.push({ x, y });
      stack.push({ x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 });
    }
    return cells;
  }

  // --- drawing -----------------------------------------------------------------------

  function draw() {
    if (!ui) return;
    const mc = multicolor(), k = mc ? 2 : 1, s = st.cell;
    const [sw, sh] = size(), cols = SPRITE_COLS * sw, rows = SPRITE_ROWS * sh;
    const { canvas } = ui;
    canvas.classList.toggle('paint-canvas--brush', BRUSH_TOOLS.has(st.tool));   // the brush outline is the cursor
    canvas.width = cols * s;
    canvas.height = rows * s;
    const ctx = canvas.getContext('2d');
    const pal = colors();
    ctx.fillStyle = PALETTE[st.bg];
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    reference.draw(ctx, s, false);          // the image to trace, behind the pixels
    const c = costume();
    if (c) {                                // the other visible layers, dimmed
      ctx.globalAlpha = 0.35;
      drawCostumeFrame(ctx, store.game, c, st.frame, 0, 0, s, bodyColor(), false, new Set([...st.hidden, st.layer]));
      ctx.globalAlpha = 1;
    }
    // the costume's own frames and merged layers: a sprite color per part (not the overlay layer)
    const parts = c && !layer() ? partColors(c, bodyColor(), constMap(store.game)) : null;
    const cell = (x, y, v) => {
      ctx.fillStyle = PALETTE[v === 2 && parts ? parts[Math.floor(y / SPRITE_ROWS) * sw + Math.floor(x * k / SPRITE_COLS)] : pal[v]];
      ctx.fillRect(x * k * s, y * s, k * s, s);
    };
    if (!st.hidden.has(st.layer) || !c) shownPixels().forEach((row, y) => row.forEach((v, x) => { if (v) cell(x, y, v); }));
    const d = st.drag;
    if (d && dragTool()) {
      ctx.globalAlpha = 0.8;
      dragCells(d).forEach(q => cell(q.x, q.y, d.value));
      ctx.globalAlpha = 1;
    }
    reference.draw(ctx, s, true);           // or in front of them
    if (st.grid) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(128, 128, 128, .3)';
      ctx.beginPath();
      for (let x = k; x < cols; x += k) { ctx.moveTo(x * s + .5, 0); ctx.lineTo(x * s + .5, canvas.height); }
      for (let y = 1; y < rows; y++) { ctx.moveTo(0, y * s + .5); ctx.lineTo(canvas.width, y * s + .5); }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(128, 128, 128, .7)';     // byte boundaries
      ctx.beginPath();
      for (let x = 8; x < cols; x += 8) { ctx.moveTo(x * s + .5, 0); ctx.lineTo(x * s + .5, canvas.height); }
      ctx.stroke();
    }
    const range = d && st.tool === 'select' ? rectBetween(d.start, d.end) : st.sel;
    if (range) {
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#00e5ff';
      ctx.lineWidth = 2;
      ctx.strokeRect(range.x * k * s + 1, range.y * s + 1, range.w * k * s - 2, range.h * s - 2);
      ctx.setLineDash([]);
    }
    if (sw * sh > 1) {                     // where one sprite of the group ends and the next begins
      ctx.strokeStyle = 'rgba(255, 213, 79, .85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let x = SPRITE_COLS; x < cols; x += SPRITE_COLS) { ctx.moveTo(x * s, 0); ctx.lineTo(x * s, canvas.height); }
      for (let y = SPRITE_ROWS; y < rows; y += SPRITE_ROWS) { ctx.moveTo(0, y * s); ctx.lineTo(canvas.width, y * s); }
      ctx.stroke();
    }
    if (st.target === 'cursor') {
      const [hx, hy] = hotspot();
      ctx.strokeStyle = '#ffd54f';
      ctx.lineWidth = 2;
      ctx.strokeRect(hx * s + 1, hy * s + 1, s - 2, s - 2);
      ctx.beginPath();
      ctx.moveTo(hx * s + s / 2, hy * s - s / 2); ctx.lineTo(hx * s + s / 2, hy * s + s * 1.5);
      ctx.moveTo(hx * s - s / 2, hy * s + s / 2); ctx.lineTo(hx * s + s * 1.5, hy * s + s / 2);
      ctx.stroke();
    }
    if (st.hover) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      if (st.tool === 'hotspot') ctx.strokeRect(st.hover.px * s + 1, st.hover.y * s + 1, s - 2, s - 2);
      else {
        const covers = brushed([st.hover]);
        if (!d) {                             // what the brush covers
          ctx.fillStyle = 'rgba(255, 255, 255, .25)';
          covers.forEach(q => ctx.fillRect(q.x * k * s, q.y * s, k * s, s));
        }
        outlineCells(ctx, covers, k * s, s);  // the cursor: the brush in its shape, size and pixel width
      }
    }
  }

  // a frame as the game shows it: the costume with its visible layers, else the sprite
  function paintSprite(cv, frame, u, mirror = false, x = 0, y = 0) {
    const ctx = cv.getContext('2d');
    const c = costume();
    if (c) {
      drawCostumeFrame(ctx, store.game, c, frame, x, y, u, bodyColor(), mirror, st.hidden);
      return;
    }
    const pal = colors();
    drawSprite(ctx, art(frame), multicolor(), x, y, u, [pal[2], pal[1], pal[3]], mirror);
  }

  // the animation the preview plays: the selected one of a costume (null: none selected)
  function previewAnim() {
    const c = costume();
    if (!c) return null;                    // the default sprite has no animations of its own
    const a = st.anim && c.anims.find(x => x.name === st.anim);
    const { anim: src, mirror } = animPlays(c, a);
    return src ? { name: a.name, frames: animSequence(src), mirror, speed: numValue(src.speed, constMap(store.game)) || DEFAULT_ANIM_SPEED,
      vary: numValue(src.vary, constMap(store.game)) || 0 } : null;
  }

  // the preview shows only the selected animation, as its frames are drawn
  function drawPreview() {
    const cv = ui?.preview;
    if (!cv) return;
    const cursor = st.target === 'cursor', [sw, sh] = size(), u = Math.max(1, 4 - Math.max(sw, sh));
    const anim = cursor ? null : previewAnim();
    cv.width = (SPRITE_COLS * sw + 8) * u;
    cv.height = (SPRITE_ROWS * sh + 6) * u;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = PALETTE[st.bg];
    ctx.fillRect(0, 0, cv.width, cv.height);
    if (cursor) paintSprite(cv, 'cursor', u, false, 4, 3);
    else if (anim) paintSprite(cv, anim.frames[st.step % anim.frames.length], u, anim.mirror, 4, 3);
    if (ui.previewCaption) {
      ui.previewCaption.textContent = cursor ? '' : anim ? `${anim.name} · ${t(tr('§1130', anim.frames.length, anim.frames.length > 1 ? 's' : ''))}`
        : tr('§0894');
    }
  }

  function status() {
    if (!ui) return;
    const mc = multicolor(), c = st.hover, l = layer();
    const what = costume() ? ` · frame ${st.frame}${l ? ` · layer ${l.name}` : ''}${frameLayers().length ? ` · ${picked().length} of ${frameLayers().length + 1} selected` : ''}` : '';
    const mode = (mc ? '§0895' : '§0896') + what;
    const marked = costume() && markedFrames(costume());
    const hs = st.target === 'cursor' ? ` · hot spot ${hotspot().join(', ')}${spriteNode('cursor')?.hotspot ? '' : ' (automatic)'}` : '';
    const range = (st.sel ? ` · range ${st.sel.w} × ${st.sel.h}` : '') + (marked ? ` · ${marked.length} frame${marked.length > 1 ? 's' : ''} marked` : '');
    if (!c) { statusLine.value = mode + hs + range; return; }
    const v = pixels()[c.y][c.x];
    statusLine.value = `x ${mc ? `${c.x} (pixels ${c.x * 2}-${c.x * 2 + 1})` : c.x}, y ${c.y} · ${PEN_LABELS[v]} · ${mode}${hs}${range}`;
  }

  function refresh() {
    draw();
    drawPreview();
    drawGrid();
    status();
  }

  // the preview steps with the speed of its animation, 50 frames per second like PAL
  function animate() {
    clearInterval(timer);
    timer = setInterval(() => {
      if (!ui || el.hidden || !el.isConnected) { clearInterval(timer); timer = 0; return; }
      if (!st.playing || st.target === 'cursor') return;
      const a = previewAnim();
      if (!a) return;
      st.tick++;
      if (st.tick >= (st.wait ?? a.speed)) {      // a step: the speed, +- up to vary at random as in the game
        st.tick = 0;
        st.wait = a.speed + (a.vary ? Math.floor(Math.random() * (2 * a.vary + 1)) - a.vary : 0);
        st.step++;
        drawPreview();
        markGrid();
      }
    }, 20);
  }

  // --- input -------------------------------------------------------------------------

  // the pixel under the pointer, the nearest one of the sprite outside it; free: the pixel outside as well
  function cellAt(e, free = false) {
    const r = ui.canvas.getBoundingClientRect();
    const [sw, sh] = size(), cols = SPRITE_COLS * sw, rows = SPRITE_ROWS * sh;
    const fx = Math.floor((e.clientX - r.left) / r.width * cols), fy = Math.floor((e.clientY - r.top) / r.height * rows);
    const px = free ? fx : Math.max(0, Math.min(cols - 1, fx));
    const y = free ? fy : Math.max(0, Math.min(rows - 1, fy));
    return { x: multicolor() ? px >> 1 : px, y, px };
  }

  function onDown(e) {
    e.preventDefault();
    ui.canvas.setPointerCapture(e.pointerId);
    ui.wrap.focus({ preventScroll: true });
    const cell = cellAt(e);
    if (waits(st.drag)) { strokeDown(st.drag, cellAt(e, true), e); draw(); return; }   // the bend of a curve, a corner of a polygon
    const clear = e.button === 2;
    const value = clear ? 0 : st.pen;
    stroke++;
    switch (st.tool) {
      case 'pencil': st.drag = { last: cell, value }; paintCells(brushed([cell]), value, 'sprite:' + stroke); break;
      case 'line': case 'rect': case 'circle': case 'curve': case 'polygon':
        st.drag = { start: cell, end: cell, value, ...dragMods(e) }; draw(); break;
      case 'fill': paintCells(floodCells(pixels(), cell, value), value); break;
      case 'pick': setPen(pixels()[cell.y][cell.x]); setTool('pencil'); break;
      case 'hotspot': setHotspot(clear ? null : cell.px, cell.y); break;
      case 'select': st.drag = { start: cell, end: cell }; draw(); break;
    }
  }

  function onMove(e) {
    if (!ui) return;
    const cell = cellAt(e);
    const h0 = st.hover;
    st.hover = cell;
    const d = st.drag;
    if (d && WAIT_TOOLS.has(st.tool)) {   // beyond the sprite as well: dragCells clips the curve or the polygon
      const at = cellAt(e, true), p = d.bend ?? d.end;
      if (at.x !== p.x || at.y !== p.y) { dragTo(d, at, e); draw(); status(); }
      return;
    }
    if (h0?.x === cell.x && h0?.y === cell.y && h0?.px === cell.px) return;
    if (d && st.tool === 'pencil') {
      paintCells(brushed(lineCells(d.last, cell)), d.value, 'sprite:' + stroke);
      d.last = cell;
    } else if (d) dragTo(d, cell, e);
    draw();
    status();
  }

  function onUp() {
    const d = st.drag;
    st.drag = null;
    if (d && curveWaits(st.tool, d)) { st.drag = d; draw(); return; }
    if (d && dragTool()) paintCells(dragCells(d), d.value);
    if (d && st.tool === 'select') {        // a click without dragging clears the range
      st.sel = d.start.x === d.end.x && d.start.y === d.end.y ? null : rectBetween(d.start, d.end);
      status();
    }
    draw();
  }

  function onKey(e) {
    if (e.target.closest('input, select, textarea')) return;
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (key === 'c' || key === 'v')) {
      if (key === 'c') copy(); else paste();
      e.preventDefault(); e.stopPropagation();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tool = toolForKey(toolsOf(st.target), key);
    const op = rangeForKey(RANGE, e);
    const pen = penOrder()[Number(e.key) - 1];
    if (tool) setTool(tool);
    else if (op) apply(op);
    else if (pen !== undefined) setPen(pen);
    else if (key === 'f' && frames().length > 1) { st.frame = otherFrame(); render(); }
    else if (e.key === 'Escape') cancel();
    else if (e.key === '+') zoom(1);
    else if (e.key === '-') zoom(-1);
    else return;
    e.preventDefault();
  }

  // Escape: the curve being bent or the polygon being drawn, else the range on the canvas and the frames marked in the strip
  function cancel() {
    if (rot.stop(false)) return true;
    if (waits(st.drag)) { st.drag = null; draw(); return true; }   // a curve or a polygon not drawn yet
    if (!st.sel && !st.range) return false;
    st.sel = null; st.range = null;
    render();
    return true;
  }

  function setTool(tool) {
    if (waits(st.drag)) st.drag = null;   // a curve or a polygon not drawn yet is dropped
    st.tool = tool;
    update();
    draw();
  }

  function setPen(v) {
    st.pen = v;
    update();
  }

  function zoom(dir) {
    const k = ZOOM.indexOf(st.cell);
    st.cell = ZOOM[Math.max(0, Math.min(ZOOM.length - 1, (k < 0 ? 3 : k) + dir))];
    draw();
  }

  // --- side panel ----------------------------------------------------------------------

  const section = (title, action, ...content) => uiSection(title, content, action);


  // the layers of the frame shown (a layer belongs to the frames it has art in)
  function layersSection(c) {
    const others = l => l.frames.filter(f => f.name !== st.frame).length;
    const rows = [{ name: '', title: tr('§1109', st.frame), sub: tr('§0763', c.name, c.multicolor ? 'multicolor' : 'hires') },
      ...frameLayers().map(l => ({ name: l.name, title: l.name, layer: l,
        sub: `${layerMulticolor(c, l) ? 'multicolor' : 'hires'} · ${l.color ?? 'black'}`
          + (others(l) ? tr('§2003', others(l), others(l) > 1 ? 's' : '') : '') }))];
    // a click picks the layer to draw on; the check box (or Ctrl/Shift+click) takes a layer out of
    // the selection or puts it back: the frame tools (shift, mirror, flip, rotate, clear) change them all
    const toggle = name => {
      if (st.unpicked.has(name)) st.unpicked.delete(name); else st.unpicked.add(name);
      render();
    };
    const pick = (r, e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey) return toggle(r.name);
      st.layer = r.name;
      render();
    };
    const list = h('div', { class: 'layer-list' }, rows.map(r => h('div', {
      class: `layer-row ${r.name === st.layer ? 'layer-row--drawn' : ''} ${st.unpicked.has(r.name) ? '' : 'layer-row--picked'}`, onclick: e => pick(r, e),
    },
    iconButton(st.unpicked.has(r.name) ? 'check_box_outline_blank' : 'check_box',
      st.unpicked.has(r.name) ? '§0768' : '§0769', () => toggle(r.name), 'md-icon-button--sm'),
    iconButton(st.hidden.has(r.name) ? 'visibility_off' : 'visibility', st.hidden.has(r.name) ? '§0897' : '§0898', () => {
      if (st.hidden.has(r.name)) st.hidden.delete(r.name); else st.hidden.add(r.name);
      refresh();
      update();
    }, 'md-icon-button--sm'),
    h('div', { class: 'layer-row__text' }, h('span', { class: 'md-label-large' }, r.title), h('span', { class: 'md-body-small' }, r.sub)),
    r.layer ? iconButton('edit', '§0899', () => renameLayer(r.layer), 'md-icon-button--sm') : '',
    r.layer ? iconButton('delete', '§0760', () => deleteLayer(r.layer), 'md-icon-button--sm') : '')));
    const l = layer();
    return section(tr('§0762', st.frame), iconButton('add', '§0759', addLayerMenu, 'md-icon-button--sm'), list,
      l ? h('div', { class: 'layer-options' },
        h('div', { class: 'section__hint', style: { margin: '0' } },
          '§0764'))
        : h('div', { class: 'section__hint', style: { margin: '10px 0 0' } },
          frameLayers().length ? '§0973' : '§0770'),
      frameLayers().length ? h('div', { class: 'section__hint', style: { margin: '8px 0 0' } },
        picked().length ? tr('§0766', picked().length, rows.length)
          : '§0767') : '');
  }

  // the animations added to the sprite (not the built-in stand and walk): a row with the name and
  // a delete button. Click one to select it: its frames are highlighted in the strip, the preview
  // plays it and its speed slider shows under it
  function animsSection(c) {
    const marked = markedFrames(c);
    const setPlay = (name, v) => {
      change(x => {
        const a = x.anims.find(y => y.name === name);
        if (!a) return;
        if (v === 'forward') delete a.play;
        else a.play = v;
      });
      st.step = 0;
      update();
      markGrid();
    };
    const setVary = (name, v) => store.mutate(() => {
      const a = costume()?.anims.find(x => x.name === name);
      if (!a) return;
      if (v) a.vary = String(v); else delete a.vary;
    }, { key: `anim:${name}:vary`, source: 'sprites' });
    const setSpeed = (name, v) => store.mutate(() => {
      const a = costume()?.anims.find(x => x.name === name);
      if (a) a.speed = v;
    }, { key: `anim:${name}:speed`, source: 'sprites' });
    const toggleMirror = (name, on) => { change(x => setMirror(x, name, on)); update(); markGrid(); };
    // an animation for left or right: drawn, or the other one mirrored (no frames of its own)
    const mirrorOption = a => {
      const partner = mirrorPartner(a.name);
      if (!partner) return '';
      if (a.mirror) {
        return [checkbox(tr('§1675', partner), true, on => toggleMirror(a.name, on)),
          h('div', { class: 'section__hint', style: { margin: '6px 0 0' } }, tr('§1677', partner))];
      }
      const other = c.anims.find(x => x.name === partner);
      return checkbox(tr('§1676', partner), !!other?.mirror, on => toggleMirror(partner, on));
    };
    const rows = c.anims.flatMap(a => [h('div', {
      class: `layer-row ${st.anim === a.name ? 'layer-row--selected' : ''}`,
      onclick: () => selectAnim(st.anim === a.name ? null : a.name),
    },
    h('div', { class: 'layer-row__text' }, h('span', { class: 'md-label-large' }, a.name),
      a.mirror ? h('span', { class: 'md-body-small', style: { marginLeft: '8px', opacity: 0.7 } }, tr('§1679', mirrorPartner(a.name))) : ''),
    iconButton('delete', '§0900', () => deleteAnim(a.name), 'md-icon-button--sm')),
    st.anim === a.name ? h('div', { class: 'layer-options' },
      a.mirror ? '' : speedSlider({ speed: a.speed, consts: constMap(store.game), oninput: v => setSpeed(a.name, v), onchange: () => update() }),
      a.mirror ? '' : h('div', { style: { marginTop: '10px' } }, slider({ label: '§1704', min: 0, max: MAX_VARY,
        value: Number(numValue(a.vary, constMap(store.game)) ?? 0), format: v => (v ? tr('§1705', v) : '§1706'), tip: '§1707',
        oninput: v => setVary(a.name, v), onchange: () => update() })),
      a.mirror ? '' : h('div', { class: 'anim-play', style: { marginTop: '10px' } },
        h('div', { class: 'md-label-medium', style: { marginBottom: '4px' } }, '§1687'),
        segmented(ANIM_PLAYS.map((v, k) => ({ value: v, label: ['§1684', '§1685', '§1686'][k], tip: ['§1688', '§1689', '§1690'][k] })),
          a.play ?? 'forward', v => setPlay(a.name, v))),
      h('div', { style: { marginTop: a.mirror ? '0' : '10px' } }, mirrorOption(a))) : '']);
    return section('§0504', iconButton('add', marked ? tr('§1073', marked.length, marked.length > 1 ? 's' : '') : '§0901', addAnim, 'md-icon-button--sm'),
      h('div', { class: 'section__hint' }, '§0902'),
      rows.length ? h('div', { class: 'layer-list' }, rows) : '',
      h('div', { style: { marginTop: '22px' } }, idleSlider(c)));
  }

  // the idle time, under the animations: how long an actor stands still before it plays the
  // animation 'idle' (or idle_front ... in its direction)
  function idleSlider(c) {
    const value = /^\d+$/.test(String(c.idle ?? '')) ? Number(c.idle) : DEFAULT_IDLE;
    const set = v => store.mutate(() => {
      const x = costume();
      if (v === DEFAULT_IDLE) delete x.idle;
      else x.idle = String(v);
    }, { key: `costume:${c.name}:idle`, source: 'sprites' });
    const has = c.anims.some(a => animView(a.name).base === 'idle');
    return [
      slider({ label: '§0922', min: 0, max: MAX_IDLE, value, format: v => (v ? tr('§0923', v) : 'never'),
        tip: '§0924', oninput: set, onchange: () => update() }),
      h('div', { class: 'section__hint', style: { margin: '8px 0 0' } }, has
        ? '§0925'
        : '§0926'),
    ];
  }

  function sideView() {
    const mc = multicolor(), pal = colors(), c = costume(), l = layer();

    // the pens and their colors: a row is the pen, its swatch sets the color
    const who = wearers();
    const key = v => ` · key ${penOrder().indexOf(v) + 1}`;
    const body = st.target === 'cursor' ? { tip: '§0903', onpick: k => setColor('cursor', k) }
      : l ? { tip: tr('§0904', l.name), onpick: setLayerColor }
        : { tip: who.length ? tr('§0905', who.map(a => a.name).join(', '))
          : '§0906',
          onpick: k => setWearerColor(who, k) };
    // a costume of more than one sprite: a color row per part (the pen draws in the part's color)
    const [pw, ph] = c && !l ? costumeSize(c) : [1, 1];
    const partLabel = k => {
      const col = k % pw, row = Math.floor(k / pw);
      if (pw === 1) return ph === 2 ? ['§0907', '§0908'][row] : tr('§0909', row + 1);
      if (ph === 1) return pw === 2 ? ['§0910', '§0911'][col] : tr('§0912', col + 1);
      return tr('§0913', row + 1, col + 1);
    };
    const shown = pw * ph > 1 ? partColors(c, bodyColor(), constMap(store.game)) : null;
    const colorRows = pw * ph > 1
      ? Array.from({ length: pw * ph }, (_, k) => ({
        label: partLabel(k), color: shown?.[k] ?? bodyColor(), active: st.pen === 2, onselect: () => setPen(2),
        tip: tr('§0914', c.colors?.[k] != null ? '' : ": not set, it shows the actor's color", key(2)),
        onpick: v => setPartColor(k, v),
      }))
      : [{ label: '§0637', color: pal[2], active: st.pen === 2, onselect: () => setPen(2), tip: body.tip + key(2), onpick: body.onpick }];
    const chooser = colorChooser([
      { label: '§0636', color: st.bg, active: st.pen === 0, onselect: () => setPen(0),
        tip: tr('§0974', key(0)), onpick: k => { st.bg = k; refresh(); update(); } },
      ...colorRows,
      { label: '§0650', color: pal[1], active: mc && st.pen === 1, disabled: !mc, onselect: () => setPen(1),
        tip: mc ? tr('§0915', key(1)) : '§0916',
        onpick: k => setColor('sprite1', k) },
      { label: '§0651', color: pal[3], active: mc && st.pen === 3, disabled: !mc, onselect: () => setPen(3),
        tip: mc ? tr('§0917', key(3)) : '§0918',
        onpick: k => setColor('sprite2', k) },
    ]);

    const playBtn = st.target === 'cursor' ? null : iconButton(st.playing ? 'pause' : 'play_arrow', '§0919', () => { st.playing = !st.playing; update(); });

    let about;
    if (c) {
      about = [
        field({ label: '§0920', value: c.name, mono: true, dense: true,
          onchange: (v, f) => {
            v = v.trim();
            if (v === c.name) return f.setError(null);
            if (!NAME_RE.test(v)) return f.setError('§0404');
            if (uniqueName(store.game, v, 'costume') !== v) return f.setError(tr('§0121', v));
            f.setError(null);
            const old = c.name;
            reference.rename(refKey(old), refKey(v));
            store.mutate(g => renameSymbol(g, old, v, 'costume'), { source: 'structure' });
          } }),
        h('div', { style: { marginTop: '22px' } },
          h('div', { class: 'sprite-color-label' }, '§0921'),
          sizePicker({ w: costumeSize(c)[0], h: costumeSize(c)[1], onchange: setSize }),
          h('div', { class: 'section__hint', style: { margin: '8px 0 0' } }, sizeHint(c))),
        h('div', { style: { marginTop: '22px' } }, field({ label: '§1107', value: st.frame, mono: true, dense: true,     // (not "name": Brave takes a label with it for a login field)
          support: '§0927',
          onchange: (v, f) => {
            v = v.trim();
            if (v === st.frame) return f.setError(null);
            const err = frameNameError(c, v);
            if (err) return f.setError(err);
            f.setError(null);
            renameFrameTo(st.frame, v);
          } })),
        h('div', { style: { marginTop: '14px' } }, checkbox('§0928', st.frame === defaultFrame(c), on => {
          if (!on) { snackbar('§0929'); render(); return; }
          const name = st.frame;
          change(x => x.frames.forEach(f => { if (f.name === name) f.default = true; else delete f.default; }));
        })),
        h('div', { class: 'section__hint', style: { margin: '12px 0' } },
          // two sentences, each a text of its own for the translation (h)
          animsWith(c, st.frame), ' ', who.length ? tr('§1125', who.map(a => a.name).join(', ')) : '§1126'),
      ];
    } else {
      const custom = frames().some(f => spriteNode(f));
      about = [
        h('div', { class: 'md-title-small', style: { margin: '0 0 8px' } }, tr('§1144', st.frame)),
        h('div', { class: 'section__hint', style: { margin: '0 0 12px' } },
          st.target === 'cursor' ? '§0931'
            : `Actors without a sprite wear it${who.length ? `: ${who.map(a => a.name).join(', ')}` : ''}.`,
          custom ? '' : ' Built-in: drawing on it adds it to the script.'),
        custom ? h('div', { class: 'inline-actions' }, button('§0932', { icon: 'restart_alt', onclick: resetBuiltIn })) : '',
      ];
    }

    return [
      rot.on && section('§1731', rot.actions(), rot.view()),
      // a sprite: its name field says what it is, no title above it
      c ? h('div', { class: 'section' }, about) : section(st.target === 'cursor' ? '§1100' : '§0933', null, ...about),
      c ? layersSection(c) : '',
      reference.panel(),
      section('§0864', null, chooser,
        h('div', { class: 'section__hint', style: { margin: '10px 0 0' } }, '§0934'),
        mc ? swapSection() : ''),
      section('§0509', playBtn, dom(ui.preview), dom(ui.previewCaption)),
      c ? animsSection(c) : '',
    ];
  }

  // --- render ----------------------------------------------------------------------------

  // --- grid panel: every sprite of the game, wrapping into as many rows as needed ------

  // --- marking a range with the mouse: press on a frame, drag over the others --------

  // drag: marks a range { entry, costume, to, moved }; alt+drag: moves frames
  // { mode: 'move', entry, costume, names, over, after }
  let drag = null;

  // the frames 'names' move before the frame 'before' (null: to the end); the layers
  // keep their frames in the costume's order, animations name frames and stay as they are
  function moveFrames(c, names, before) {
    change(x => {
      const moving = x.frames.filter(f => names.includes(f.name));
      const rest = x.frames.filter(f => !names.includes(f.name));
      const at = before == null ? rest.length : rest.findIndex(f => f.name === before);
      x.frames = [...rest.slice(0, at < 0 ? rest.length : at), ...moving, ...rest.slice(at < 0 ? rest.length : at)];
      const order = x.frames.map(f => f.name);
      x.layers.forEach(l => l.frames.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name)));
    });
  }

  // the current frame, or the marked range, one place to the left (-1) or right (1)
  function nudgeFrames(dir) {
    const c = costume();
    if (!c) return;
    const names = st.range?.target === c.id ? [...new Set(st.range.frames)] : [st.frame];
    const order = c.frames.map(f => f.name);
    const idx = names.map(n => order.indexOf(n)).sort((a, b) => a - b);
    if (dir < 0 && idx[0] > 0) moveFrames(c, names, order[idx[0] - 1]);
    else if (dir > 0 && idx.at(-1) < order.length - 1) moveFrames(c, names, order[idx.at(-1) + 2] ?? null);
  }

  function moveOver(entry, ev) {
    if (drag?.mode !== 'move' || entry.target !== drag.entry.target) return;
    const r = ev.currentTarget.getBoundingClientRect();
    drag.over = entry.frame;
    drag.after = ev.clientX > r.left + r.width / 2;
    for (const { el: cellEl, entry: x } of ui?.cells ?? []) {
      const over = x.target === drag.entry.target && x.frame === drag.over && !drag.names.includes(x.frame);
      cellEl.classList.toggle('asset-cell--drop-before', over && !drag.after);
      cellEl.classList.toggle('asset-cell--drop-after', over && drag.after);
    }
  }

  function startDrag(entry, shift, alt, toggle) {
    const c = store.node(entry.target);
    const costumeNode = c?.kind === 'costume' ? c : null;
    if (toggle && costumeNode) return toggleFrame(costumeNode, entry.frame);
    if (alt && costumeNode) {
      const names = st.range?.target === entry.target && st.range.frames.includes(entry.frame) ? [...new Set(st.range.frames)] : [entry.frame];
      drag = { mode: 'move', entry, costume: costumeNode, names, over: entry.frame, after: false };
      for (const { el: cellEl, entry: x } of ui?.cells ?? []) {
        cellEl.classList.toggle('asset-cell--moving', x.target === entry.target && names.includes(x.frame));
      }
      window.addEventListener('pointerup', endDrag, { once: true });
      return;
    }
    const anchor = shift && costumeNode && st.range?.target === entry.target ? st.range.anchor : entry.frame;
    drag = { entry: { ...entry, frame: anchor }, costume: costumeNode, to: entry.frame, moved: anchor !== entry.frame };
    markDrag();
    window.addEventListener('pointerup', endDrag, { once: true });
  }

  function extendDrag(entry) {
    if (!drag?.costume || drag.mode === 'move' || entry.target !== drag.entry.target || entry.frame === drag.to) return;
    drag.to = entry.frame;
    drag.moved = true;
    markDrag();
  }

  function markDrag() {
    const frames = drag.costume ? framesBetween(drag.costume, drag.entry.frame, drag.to) : [drag.entry.frame];
    for (const { el: cellEl, entry } of ui?.cells ?? []) {
      cellEl.classList.toggle('asset-cell--range', entry.target === drag.entry.target && frames.includes(entry.frame));
    }
  }

  function endDrag() {
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.mode === 'move') {
      const order = d.costume.frames.map(f => f.name);
      let before = d.after ? order[order.indexOf(d.over) + 1] ?? null : d.over;
      while (before && d.names.includes(before)) before = order[order.indexOf(before) + 1] ?? null;
      if (d.names.includes(d.over)) render();
      else moveFrames(d.costume, d.names, before);
      return;
    }
    const { target, frame } = d.entry;
    if (st.target !== target) { st.layer = ''; st.anim = null; st.hidden.clear(); }
    st.target = target;
    st.frame = d.moved ? frame : d.to;
    st.range = d.costume ? { target, anchor: frame, frames: d.moved ? framesBetween(d.costume, frame, d.to) : [frame], picked: d.moved } : null;
    normalize();
    render();
  }

  // ctrl+click: a frame joins the marked frames or leaves them; the marking keeps the costume's order
  function toggleFrame(c, frame) {
    const marked = new Set(st.range?.target === c.id ? st.range.frames : [st.frame]);
    const adding = !marked.has(frame);
    if (adding) marked.add(frame); else marked.delete(frame);
    const frames = c.frames.map(f => f.name).filter(n => marked.has(n));
    st.range = frames.length ? { target: c.id, anchor: frame, frames, picked: true } : null;
    if (adding) st.frame = frame;
    else if (frame === st.frame && frames.length) st.frame = frames.at(-1);
    normalize();
    render();
  }

  // the frames of a costume from the range anchor to a frame, in the costume's order
  function framesBetween(c, a, b) {
    const names = c.frames.map(f => f.name);
    const i = names.indexOf(a), j = names.indexOf(b);
    return i < 0 || j < 0 ? [b] : names.slice(Math.min(i, j), Math.max(i, j) + 1);
  }

  // the bar above the sprites: how many frames are marked; the frame tools of the
  // costume on the right. Animations are made and changed in the side panel.
  function gridBar() {
    const c = costume();
    const tools = c ? h('div', { class: 'inline-actions' },
      iconButton('chevron_left', '§0935', () => nudgeFrames(-1), 'md-icon-button--sm'),
      iconButton('chevron_right', '§0936', () => nudgeFrames(1), 'md-icon-button--sm'),
      iconButton('add', '§0937', () => newFrame(false), 'md-icon-button--sm'),
      iconButton('content_copy', '§0938', () => newFrame(true), 'md-icon-button--sm'),
      iconButton('edit', '§0939', renameFrame, 'md-icon-button--sm'),
      iconButton('delete', '§0940', deleteFrame, 'md-icon-button--sm')) : '';
    const marked = c && markedFrames(c);
    const left = h('div', { class: 'asset-grid__range' }, marked ? [
      icon('select_all'),
      h('span', { class: 'md-body-medium' }, tr('§1072', marked.length, marked.length > 1 ? 's' : '')),
      h('span', { class: 'md-body-small' }, '§0975'),
      iconButton('close', '§0663', () => { st.range = null; render(); }, 'md-icon-button--sm'),
    ] : h('span', { class: 'md-body-small' }, c
      ? '§0941'
      : '§0976'));
    return h('div', { class: 'asset-grid__bar' }, left, h('span', { style: { flex: '1' } }), tools);
  }

  // the frames of the selected sprite in one row that wraps. cells: filled with {cv, paint, el, entry} for drawGrid
  function gridPanel(cells) {
    const [mc1, mc2] = spriteColors(store.game);
    const spriteArt = name => spriteNode(name)?.lines ?? builtin(name);
    const spriteMc = name => !!spriteNode(name)?.multicolor;

    // the row: the cursor, the default costume or the frames of the selected costume
    const entries = [];
    const add = (target, frame, tag, tip, paint, sz = [1, 1]) => entries.push({ target, frame, tag, tip, paint, size: sz });
    const c = costume();
    if (st.target === 'cursor') {
      add('cursor', 'cursor', 'cursor', 'cursor',
        ctx => drawSprite(ctx, spriteArt('cursor'), spriteMc('cursor'), 0, 0, STRIP_SCALE, [gameColor('cursor', UI_DEFAULTS.cursor), mc1, mc2]));
    } else if (!c) {
      for (const f of ['stand', 'walk']) {
        add('default', f, 'default', `default sprite · ${f}`,
          ctx => drawSprite(ctx, spriteArt(f), spriteMc(f), 0, 0, STRIP_SCALE, [bodyColor(), mc1, mc2]));
      }
    } else {
      const [sw, sh] = costumeSize(c);            // big sprites are drawn smaller, the strip keeps its height
      for (const f of c.frames) {
        add(c.id, f.name, c.name, `sprite ${c.name} · ${f.name}`,
          ctx => drawCostumeFrame(ctx, store.game, c, f.name, 0, 0, STRIP_SCALE / sh, bodyColor()), [sw, sh]);
      }
    }
    const items = entries.map((e, i) => {
      const cv = dh('canvas', { width: Math.round(SPRITE_COLS * STRIP_SCALE * e.size[0] / e.size[1]), height: SPRITE_ROWS * STRIP_SCALE });
      const group = i > 0 && e.target !== entries[i - 1].target;
      const cellEl = dh('div', {
        class: `asset-cell${st.target === e.target && st.frame === e.frame ? ' asset-cell--selected' : ''}${group ? ' asset-cell--group' : ''}`,
      }, cv);
      cellEl.addEventListener('pointerdown', ev => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        startDrag(e, ev.shiftKey, ev.altKey, ev.ctrlKey || ev.metaKey);
      });
      cellEl.addEventListener('pointerenter', ev => { if (drag && ev.buttons & 1) extendDrag(e); });
      cellEl.addEventListener('pointermove', ev => { if (drag?.mode === 'move' && ev.buttons & 1) moveOver(e, ev); });
      cells.push({ cv, paint: e.paint, el: cellEl, entry: e });
      return cellEl;
    });
    return dh('div', { class: 'asset-grid__items' }, items);
  }

  // the marked frames, the frames of the opened animation and the frame it plays now
  function markGrid() {
    if (drag) return;
    const c = costume();
    const a = c && st.anim ? animPlays(c, c.anims.find(x => x.name === st.anim)).anim : null;
    const seq = animSequence(a);
    const playing = a && st.playing && seq.length ? seq[st.step % seq.length] : null;
    const marked = isMarked(st.range) ? st.range : null;
    for (const { el: cellEl, entry } of ui?.cells ?? []) {
      const mine = !!a && entry.target === c.id;
      cellEl.classList.toggle('asset-cell--range', !!marked && entry.target === marked.target && marked.frames.includes(entry.frame));
      cellEl.classList.toggle('asset-cell--anim', mine && a.frames.includes(entry.frame));
      cellEl.classList.toggle('asset-cell--playing', mine && entry.frame === playing);
    }
  }

  function drawGrid() {
    markGrid();
    for (const { cv, paint } of ui?.cells ?? []) {
      const ctx = cv.getContext('2d');
      ctx.fillStyle = PALETTE[st.bg];
      ctx.fillRect(0, 0, cv.width, cv.height);
      paint(ctx);
    }
  }

  // the canvas and the preview are made once and drawn on; the views show them (pui.dom)
  function islands() {
    if (ui) return;
    const canvas = dh('canvas', { class: 'screen-canvas sprite-canvas',
      onpointerdown: onDown, onpointermove: onMove, onpointerup: onUp, onpointercancel: onUp,
      onpointerleave: () => { st.hover = null; draw(); status(); },
      oncontextmenu: e => e.preventDefault() });
    const wrap = dh('div', { class: 'screen-canvas-wrap sprite-wrap', tabindex: 0, onkeydown: onKey }, canvas);
    wheelZoom(wrap, () => ui?.canvas, zoom);   // the wheel zooms
    reference.attach(wrap);
    ui = { canvas, wrap, preview: dh('canvas', { class: 'sprite-preview' }), previewCaption: dh('div', { class: 'md-body-small', style: { marginTop: '6px' } }),
      thumbs: [], cells: [], grid: null };
  }

  function barView() {
    if (!store.game) return null;
    const c = costume(), l = layer(), mc = multicolor();
    return h('div', { class: 'screen-bar' },
      h('span', { class: 'md-title-medium' }, 'Sprites'),
      h('span', { class: 'screen-bar__sep' }),
      select({ label: 'Sprite', hideLabel: true, value: st.target, dense: true, cls: 'screen-bar__sprite',
        // nerdsuite: the sprites of the project; the built-in one only while there is none
        options: S().costumes.length ? S().costumes.map(x => ({ value: x.id, label: x.name })) : [{ value: 'default', label: 'no sprite yet: + makes one' }],
        onchange: v => { st.target = v; st.frame = 'stand'; st.layer = ''; st.anim = null; st.hidden.clear(); normalize(); render(); ui?.wrap.focus({ preventScroll: true }); } }),
      iconButton('add', '§0942', addCostume),
      c && iconButton('delete', tr('§0930', c.name), () => actions.remove(c.id)),   // a sprite of the game; not the cursor or the default one
      h('span', { class: 'screen-bar__sep' }),
      defaultTools({
        undo: () => store.undo(), redo: () => store.redo(), zoom,
        grid: { on: st.grid, toggle: () => { st.grid = !st.grid; update(); draw(); } },
        multicolor: { on: mc, toggle: () => setMode(!mc) },
        clear: { tip: '§0945', run: () => apply('clear') },
      }),
      h('span', { class: 'screen-bar__sep' }),
      brushTools({ brush: st.brush, tool: st.tool, max: brushMax(brushGrid()), onchange: b => { st.brush = b; update(); draw(); } }),
      radiusTools({ radius: st.radius, tool: st.tool, max: radiusMax(brushGrid()), onchange: v => { st.radius = v; update(); draw(); } }),
      h('span', { class: 'screen-bar__sep' }),
      c ? select({ label: '§0943', hideLabel: true, value: st.layer, dense: true,
        options: [{ value: '', label: c.name }, ...frameLayers().map(x => ({ value: x.name, label: x.name }))],
        onchange: v => { st.layer = v; render(); } }) : '',
      h('span', { class: 'screen-bar__sep' }),
      frames().length > 1 ? iconButton('content_copy', tr('§0944', otherFrame()), copyOther) : '',
      h('div', { class: 'app-bar__spacer' }));
  }

  // what the view edits, as it is: the sprite file (the costume, or the cursor / default sprite
  // frame shown), its frames as raw C64 sprite blocks, and the frame shown as a PNG (transparent,
  // 4 screen pixels per C64 pixel) - what the Export button of the app bar offers here (app.js)
  function exportFormats() {
    if (!store.game) return [];
    const c = costume(), mc = multicolor(), [sw, sh] = size();
    const consts = Object.fromEntries(S().consts.map(x => [x.name, x.value]));
    const sprite = c ? null : { name: st.frame, lines: art(st.frame), multicolor: mc };
    const name = c ? exportName(c.file ?? sprPath(c.name), 'spr') : exportName(spriteNode(st.frame)?.file ?? spritePath(st.frame), 'spr');
    const blocks = () => {
      const all = (c ? c.frames.map(f => spriteBlocks(f.lines, !!c.multicolor, sw, sh)) : frames().map(f => spriteBlocks(art(f), mc)));
      const out = new Uint8Array(all.reduce((n, b) => n + b.length, 0));
      all.reduce((at, b) => { out.set(b, at); return at + b.length; }, 0);
      return out;
    };
    const count = c ? c.frames.length * sw * sh : frames().length;
    return [
      { label: '§1017', name, description: 'yopaca sprite', bytes: () => (c ? costumeToFile(c, consts) : spriteToFile(sprite)) },
      { label: tr('§1018', count), name: name.replace(/\.spr$/, '.bin'), description: 'C64 sprite data', bytes: blocks },
      { label: tr('§2005', st.frame), icon: 'wallpaper', name: name.replace(/\.spr$/, `_${st.frame}.png`), type: 'image/png', description: 'PNG picture',
        bytes: () => {
          const cv = pixelCanvas(SPRITE_COLS * sw, SPRITE_ROWS * sh, 4, () => {});
          paintSprite(cv, st.frame, 4);
          return pngOf(cv);
        } },
    ];
  }

  const StatusLine = () => h('span', { class: 'md-body-small screen-status' }, statusLine.value);

  function bodyView() {
    if (!store.game || !ui) return null;
    // the range tools, in the toolbox left of the canvas below the drawing tools
    const stretch = multicolor() ? '§1955' : '';
    const range = { keys: RANGE, run: op => apply(op),
      more: { rotl: stretch, rotr: stretch, invert: '§2004' } };
    return [
      h('div', { class: 'screen-body' },
        h('div', { class: 'screen-main' }, paintArea({ tools: toolsOf(st.target), current: st.tool, onselect: setTool, range }, dom(ui.wrap)), h('div', { class: 'screen-foot' }, h(StatusLine, {}))),
        sidePanel('Sprites', sideView())),
      h('div', { class: 'asset-grid' }, gridBar(), dom(ui.grid)),
    ];
  }

  function render() {
    if (store.game) {
      normalize();
      islands();
      ui.cells = [];
      ui.grid = gridPanel(ui.cells);            // the frames of the sprite: a new strip
    }
    const hadFocus = el.contains(document.activeElement);
    views ??= [mount(bar, barView), mount(el, bodyView)];
    update();
    if (!store.game) return;
    actions.route?.();            // the address follows what is open (app.js)
    draw();
    drawGrid();
    ui.grid.querySelector('.asset-cell--selected')?.scrollIntoView({ block: 'nearest' });
    status();
    animate();
    if (hadFocus) ui.wrap.focus({ preventScroll: true });
  }

  followCurve(() => ui, () => WAIT_TOOLS.has(st.tool) && waits(st.drag), onMove, onDown,
    () => { if (closePolygon(st.drag)) onUp(); });   // Enter: the polygon closes and draws

  store.on((type, detail) => {
    if (type === 'load') { st.target = S().costumes[0]?.id ?? 'default'; st.frame = 'stand'; st.layer = ''; st.anim = null; st.previewColor = null; st.hidden.clear(); st.range = null; }
    if (el.hidden) return;
    if (type === 'load') render();
    else if (type === 'change') {
      if (detail.source === 'sprites') { normalize(); refresh(); } else render();
    }
  });

  // what a reload keeps (uistate.js): the tools, the pens, the zoom, the layer drawn on
  const KEEP = ['tool', 'pen', 'cell', 'grid', 'brush', 'radius', 'bg', 'playing', 'layer'];
  keepUi('sprites', { save: () => pickUi(st, KEEP), load(s) { putUi(st, s, KEEP); if (!el.hidden) render(); } });

  return {
    exportFormats,
    importFormats,
    // the sprite open, for the address: 'cursor', 'default' or the name of a costume, and its frame
    current: () => ({ sprite: costume()?.name ?? st.target, frame: st.frame }),
    select(target, frame) {
      if (target) { st.target = target; st.layer = ''; st.anim = null; }
      if (frame) st.frame = frame;
    },
    open() {
      render();
      ui?.wrap.focus({ preventScroll: true });
    },
    render,
    copy, paste, cancel,
  };
}
