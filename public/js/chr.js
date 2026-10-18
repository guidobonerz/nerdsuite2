// chr.js - custom place charsets: 2048 byte files with 256 characters of 8x8 pixels
//
// Files are read from the project (project.js) into a cache keyed by their project path.
// The char editor changes the cached bytes, so the screen editor and the place
// previews draw the new characters at once; Save writes the file.

import { readBinary, writeBinary, hasFile, onProjectOpen } from './project.js';

export const CHARSET_SIZE = 2048;

const cache = new Map();          // project path -> Uint8Array
const state = new Map();          // project path -> 'loading' | 'ok' | 'missing' | 'error'
const sizes = new Map();          // project path -> size of the file in the project
const dirty = new Set();
const listeners = new Set();
let scriptDir = '';
let timer = 0;

export function normalize(path) {
  const out = [];
  for (const part of String(path).replace(/\\/g, '/').split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

// relative charset paths point next to the open script, like in the compiler
export function setScriptPath(path) {
  const p = normalize(path || '');
  scriptDir = p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
}
export const scriptDirectory = () => scriptDir;
export const charsetKey = file => normalize(scriptDir + file);

// project path -> path relative to a folder of the project (dir: '' or ending in '/')
export function relativePath(dir, key) {
  const from = dir.split('/').filter(Boolean), to = normalize(key).split('/');
  let k = 0;
  while (k < from.length && k < to.length - 1 && from[k] === to[k]) k++;
  return [...Array(from.length - k).fill('..'), ...to.slice(k)].join('/');
}
// project path -> path relative to the script (the place's 'charset' attribute)
export const scriptRelative = key => relativePath(scriptDir, key);

export function onCharsetChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// many changes while drawing, one notification
function notify() {
  clearTimeout(timer);
  timer = setTimeout(() => listeners.forEach(fn => fn()), 120);
}

// like the compiler: a PRG load address is skipped; short files are padded
export function normalizeCharset(bytes) {
  const data = bytes.length === CHARSET_SIZE + 2 ? bytes.subarray(2) : bytes;
  const out = new Uint8Array(CHARSET_SIZE);
  out.set(data.subarray(0, CHARSET_SIZE));
  return out;
}

async function load(key) {
  state.set(key, 'loading');
  try {
    if (!hasFile(key)) {
      state.set(key, 'missing');
    } else {
      const data = readBinary(key);
      cache.set(key, normalizeCharset(data));
      sizes.set(key, data.length);
      state.set(key, 'ok');
    }
  } catch {
    state.set(key, 'error');
  }
  notify();
}

// another project: its charsets are other files
onProjectOpen(() => {
  cache.clear();
  state.clear();
  sizes.clear();
  dirty.clear();
  notify();
});

// the bytes of a charset, or null while it loads or when the file is missing
export function charsetByKey(key) {
  if (!key) return null;
  if (!state.has(key) && typeof window !== 'undefined') load(key);
  return cache.get(key) ?? null;
}
export const charsetData = file => (file ? charsetByKey(charsetKey(file)) : null);
export const charsetState = key => state.get(key) ?? 'loading';
export const charsetFileSize = key => sizes.get(key) ?? null;

export function setCharsetBytes(key, data) {
  cache.set(key, data);
  state.set(key, 'ok');
  dirty.add(key);
  notify();
}
export const isCharsetDirty = key => dirty.has(key);
export const dirtyCharsets = () => [...dirty];

export async function saveCharset(key) {
  writeBinary(key, cache.get(key));
  dirty.delete(key);
  sizes.set(key, CHARSET_SIZE);
  notify();                                  // the char editor drops the mark of the changed file
}

// the charset is gone (its file left the project)
export function dropCharset(key) {
  cache.delete(key);
  state.delete(key);
  sizes.delete(key);
  dirty.delete(key);
  notify();
}

// forget unsaved changes and read the file again
export function reloadCharset(key) {
  cache.delete(key);
  state.delete(key);
  dirty.delete(key);
  return load(key);
}

// pixels of one character: hires 8 rows of 8 bits, multicolor 8 rows of 4 bit pairs
// (00 background, 01 $d022, 10 $d023, 11 the cell color)
export function glyphPixels(data, code, multicolor) {
  return Array.from({ length: 8 }, (_, r) => {
    const b = data[code * 8 + r];
    return multicolor ? [6, 4, 2, 0].map(sh => (b >> sh) & 3) : [7, 6, 5, 4, 3, 2, 1, 0].map(sh => (b >> sh) & 1);
  });
}

export function setGlyphPixels(data, code, grid, multicolor) {
  grid.forEach((row, r) => {
    data[code * 8 + r] = row.reduce((b, v, c) => b | (multicolor ? v << (6 - 2 * c) : v << (7 - c)), 0);
  });
}
