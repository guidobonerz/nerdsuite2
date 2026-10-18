// picture.js - the bitmap pictures of the project: Koala (multicolor) and Art Studio (hires)
// files, for the intro of a game (intro { picture "file.kla" }). Read from the project (project.js) into a
// cache keyed by their project path, like the charsets (chr.js); the bitmap editor tells the
// cache when it saves one.

import { charsetKey } from './chr.js';
import { readBinary, hasFile, listBinaries, onProjectOpen } from './project.js';

export const KOALA_SIZE = 2 + 8000 + 1000 + 1000 + 1;
export const ART_SIZE = 2 + 8000 + 1000 + 7;
export const PICTURE_RE = /\.(kla|koa|art)$/i;
export const pictureKey = charsetKey;                   // the project path of a picture named in the script

const cache = new Map();          // project path -> decoded picture
const state = new Map();          // project path -> 'loading' | 'ok' | 'missing' | 'error'
const listeners = new Set();
let files = null;                 // the pictures of the project, once listed
let timer = 0;

export function onPictureChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  clearTimeout(timer);
  timer = setTimeout(() => listeners.forEach(fn => fn()), 120);
}

// a Koala or Art Studio file: { mc, bg, bitmap, screen, color } (the load address dropped)
export function decodePicture(bytes) {
  if (bytes.length === KOALA_SIZE || bytes.length === ART_SIZE) bytes = bytes.subarray(2);
  const mc = bytes.length === KOALA_SIZE - 2;
  if (!mc && bytes.length !== ART_SIZE - 2) throw new Error(`${bytes.length} bytes: not a Koala (${KOALA_SIZE}) or Art Studio (${ART_SIZE}) picture`);
  return { mc, bg: mc ? bytes[10000] & 15 : 0, bitmap: bytes.subarray(0, 8000), screen: bytes.subarray(8000, 9000),
    color: mc ? bytes.subarray(9000, 10000) : null };
}

async function load(key) {
  state.set(key, 'loading');
  try {
    if (!hasFile(key)) {
      state.set(key, 'missing');
    } else {
      cache.set(key, decodePicture(readBinary(key)));
      state.set(key, 'ok');
    }
  } catch {
    state.set(key, 'error');
  }
  notify();
}

// another project: other pictures
onProjectOpen(() => {
  cache.clear();
  state.clear();
  files = null;
  notify();
});

// the picture named in the script (relative to it), or null while it loads or when the file is missing
export function pictureData(file) {
  if (!file) return null;
  const key = pictureKey(file);
  if (!state.has(key) && typeof window !== 'undefined') load(key);
  return cache.get(key) ?? null;
}
export const pictureState = file => (file ? state.get(pictureKey(file)) ?? 'loading' : 'ok');

// the bitmap editor wrote the file: read it again
export function reloadPicture(key) {
  cache.delete(key);
  state.delete(key);
  if (files && !files.includes(key)) files = [...files, key].sort();
  return load(key);
}

// the pictures of the project (project paths); onLoaded is called when the list arrives
export function pictureFiles(onLoaded) {
  files ??= listBinaries().filter(f => PICTURE_RE.test(f)).sort();
  return files;
}
