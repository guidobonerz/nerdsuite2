// export.js - the Export button of the app bar (app.js): a menu of the formats of what the view
// shows - the sprite, the charset, the place, the picture, the song, the build of the game - each
// saved as one file through the system's Save As dialog where the browser has one, else
// downloaded (project.js: saveFileAs). What is exported is what the view shows, unsaved edits
// included; the project is not touched.
import { openMenu, snackbar } from './pui.js';
import { saveFileAs } from './project.js';
import { tr } from './i18n.js';

// formats: [{ label, icon, name, type, description, bytes: () => Uint8Array | Blob | Promise,
// done: called when it was saved }] (null entries are left out); { divider: true } between groups
export function openExportMenu(anchor, formats, title = 'Export') {
  openMenu(anchor, [{ header: title }, ...formats.filter(Boolean).map(f => (f.divider ? f : {
    label: f.label, icon: f.icon ?? 'download',
    onclick: () => exportFile(f),
  }))]);
}

async function exportFile(f) {
  try {
    const bytes = await f.bytes();
    if (await saveFileAs(f.name, bytes, f.type ?? 'application/octet-stream', tr(f.description ?? f.label))) {
      snackbar(tr('§0986', f.name));
      f.done?.();
    }
  } catch (e) {
    snackbar(tr('§0987', e.message));
  }
}

// The Import button next to it: a menu of what the view can take from a file of the computer.
// formats: [{ label, icon, accept: '.kla,.koa', open: (bytes, name) => ... }] - open reads the
// file into the view (a new picture, a new sprite ...) and throws when it cannot
export function openImportMenu(anchor, formats, title = 'Import') {
  openMenu(anchor, [{ header: title }, ...formats.filter(Boolean).map(f => (f.divider ? f : {
    label: f.label, icon: f.icon ?? 'upload_file',
    onclick: () => importFile(f),
  }))]);
}

function importFile(f) {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: f.accept ?? '' });
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try { await f.open(new Uint8Array(await file.arrayBuffer()), file.name); }
    catch (e) { snackbar(tr('§0324', file.name, e.message), { error: true, timeout: 8000 }); }
  };
  input.click();
}

// a file name without its folder and extension, as a name of the script: letters, digits and _
export function importName(file, fallback = 'imported') {
  const base = String(file).split(/[\\/]/).pop().replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return !base ? fallback : /^[0-9]/.test(base) ? `${fallback}_${base}` : base;
}

// a C64 file may start with its load address: bytes without it when the length says so
// (unit: the size of one record, e.g. 8 for chars, 64 for sprites)
export const withoutLoadAddress = (bytes, unit) => (bytes.length % unit === 2 ? bytes.subarray(2) : bytes);

// a canvas as PNG bytes
export const pngOf = canvas => new Promise((resolve, reject) =>
  canvas.toBlob(b => (b ? resolve(b) : reject(new Error('the picture could not be made'))), 'image/png'));

// a canvas of w x h C64 pixels at scale s, drawn by draw(ctx)
export function pixelCanvas(w, h, s, draw) {
  const cv = document.createElement('canvas');
  cv.width = w * s;
  cv.height = h * s;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  draw(ctx);
  return cv;
}

// a file name from a project path or a name, with its extension
export function exportName(pathOrName, ext) {
  const base = String(pathOrName ?? 'export').split('/').pop().replace(/\.[^.]*$/, '') || 'export';
  return `${base}.${ext}`;
}
