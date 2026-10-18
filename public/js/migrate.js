// migrate.js - the versions of a project and of its files, and the way from an older one to the
// newest. The editor (project.js), the importer of older packages and tools/yop-migrate.mjs use it.
//
// The project: a package NAME.yop (a zip) holds MANIFEST, yopaca.json -
//   { "format": PROJECT_FORMAT, "editor": "v1.4.3", "saved": "2026-10-07T...", "files": { "gfx/demo/hall.gfx": "YSCR 2", ... } }
// format: the structure of the package - which files, where, how they go together. A package
// without it (a NAME.zip of before, or a .yop of the first days) is format 0.
//
// The files: the binary files of a game carry their own version - 4 bytes of magic, then the
// version byte: .gfx YSCR, .spr YSPR, .til YTIL, .sng YSNG (the songs of the Composer). The
// editor and the compiler read every version from `oldest` to `newest` as it is, and write the
// lowest version that holds what a file has (an older editor still reads it). A file of a newer
// version than this editor reads is refused - so is a package of a newer format. Next to the
// version, a file says which editor wrote it: its git tag in a trailer at the end (filetag.js),
// which the readers of every version skip - it says who, the version decides.
//
// When a structure changes:
//  - a new version of a file that the readers read besides the old ones (an addition at its end,
//    a flag): raise `newest` in FORMATS, the readers of the editor (gfxfile.js, tileset.js, song.js)
//    and of the compiler (advc/adv/gfx.go, sound.go). No migration.
//  - a version the readers drop: raise `oldest` and add a step to FILE_MIGRATIONS that turns a
//    file of the dropped version into the next one - the steps run one after the other, so a file
//    of any older version arrives at `oldest`.
//  - a change of the package (files moved, renamed, joined, split): raise PROJECT_FORMAT and add a
//    step to PROJECT_MIGRATIONS from the format before.
// Every step returns notes (labels, i18n.js) that the importer shows: what it changed.

import { readTag, withTag } from './filetag.js';
import { relayout } from './layout.js';
import { bracketLists } from './adv.js';

// 1: the manifest; 2: the layout of layout.js - every script at the top level, gfx/screen,
// gfx/sprite, gfx/charset, gfx/tiles, gfx/bitmap, audio/music, audio/effects; 3: the lists of the
// scripts in brackets - frames [A, B], layers [A, B], strength [A], needs [A] (adv.js, bracketLists);
// 4: the letter writer pauses with {hold N} as the scroller, not {wait N} (holdTags); 5: the intro
// pauses with {pause N} when the letter after it has reached the left side - no {pauseleft N} (pauseTags)
export const PROJECT_FORMAT = 5;
export const MANIFEST = 'nerdsuite.manifest.json';

// the binary files with a version, by their magic: the versions the readers read as they are
export const FORMATS = {
  YSCR: { ext: '.scr', kind: 'screen', oldest: 1, newest: 2 },
  YSPR: { ext: '.spr', kind: 'sprites', oldest: 1, newest: 1 },
  YTIL: { ext: '.til', kind: 'tileset', oldest: 1, newest: 2 },
  YSNG: { ext: '.sng', kind: 'song', oldest: 1, newest: 5 },
};

// magic -> [{ from, to, run(bytes) -> bytes }]: a file of version `from` becomes one of `to`
// (from + 1). None yet: every version ever written is still read as it is
export const FILE_MIGRATIONS = { YSCR: [], YSPR: [], YTIL: [], YSNG: [] };

// [{ from, to, note, run(files) -> files }]: a package of format `from` becomes one of `to`
export const PROJECT_MIGRATIONS = [
  // format 0: no manifest - the package gets one when it is saved; the files stay as they are
  { from: 0, to: 1, note: '§1510', run: files => files },
  // format 1: the files where the editor and the user put them - into the layout (layout.js), every
  // path in the scripts and the charset of a tileset along with them
  { from: 1, to: 2, note: '§1513', run: files => {
    const r = relayout(files);
    return { files: r.files, values: [r.moved.length] };
  } },
  // format 2: lists without brackets (frames A, B) - the scripts take only frames [A, B] now
  { from: 2, to: 3, note: '§1582', run: files => {
    const out = new Map(files);
    let changed = 0;
    for (const [path, bytes] of files) {
      if (!/\.adv$/i.test(path)) continue;
      const text = new TextDecoder().decode(bytes), done = bracketLists(text);
      if (done !== text) { out.set(path, new TextEncoder().encode(done)); changed++; }
    }
    return { files: out, values: [changed] };
  } },
  // format 3: the letter writer paused with {wait 2} - it takes {hold 2} now, as the scroller
  { from: 3, to: 4, note: '§1673', run: files => {
    const out = new Map(files);
    let changed = 0;
    for (const [path, bytes] of files) {
      if (!/\.adv$/i.test(path)) continue;
      const text = new TextDecoder().decode(bytes), done = holdTags(text);
      if (done !== text) { out.set(path, new TextEncoder().encode(done)); changed++; }
    }
    return { files: out, values: [changed] };
  } },
  // format 4: the intro had {pause N} (when the letter before has come in on the right) and
  // {pauseleft N} (when the letter after has reached the left side) - {pause N} is the second now
  { from: 4, to: 5, note: '§1674', run: files => {
    const out = new Map(files);
    let changed = 0;
    for (const [path, bytes] of files) {
      if (!/\.adv$/i.test(path)) continue;
      const text = new TextDecoder().decode(bytes), done = pauseTags(text);
      if (done !== text) { out.set(path, new TextEncoder().encode(done)); changed++; }
    }
    return { files: out, values: [changed] };
  } },
];

// the texts of a script ("""...""" and "..."), where the tags are, changed by fn - not the
// statements of a block, start { wait 10 }
const inTexts = (text, fn) => text.replace(/"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"/g, fn);

// {wait 2} of a letter writer as {hold 2} (format 4)
export const holdTags = text => inTexts(text, s => s.replace(/\{wait(?=[\s}])/gi, '{hold'));

// {pauseleft 2} of the intro as {pause 2} (format 5)
export const pauseTags = text => inTexts(text, s => s.replace(/\{pauseleft(?=[\s}])/gi, '{pause'));

// the magic, the version and the tag of the editor that wrote it (filetag.js; null: none) of a
// binary file of a game, or null (a charset, a picture, a script)
export function fileVersion(bytes) {
  if (!bytes || bytes.length < 5) return null;
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  return FORMATS[magic] ? { magic, version: bytes[4], tag: readTag(bytes).tag } : null;
}
// 'YSNG 4 v1.4.3': the magic, the version and the tag of a file
const described = v => [v.magic, v.version, v.tag].filter(x => x != null).join(' ');

// the manifest of a package (a Map path -> bytes of what it holds, or null): { format, editor }
export function readManifest(bytes) {
  if (!bytes) return { format: 0, editor: null };
  let m;
  try { m = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error(`${MANIFEST} is damaged`); }
  if (!Number.isInteger(m?.format) || m.format < 0) throw new Error(`${MANIFEST} has no project format`);
  return { format: m.format, editor: typeof m.editor === 'string' ? m.editor : null };
}

// the manifest of the files as they are now (path -> bytes), saved by `editor`
export function makeManifest(files, editor = null) {
  const versions = {};
  for (const [p, d] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const v = fileVersion(d);
    if (v) versions[p] = described(v);
  }
  return new TextEncoder().encode(`${JSON.stringify({ format: PROJECT_FORMAT, editor, saved: new Date().toISOString(), files: versions }, null, 1)}\n`);
}

// the files of a project brought to the versions this editor reads: { files, notes } - notes are
// [label, ...values] of what changed. Throws when a file is newer than this editor reads, or older
// than any step leads from
export function migrateFiles(files, { formats = FORMATS, steps = FILE_MIGRATIONS } = {}) {
  const out = new Map(files), notes = [], newer = [];
  for (const [p, d] of files) {
    const v = fileVersion(d);
    if (!v) continue;
    const f = formats[v.magic];
    if (!f) continue;
    if (v.version > f.newest) { newer.push(`${p} (${f.kind} version ${v.version}${v.tag ? ` of ${v.tag}` : ''}, this editor reads ${f.oldest} to ${f.newest})`); continue; }
    if (v.version >= f.oldest) continue;
    // the steps see the file without its tag; the converted file is written by this editor (filetag.js)
    let bytes = readTag(d).data, at = v.version;
    while (at < f.oldest) {
      const step = (steps[v.magic] ?? []).find(s => s.from === at);
      if (!step) throw new Error(`${p}: ${f.kind} version ${at} cannot be read any more (no way to version ${f.oldest})`);
      bytes = step.run(bytes);
      if (fileVersion(bytes)?.version !== step.to) throw new Error(`${p}: the step from version ${at} did not make version ${step.to}`);
      at = step.to;
    }
    out.set(p, withTag(bytes));
    notes.push(['§1511', p, f.kind, v.version, at]);
  }
  if (newer.length) throw new Error(`made with a newer editor: ${newer.join(', ')}`);
  return { files: out, notes };
}

// a project of the manifest's format brought to PROJECT_FORMAT, its files to the versions this
// editor reads: { files, notes, from }. Throws for a package of a newer format
export function migrateProject(files, manifest = { format: 0 }, opts = {}) {
  const from = manifest.format ?? 0;
  if (from > PROJECT_FORMAT) {
    throw new Error(`saved by a newer editor${manifest.editor ? ` (${manifest.editor})` : ''}: project format ${from}, this editor reads up to ${PROJECT_FORMAT}`);
  }
  let out = new Map(files);
  const notes = [];
  for (let at = from; at < PROJECT_FORMAT;) {
    const step = (opts.projectSteps ?? PROJECT_MIGRATIONS).find(s => s.from === at);
    if (!step) throw new Error(`project format ${at} cannot be read any more`);
    // a step gives the files, or { files, values }: the values of its note
    const r = step.run(out);
    out = r instanceof Map ? r : r.files;
    notes.push([step.note, ...(r instanceof Map ? [] : r.values ?? [])]);
    at = step.to;
  }
  const f = migrateFiles(out, opts);
  return { files: f.files, notes: [...notes, ...f.notes], from };
}
