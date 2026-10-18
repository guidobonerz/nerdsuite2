// project.js - the project: the .adv scripts and their files (graphics, charsets, pictures, songs),
// held in the browser. It comes from a zip package the user opens and goes back into one the user
// saves (zip.js); the editor has no access to the files of the computer, and the server keeps none.
//
// The project lives as long as the tab: its files are kept in IndexedDB under the id of the
// session (sessionStorage), so a reload finds them again, and a closed tab leaves them behind for
// the cleanup at the next start. Paths are relative to the root of the package: "demo.adv",
// "gfx/demo/hall.gfx".

import { readZip, writeZip } from './zip.js';
import { MANIFEST, PROJECT_FORMAT, readManifest, makeManifest, migrateProject } from './migrate.js';

// the text files: the sources of the code editor (assembler, BASIC, includes, C for the compiler of a
// toolchain), the project settings and the hidden model of the graphics (assets.adv, see assets.js)
export const SOURCE_EXT = ['.asm', '.a', '.s', '.inc', '.bas', '.c', '.h', '.txt', '.cfg'];
export const SCRIPT_EXT = ['.adv', '.json', ...SOURCE_EXT];
// the charsets, the pictures of the bitmap editor, the songs of the sound editor, the graphics files of the scripts
// (.gfx: a screen of a project before format 2, which the importer renames to .scr - migrate.js)
export const BINARY_EXT = ['.chr', '.bin', '.raw', '.kla', '.koa', '.art', '.sng', '.scr', '.gfx', '.spr', '.til', '.prg', '.sid', '.dat', '.map', '.col',
  '.nes', '.sfc', '.smc', '.a26', '.xex', '.rom'];
// the reference images the sprite and bitmap editors trace (trace.js) and their placement: in the
// folder reference/ only, saved with the project but never sent to the server - not a part of the game
export const REFERENCE_DIR = 'reference/';
export const REFERENCE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.json'];
export const isReference = p => p.startsWith(REFERENCE_DIR) && REFERENCE_EXT.includes(extOf(p));
const MAX_FILE = 1 << 20;                 // one file: 1 MB (a picture is 10 KB, a disk image not a project file)
const MAX_TOTAL = 16 << 20;
const MAX_FILES = 2000;

let files = new Map();                    // path -> Uint8Array
let name = null;                          // the name of the package, null: no project
let dirty = false;                        // changes that are not in a saved zip yet
const listeners = new Set();
const openers = new Set();               // told when another project replaces this one

const enc = new TextEncoder(), dec = new TextDecoder();

export const projectName = () => name;
export const isOpen = () => name !== null;
export const isProjectDirty = () => dirty;
export function onProjectChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const notify = () => listeners.forEach(fn => fn());
// fn is called when another project is opened (or none): the caches of its files are old then
export function onProjectOpen(fn) { openers.add(fn); return () => openers.delete(fn); }

// --- paths -----------------------------------------------------------------------------------

const extOf = p => (/\.[^./]*$/.exec(p)?.[0] ?? '').toLowerCase();

// a path of the project, or an error: relative, no '..', a known file type
export function checkPath(p, exts = [...SCRIPT_EXT, ...BINARY_EXT]) {
  const path = String(p ?? '').replace(/\\/g, '/');
  if (!path || path.startsWith('/') || /^[a-z]:/i.test(path) || path.split('/').some(s => s === '..' || s === '.' || s === '')) {
    throw Object.assign(new Error(`'${p}' is not a path in the project`), { status: 400 });
  }
  if (!exts.includes(extOf(path))) throw Object.assign(new Error(`'${p}': not a ${exts.join(', ')} file`), { status: 400 });
  return path;
}

// a path written in the script at `script`, as a path of the project
export function projectPath(script, rel) {
  const parts = script.split('/').slice(0, -1);
  for (const p of rel.split('/')) {
    if (p === '..') parts.pop();
    else if (p && p !== '.') parts.push(p);
  }
  return parts.join('/');
}

// --- files -----------------------------------------------------------------------------------

const missing = path => Object.assign(new Error(`${path} is not in the project`), { status: 404 });

export const hasFile = path => files.has(path);
export const allFiles = () => [...files.keys()].sort();

export function readBinary(path) {
  const data = files.get(path);
  if (!data) throw missing(path);
  return data;
}
export const readText = path => dec.decode(readBinary(path)).replace(/\r\n?/g, '\n');

export function writeBinary(path, data, exts = BINARY_EXT) {
  path = checkPath(path, exts);
  if (exts === REFERENCE_EXT && !isReference(path)) throw Object.assign(new Error(`${path}: a reference is in ${REFERENCE_DIR}`), { status: 400 });
  if (data.length > MAX_FILE) throw Object.assign(new Error(`${path} is too large`), { status: 413 });
  files.set(path, new Uint8Array(data));
  changed();
  return path;
}
export const writeText = (path, text) => writeBinary(path, enc.encode(text), SCRIPT_EXT);

export function removeFile(path) {
  if (files.delete(path)) changed();
}

// the binary files of the project; the script of its game (a project holds one game)
export const listBinaries = () => allFiles().filter(f => BINARY_EXT.includes(extOf(f)));
export const listSources = () => allFiles().filter(f => SOURCE_EXT.includes(extOf(f)));
export const isSource = p => SOURCE_EXT.includes(extOf(p));

// --- the package -----------------------------------------------------------------------------

// the entries of a package without the folders of the system (__MACOSX, dot files) and without
// the folder everything is in, when the package was zipped as one folder
function packageEntries(entries) {
  let list = [...entries].filter(([p]) => !p.split('/').some(s => s.startsWith('.') || s === '__MACOSX'));
  const tops = new Set(list.map(([p]) => (p.includes('/') ? p.split('/')[0] : '')));
  if (tops.size === 1 && !tops.has('')) {
    const cut = [...tops][0].length + 1;
    list = list.map(([p, d]) => [p.slice(cut), d]);
  }
  return list;
}

// the manifest of a package (migrate.js): { format, editor } - format 0 without one
export const packageManifest = entries => readManifest(packageEntries(entries).find(([p]) => p === MANIFEST)?.[1] ?? null);

// the files of a package as project files: no folders of the system, no build/, no manifest
export function projectFiles(entries) {
  const list = packageEntries(entries);
  const out = new Map();
  for (const [p, d] of list) {
    if (isReference(p)) { out.set(checkPath(p, REFERENCE_EXT), d); continue; }
    if (p.split('/')[0] === 'build' || ![...SCRIPT_EXT, ...BINARY_EXT].includes(extOf(p))) continue;   // other files stay out
    out.set(checkPath(p), d);
  }
  if (out.size > MAX_FILES) throw new Error(`too many files (${out.size}, at most ${MAX_FILES})`);
  return out;
}

// a project from files (Map path -> bytes): a new one, an example, a package
export function setProject(newName, newFiles, { isDirty = false } = {}) {
  name = newName;
  files = new Map(newFiles);
  dirty = isDirty;
  build = null;
  openers.forEach(fn => fn());
  flushSession();                        // at once: a reload right after it finds the project
  notify();
}

export function closeProject() {
  name = null;
  files = new Map();
  dirty = false;
  build = null;
  openers.forEach(fn => fn());
  flushSession();                        // at once: a reload right after it finds none
  notify();
}

// a project package the user opened (the bytes of the file, its name): NAME.yop, a zip package -
// or NAME.zip, as the editor saved projects before. A package of an older format or with files of
// older versions is brought to the newest (migrate.js, the importer) and is not exported then:
// { notes, from, editor } - what changed, the format it had, the editor that saved it. A package
// of a newer editor is refused (an error)
export async function openZip(bytes, fileName) {
  const entries = await readZip(bytes, { files: MAX_FILES * 2, bytes: MAX_TOTAL, file: MAX_FILE });
  const manifest = packageManifest(entries);
  // a plain zip without a manifest is taken as it is (no layout of an older yopaca to move)
  const r = manifest.format ? migrateProject(projectFiles(entries), manifest) : { files: projectFiles(entries), notes: [], from: PROJECT_FORMAT };
  setProject(String(fileName).replace(/\.(nsp|zip)$/i, '') || 'project', r.files, { isDirty: r.notes.length > 0 });
  return { notes: r.notes, from: r.from, editor: manifest.editor };
}

// the version of the editor that saves the packages (the header bar's, from the server): in the manifest
let editorVersion = null;
export function setEditorVersion(v) { editorVersion = v ?? null; }

// the package of the project: every file, deflated, and the manifest - the project format and
// the versions of its files (migrate.js)
export const zipBytes = () => {
  const list = new Map(allFiles().map(p => [p, files.get(p)]));
  return writeZip(new Map([[MANIFEST, makeManifest(list, editorVersion)], ...list]));
};

// the project as a download "NAME.yop" - the browser asks where, when it is set to
export async function saveZip() {
  download(zipName(), await zipBytes());
  markZipSaved();
}
// the suffix of a project package: a zip of one game, its scripts and their files
export const PROJECT_EXT = '.nsp';
export const zipName = () => `${name || 'project'}${PROJECT_EXT}`;

// the files as they are now are in a zip package the user saved (the Export of the app bar)
export function markZipSaved() {
  dirty = false;
  store();
  notify();
}

// one file out of the editor (export.js): the system's Save As dialog where the browser has one
// (showSaveFilePicker: Chrome, Edge - for this one file only, no handle is kept), else a download.
// bytes: a Uint8Array or a Blob. false: the dialog was cancelled
export async function saveFileAs(fileName, bytes, type = 'application/octet-stream', description = 'File') {
  if (typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function') {
    const dot = fileName.lastIndexOf('.');
    let handle = null;
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: fileName,
        ...(dot > 0 ? { types: [{ description, accept: { [type]: [fileName.slice(dot)] } }] } : {}),
      });
    } catch (e) {
      if (e.name === 'AbortError') return false;
      handle = null;                        // no dialog here (a frame, a policy): a download then
    }
    if (handle) {
      const out = await handle.createWritable();
      await out.write(bytes instanceof Blob ? bytes : new Blob([bytes], { type }));
      await out.close();
      return true;
    }
  }
  download(fileName, bytes, type);
  return true;
}

export function download(fileName, bytes, type = 'application/zip') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: fileName });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// --- the last build: what the server built (script.prg, game.prg, the disk images, the cartridge) -
// in memory only: not a file of the project, not in its package; a download of its own

let build = null;                          // { name, files: Map name -> Uint8Array }

export function setBuild(gameName, outputs) {
  build = outputs ? { name: gameName, files: new Map(Object.entries(outputs).map(([n, d]) => [n, typeof d === 'string' ? fromBase64(d) : d])) } : null;
  notify();
}
export const hasBuild = () => !!build?.files.size;
export const buildName = () => build?.name ?? null;
export const buildFiles = () => build?.files ?? new Map();

// the build as a download "NAME-build.zip": every media in one package
export async function downloadBuild() {
  if (!hasBuild()) throw new Error('build the game first');
  download(`${build.name}-build.zip`, await writeZip(build.files));
}

// --- base64, for the requests to the server --------------------------------------------------

export function toBase64(data) {
  let bin = '';
  for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(bin);
}
export const fromBase64 = s => Uint8Array.from(atob(s), ch => ch.charCodeAt(0));

// every file of the project as { path: base64 }: what the server builds from (not the reference images).
// over: graphics files of the script as the editor has them, not saved yet (Map path relative to script -> bytes)
export function bundle(script = null, over = null) {
  const out = Object.fromEntries(allFiles().filter(p => !isReference(p)).map(p => [p, toBase64(files.get(p))]));
  for (const [rel, data] of over ?? []) out[projectPath(script, rel)] = toBase64(data);
  return out;
}

// --- the session -----------------------------------------------------------------------------

const DB = 'nerdsuite', STORE = 'sessions', KEEP = 7 * 24 * 3600 * 1000, LOCK = 'nerdsuite-session:';
let sessionId = null;
let newTab = false;                        // this start is the first of the tab, not a reload of it
let db = null;
let saveTimer = null;

function openDb() {
  if (db || typeof indexedDB === 'undefined') return db;
  db = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return db;
}

async function tx(mode, fn) {
  const d = await openDb();
  if (!d) return null;
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r?.result ?? null);
    t.onerror = () => reject(t.error);
  });
}

function changed() {
  dirty = true;
  store();
  notify();
}

// the project into the session, a moment after the last change
function store() {
  if (!sessionId) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSession, 300);
}

// the project into the session now (before the page is left)
export function flushSession() {
  clearTimeout(saveTimer);
  if (!sessionId) return Promise.resolve();
  // whether a project is open, for index.html: it hides the rail before the first paint
  try { if (name === null) sessionStorage.removeItem('nerdsuite-open'); else sessionStorage.setItem('nerdsuite-open', '1'); } catch { /* no storage */ }
  const value = name === null ? null : { name, dirty, time: Date.now(), format: PROJECT_FORMAT, files: [...files] };
  return tx('readwrite', s => (value ? s.put(value, sessionId) : s.delete(sessionId)))
    .catch(e => console.warn('the project could not be kept in the session:', e));
}
if (typeof addEventListener === 'function') addEventListener('pagehide', () => { flushSession(); });

// the projects of tabs that were closed with changes not exported to a zip package (the browser
// lets no page ask before a tab closes but its own "Leave site?"): [{ id, name, time, files }],
// the newest first. Only at the first start of a new tab - a reload, as after Close project, is
// the same tab going on, whose user has decided. Without the Web Locks API an open tab cannot be
// told from a closed one: none. all: whatever the start (tools/uicheck.mjs)
export async function closedProjects({ all = false } = {}) {
  if (!sessionId || !navigator.locks?.query || !(newTab || all)) return [];
  try {
    const held = new Set(((await navigator.locks.query()).held ?? []).map(l => l.name));
    const out = [];
    await tx('readonly', s => {
      const req = s.openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        if (c.key !== sessionId && c.value?.dirty && !held.has(LOCK + c.key)) {
          out.push({ id: c.key, name: c.value.name, time: c.value.time, files: c.value.files.length });
        }
        c.continue();
      };
    });
    return out.sort((a, b) => b.time - a.time);
  } catch (e) {
    console.warn('the sessions could not be read:', e);
    return [];
  }
}

// the project of a closed tab into this one (not exported: dirty), and out of the closed ones
export async function recoverProject(id) {
  const saved = await tx('readonly', s => s.get(id));
  if (!saved) throw new Error('the project is gone');
  const r = migrateSession(saved);
  setProject(saved.name, r.files, { isDirty: true });
  await discardProject(id);
  return r.notes;
}

// a project kept in the session by an editor of an older format (or none: format 0) brought to
// the newest, like a package of it (migrate.js): { files, notes }
function migrateSession(saved) {
  const r = migrateProject(new Map(saved.files), { format: saved.format ?? 0 });
  // the manifest step of format 0 is about packages: a session needs no note for it
  return { files: r.files, notes: r.notes.filter(([label]) => label !== '§1510') };
}

// what the restore of this tab's project changed (migrate.js notes), for the editor to show once
export let restoredNotes = [];
export const discardProject = id => tx('readwrite', s => s.delete(id));

// the project of this tab after a reload, or null; the projects of closed tabs are removed
export async function restoreSession() {
  try {
    sessionId = sessionStorage.getItem('nerdsuite-session');
    if (!sessionId) {
      newTab = true;
      sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem('nerdsuite-session', sessionId);
    }
  } catch {
    sessionId = null;                      // no storage: the project lives in the page only
    return null;
  }
  // held while the tab is open: a session whose lock is free belongs to a closed tab (closedProjects)
  navigator.locks?.request(LOCK + sessionId, () => new Promise(() => {})).catch(() => {});
  try {
    const now = Date.now();
    await tx('readwrite', s => {
      const req = s.openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        if (c.key !== sessionId && !(now - (c.value?.time ?? 0) < KEEP)) c.delete();
        c.continue();
      };
    });
    const saved = await tx('readonly', s => s.get(sessionId));
    if (!saved) return null;
    const r = migrateSession(saved);
    name = saved.name;
    files = r.files;
    dirty = saved.dirty || r.notes.length > 0;
    restoredNotes = r.notes;
    notify();
    return name;
  } catch (e) {
    console.warn('the session could not be read:', e);
    return null;
  }
}
