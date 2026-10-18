// trace.js - a reference image to trace: a PNG, JPG or GIF shown see-through over the canvas of
// the sprite editor or the bitmap editor (or behind the pixels of a sprite). It is drawn on with
// the usual tools onto the real layer; the image itself is never a part of the game.
//
// The images are files of the project in reference/, scaled down on import (at most 640 pixels on
// the long side) and stored as PNG, or JPG when a PNG is too large. reference/references.json
// holds where each one is placed, by key ('sprite:kid', 'bitmap:pictures/title.kla'):
//   { image: 'reference/sprite-kid.png', x, y, scale, opacity, front, shown }
// x and y in hires pixels of the canvas (multicolor pixels are two of them, so the image keeps
// its aspect in both modes), scale in hires pixels per pixel of the image. The server never gets
// these files (project.js bundle) and a change of the reference is no undo step.

import { h, iconButton, button, slider, segmented, field, snackbar, section, confirmRemove } from './pui.js';
import { hasFile, readBinary, readText, writeBinary, removeFile, onProjectOpen, REFERENCE_DIR, REFERENCE_EXT } from './project.js';
import { tr } from './i18n.js';

const INDEX = REFERENCE_DIR + 'references.json';
const MAX_SIDE = 640;                     // the long side of a stored image, in pixels
const MAX_PNG = 900 * 1024;               // larger: stored as JPG (a project file has at most 1 MB)
const ACCEPT = 'image/png,image/jpeg,image/gif,.png,.jpg,.jpeg,.gif';

let index = null;                         // key -> placement, read from INDEX when first asked
const images = new Map();                 // image path -> ImageBitmap | 'loading' | 'error'
const redraws = new Set();                // the editors' draw(): an image has been decoded
onProjectOpen(() => { index = null; images.clear(); });

function entries() {
  if (index) return index;
  try { index = hasFile(INDEX) ? JSON.parse(readText(INDEX)) : {}; } catch { index = {}; }
  if (!index || typeof index !== 'object' || Array.isArray(index)) index = {};
  return index;
}

function saveIndex() {
  const all = entries();
  if (Object.keys(all).length) writeBinary(INDEX, new TextEncoder().encode(JSON.stringify(all, null, 2) + '\n'), REFERENCE_EXT);
  else removeFile(INDEX);
}

// the decoded image of a path, null while it loads (the editors draw again when it is there)
function imageOf(path) {
  const got = images.get(path);
  if (got && typeof got === 'object') return got;
  if (!got) {
    images.set(path, 'loading');
    Promise.resolve().then(() => createImageBitmap(new Blob([readBinary(path)])))
      .then(bmp => { images.set(path, bmp); redraws.forEach(fn => fn()); })
      .catch(() => images.set(path, 'error'));
  }
  return null;
}

// an image no placement uses any more leaves the project
function dropImage(path) {
  if (!path || Object.values(entries()).some(r => r.image === path)) return;
  removeFile(path);
  images.delete(path);
}

const slug = key => key.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'reference';
const blobOf = (cv, type, quality) => new Promise((ok, fail) => cv.toBlob(b => (b ? ok(b) : fail(new Error('the image cannot be encoded'))), type, quality));

// the reference of one editor.
//   key():    what the reference belongs to ('sprite:kid'), null: nothing to trace on
//   area():   { w, h } the canvas in hires pixels
//   redraw(): draws the canvas again, rerender(): the side panel
//   behind:   the image can be put behind the pixels (sprites: their background is clear)
export function referenceLayer({ key, area, redraw, rerender, behind = true }) {
  redraws.add(redraw);
  let drag = null, space = false, wrapEl = null;

  const current = () => { const k = key(); return k ? entries()[k] ?? null : null; };
  const fitScale = (r, bmp) => { const a = area(); return Math.min(a.w / bmp.width, a.h / bmp.height); };
  const changed = (save = true) => { if (save) saveIndex(); redraw(); rerender(); };

  // the image over the canvas (front) or over its background (not front): cell is the size of a
  // hires pixel on the canvas
  function draw(ctx, cell, front) {
    const r = current();
    if (!r?.shown || (behind ? !!r.front : true) !== front) return;
    const bmp = imageOf(r.image);
    if (!bmp) return;
    ctx.save();
    ctx.globalAlpha = r.opacity;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, r.x * cell, r.y * cell, bmp.width * r.scale * cell, bmp.height * r.scale * cell);
    ctx.restore();
  }

  // a file of the computer as the reference: scaled down, stored, placed to fit the canvas
  async function importFile(file) {
    const k = key();
    if (!k || !file) return;
    if (!/^image\/(png|jpeg|gif)$/.test(file.type) && !/\.(png|jpe?g|gif)$/i.test(file.name)) {
      return snackbar(tr('§0726', file.name), { error: true });
    }
    try {
      const src = await createImageBitmap(file);
      const f = Math.min(1, MAX_SIDE / Math.max(src.width, src.height));
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(src.width * f));
      cv.height = Math.max(1, Math.round(src.height * f));
      const ctx = cv.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, 0, 0, cv.width, cv.height);
      let blob = await blobOf(cv, 'image/png'), ext = 'png';
      if (blob.size > MAX_PNG) { blob = await blobOf(cv, 'image/jpeg', 0.85); ext = 'jpg'; }
      const path = `${REFERENCE_DIR}${slug(k)}.${ext}`;
      const old = entries()[k];
      writeBinary(path, new Uint8Array(await blob.arrayBuffer()), REFERENCE_EXT);
      const bmp = await createImageBitmap(cv);
      images.set(path, bmp);
      const a = area(), scale = fitScale(null, bmp);
      entries()[k] = {
        image: path, x: Math.round((a.w - bmp.width * scale) / 2), y: Math.round((a.h - bmp.height * scale) / 2), scale,
        opacity: old?.opacity ?? 0.4, front: old?.front ?? !behind, shown: true,
      };
      if (old && old.image !== path) dropImage(old.image);
      changed();
      snackbar(tr('§0727', file.name));
    } catch (e) {
      snackbar(`${file.name}: ${e.message}`, { error: true, timeout: 8000 });
    }
  }

  async function remove() {
    const k = key(), r = current();
    if (!r) return;
    if (!(await confirmRemove({ what: tr('§1485', r.image.split('/').pop()), detail: '§1486', kind: 'reference', verb: 'remove', undo: false }))) return;
    if (current() !== r) return;
    delete entries()[k];
    dropImage(r.image);
    changed();
  }

  function set(props, save = true) {
    const r = current();
    if (!r) return;
    Object.assign(r, props);
    changed(save);
  }

  // a new size (hires pixels per image pixel) around the middle of the image
  function scaleTo(scale, save = true) {
    const r = current(), bmp = r && imageOf(r.image);
    if (!bmp) return;
    const cx = r.x + bmp.width * r.scale / 2, cy = r.y + bmp.height * r.scale / 2;
    set({ scale, x: Math.round(cx - bmp.width * scale / 2), y: Math.round(cy - bmp.height * scale / 2) }, save);
  }

  function fit(side) {
    const r = current(), bmp = r && imageOf(r.image);
    if (!bmp) return;
    const a = area(), scale = side === 'w' ? a.w / bmp.width : a.h / bmp.height;
    set({ scale, x: Math.round((a.w - bmp.width * scale) / 2), y: Math.round((a.h - bmp.height * scale) / 2) });
  }

  // a key that is renamed (a sprite, a picture saved under another path): copy keeps the old one
  function rename(from, to, { copy = false } = {}) {
    const all = entries();
    if (!all[from] || from === to) return;
    all[to] = { ...all[from] };
    if (!copy) delete all[from];
    saveIndex();
  }

  // --- Space+drag: moves the image, not the pixels --------------------------------------------

  const typing = t => t?.closest?.('input, textarea, select, [contenteditable]');
  const visible = () => wrapEl?.isConnected && wrapEl.offsetParent !== null;
  function onKeyDown(e) {
    if (e.key !== ' ' || typing(e.target) || !visible() || !current()) return;
    if (!space) { space = true; wrapEl.classList.add('trace-move'); }
    if (wrapEl.contains(e.target) || e.target === document.body) e.preventDefault();   // no scrolling, no button press
  }
  function onKeyUp(e) {
    if (e.key !== ' ') return;
    space = false;
    wrapEl?.classList.remove('trace-move');
  }
  addEventListener('keydown', onKeyDown, true);     // before the editors, which keep their keys to themselves
  addEventListener('keyup', onKeyUp, true);
  addEventListener('blur', () => onKeyUp({ key: ' ' }));

  // the canvas of the editor is in wrap: the capture phase of wrap comes before its handlers
  function attach(wrap) {
    if (wrapEl === wrap) return;
    wrapEl = wrap;
    wrap.addEventListener('pointerdown', e => {
      const r = current();
      if (!space || !r || e.button !== 0) return;
      e.stopPropagation(); e.preventDefault();
      try { wrap.setPointerCapture(e.pointerId); } catch { /* a pointer the page made up */ }
      const cv = wrap.querySelector('canvas');
      drag = { x: e.clientX, y: e.clientY, rx: r.x, ry: r.y, px: cv.getBoundingClientRect().width / area().w };
    }, true);
    wrap.addEventListener('pointermove', e => {
      if (!drag) return;
      e.stopPropagation();
      const r = current();
      if (!r) { drag = null; return; }
      const x = drag.rx + Math.round((e.clientX - drag.x) / drag.px), y = drag.ry + Math.round((e.clientY - drag.y) / drag.px);
      if (x !== r.x || y !== r.y) { r.x = x; r.y = y; redraw(); }
    }, true);
    const end = e => {
      if (!drag) return;
      e.stopPropagation();
      drag = null;
      changed();
    };
    wrap.addEventListener('pointerup', end, true);
    wrap.addEventListener('pointercancel', end, true);
  }

  // --- the side panel ---------------------------------------------------------------------------

  function panel() {
    if (!key()) return '';
    const r = current(), bmp = r && imageOf(r.image);
    const input = h('input', { type: 'file', accept: ACCEPT, class: 'trace-file', hidden: true,
      onchange: e => { const f = e.target.files?.[0]; e.target.value = ''; importFile(f); } });
    const pick = e => e.currentTarget.closest('.section').querySelector('.trace-file').click();
    if (!r) {
      return section('§0708', [input,
        h('div', { class: 'section__hint', style: { margin: '0 0 10px' } },
          '§0709'),
        h('div', { class: 'inline-actions' }, button('§0710', { icon: 'add_to_photos', onclick: pick }))]);
    }
    const fit0 = bmp ? fitScale(r, bmp) : r.scale;
    const size = Math.round(r.scale / fit0 * 100);
    const num = (label, prop) => field({ label, value: String(r[prop]), dense: true, mono: true, type: 'number', cls: 'trace-num',
      onchange: (v, f) => { const n = Math.round(Number(v)); if (!Number.isFinite(n)) return f.setError('§0725'); f.setError(null); set({ [prop]: n }); } });
    return section('§0708', [input,
      h('div', { class: 'trace-row' },
        button('§0711', { icon: 'add_to_photos', onclick: pick }),
        button('§0712', { icon: 'delete', onclick: remove })),
      slider({ label: '§0713', min: 10, max: 100, step: 5, value: Math.round(r.opacity * 100), format: v => tr('§0715', v),
        oninput: v => set({ opacity: v / 100 }, false), onchange: v => set({ opacity: v / 100 }) }),
      slider({ label: '§0714', min: 10, max: 400, step: 5, value: Math.min(400, Math.max(10, size)), format: () => tr('§0715', size),
        tip: '§0716',
        oninput: v => scaleTo(fit0 * v / 100, false), onchange: v => scaleTo(fit0 * v / 100) }),
      h('div', { class: 'trace-row' },
        button('§0717', { icon: 'width', onclick: () => fit('w') }),
        button('§0718', { icon: 'height', onclick: () => fit('h') })),
      h('div', { class: 'trace-row' }, num('X', 'x'), num('Y', 'y')),
      behind ? h('div', { class: 'trace-row' }, segmented([
        { value: 'behind', label: '§0794', tip: '§0720' },
        { value: 'front', label: '§0719', tip: '§0721' }],
      r.front ? 'front' : 'behind', v => set({ front: v === 'front' }))) : '',
      h('div', { class: 'section__hint', style: { margin: '10px 0 0' } },
        '§0722')],
    iconButton(r.shown ? 'visibility' : 'visibility_off', r.shown ? '§0723' : '§0724',
      () => set({ shown: !r.shown }), 'md-icon-button--sm'));
  }

  return { draw, panel, attach, rename, importFile, current };
}
