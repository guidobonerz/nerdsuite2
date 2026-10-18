// preprocess.js - the directives of a BASIC source, worked out before the tokenizer reads it:
//
//   #define name [value]       a name (debug) or a name with a value (level 2); #undef name
//   @if name                  the lines up to @elif / @else / @end only when name is defined (not 0);
//   @if !name                  ... when it is not; @if name = value, @if name <> value; nested
//   @elif ... / @else / @end
//   DATA @embed kind "file"[, args]   DATA lines with the bytes of a file of the project:
//     sprite  "x.spr"[, frame]          a sprite frame of the sprite editor (its index or its name):
//                                       64 bytes a sprite (63 and the pad byte); a .bin: its blocks
//     charset "x.chr"[, first[, count]] characters: 8 bytes each (all 256 without first)
//     screen  "x.scr"[, colors]         the characters of a screen (colors: its colours)
//     bitmap  "x.kla"[, part]           a Koala picture: all, bitmap, screen, colors or background
//     sound   "x.sid"                   the music of a .sid file (its load address: the note of the line)
//     binary  "x.bin"[, from[, count]]  any file: its bytes from an offset
//
// The defines come from the project (nerdsuite.json "defines": "debug, level=2") and the source.
// preprocess() keeps every line where it is (a directive, a line left out: an empty line) except that an
// @embed line becomes its DATA lines; lines[k].src is the line of the source each one came from.

import { decodeSprites, decodeScreen } from '../gfxfile.js';

const PER_LINE = 16;

// "debug, level=2" or { debug: true } -> Map name -> value (lower case names)
export function parseDefines(defs) {
  const out = new Map();
  if (typeof defs === 'string') {
    for (const part of defs.split(/[,;\s]+/).filter(Boolean)) {
      const [k, v] = part.split('=');
      if (/^[a-z_]\w*$/i.test(k)) out.set(k.toLowerCase(), v ?? '1');
    }
  } else for (const [k, v] of Object.entries(defs ?? {})) if (v !== false && v != null) out.set(k.toLowerCase(), v === true ? '1' : String(v));
  return out;
}

// #define and #undef name the names, @if @elif @else @end ask them; '@define' is an error ("#define")
const DIRECTIVE = /^\s*(?:\d+\s*)?(?:#(define|undef)|@(if|elif|else|end|define|undef))\b\s*(.*?)\s*$/i;
export const isDirective = line => DIRECTIVE.test(line);
export const EMBED = /^(\s*(?:\d+\s*)?data\s*)@embed\s+([a-z]+)\s*"([^"]*)"\s*(?:,\s*(.*?))?\s*$/i;

// the condition of an @if: true / false, or { error }
function condition(expr, defs) {
  const e = expr.trim();
  let m;
  if ((m = /^!\s*([a-z_]\w*)$/i.exec(e))) return !defined(defs, m[1]);
  if ((m = /^([a-z_]\w*)$/i.exec(e))) return defined(defs, m[1]);
  if ((m = /^([a-z_]\w*)\s*(=|==|<>|!=)\s*("?)([^"]*)\3$/i.exec(e))) {
    const v = defs.get(m[1].toLowerCase());
    const same = v != null && v.toLowerCase() === m[4].toLowerCase();
    return m[2] === '=' || m[2] === '==' ? same : !same;
  }
  return { error: `'${expr}' is no condition: name, !name, name = value or name <> value` };
}
const defined = (defs, name) => { const v = defs.get(name.toLowerCase()); return v != null && v !== '0' && v.toLowerCase() !== 'false'; };

// which lines are in the program: active[k] (the editor dims the others) and the defines at the end
export function activeLines(text, defines) {
  const defs = new Map(parseDefines(defines));
  const lines = String(text).split('\n');
  const active = new Array(lines.length).fill(true);
  const errors = [];
  // a stack of { on: the block is in, done: a branch of the @if was taken, outer: the block around is in }
  const stack = [];
  const on = () => stack.every(s => s.on);
  lines.forEach((l, i) => {
    const m = DIRECTIVE.exec(l);
    if (!m) { active[i] = on(); return; }
    active[i] = false;                                   // a directive is no line of the program
    const word = (m[1] ?? m[2]).toLowerCase(), arg = m[3];
    if (!m[1] && (word === 'define' || word === 'undef')) { errors.push({ line: i + 1, msg: `@${word}: a name is defined with #${word} ${arg}`.trim() }); return; }
    const test = () => { const c = condition(arg, defs); if (c?.error) { errors.push({ line: i + 1, msg: c.error }); return false; } return c; };
    if (word === 'if') {
      const c = on() && test();
      stack.push({ on: !!c, done: !!c, line: i + 1 });
      return;
    }
    const top = stack.at(-1);
    if (word === 'elif' || word === 'else') {
      if (!top) { errors.push({ line: i + 1, msg: `@${word} without @if` }); return; }
      const outer = stack.slice(0, -1).every(s => s.on);
      const c = !top.done && outer && (word === 'else' || test());
      top.on = !!c;
      top.done ||= !!c;
      return;
    }
    if (word === 'end') { if (!stack.pop()) errors.push({ line: i + 1, msg: '@end without @if' }); return; }
    if (!on()) return;
    const d = /^([a-z_]\w*)(?:\s*=?\s*(.*))?$/i.exec(arg);
    if (!d) { errors.push({ line: i + 1, msg: `@${word} needs a name` }); return; }
    if (word === 'define') defs.set(d[1].toLowerCase(), d[2]?.trim() || '1');
    else defs.delete(d[1].toLowerCase());
  });
  for (const s of stack) errors.push({ line: s.line, msg: '@if without @end' });
  return { active, errors, defines: defs };
}

// --- @embed ------------------------------------------------------------------------------------------------

const args = text => (text ?? '').split(',').map(s => s.trim()).filter(Boolean).map(s => s.replace(/^"(.*)"$/, '$1'));
const num = s => (/^\$[0-9a-f]+$/i.test(s) ? parseInt(s.slice(1), 16) : /^\d+$/.test(s) ? Number(s) : NaN);

// the bytes of an @embed: { bytes, note, kind, preview: { kind, ... } } or { error }
export function embedData(kind, file, rest, readFile) {
  const data = readFile(file);
  if (!data) return { error: `there is no ${file} in the project` };
  const a = args(rest);
  const k = kind.toLowerCase();
  try {
    if (k === 'sprite' || k === 'sprites') {
      if (/\.spr$/i.test(file)) {
        const s = decodeSprites(data, file);
        const at = a[0] == null ? 0 : Number.isFinite(num(a[0])) ? num(a[0]) : s.frames.findIndex(f => f.name.toLowerCase() === a[0].toLowerCase());
        const f = s.frames[at];
        if (!f) return { error: `${file} has no frame ${a[0]} (${s.frames.length} frames: ${s.frames.slice(0, 6).map(x => x.name).join(', ')}${s.frames.length > 6 ? ' …' : ''})` };
        return { bytes: f.data, note: `sprite ${f.name}${s.w * s.h > 1 ? ` (${s.w}x${s.h} sprites)` : ''}${s.multicolor ? ', multicolor' : ''}`,
          preview: { kind: 'sprite', data: f.data, multicolor: s.multicolor, w: s.w, h: s.h } };
      }
      // C64 sprite blocks: 64 bytes each, after a load address when there is one
      const body = data.length % 64 === 2 ? data.subarray(2) : data;
      const at = a[0] == null ? 0 : num(a[0]), n = a[1] == null ? 1 : num(a[1]);
      const bytes = body.subarray(at * 64, (at + n) * 64);
      if (!bytes.length) return { error: `${file} has no sprite ${at}` };
      return { bytes, note: `${n > 1 ? `${n} sprites` : 'sprite'} from ${at}`, preview: { kind: 'sprite', data: bytes, multicolor: false, w: n, h: 1 } };
    }
    if (k === 'charset' || k === 'chars') {
      const body = data.length === 2050 || data.length === 1026 ? data.subarray(2) : data;
      const first = a[0] == null ? 0 : num(a[0]), count = a[1] == null ? (a[0] == null ? body.length >> 3 : 1) : num(a[1]);
      if (!Number.isFinite(first) || !Number.isFinite(count)) return { error: 'charset "file", first char, count' };
      const bytes = body.subarray(first * 8, (first + count) * 8);
      if (!bytes.length) return { error: `${file} has no character ${first}` };
      return { bytes, note: `${bytes.length >> 3} char${bytes.length > 8 ? 's' : ''} from ${first}`, preview: { kind: 'chars', data: bytes } };
    }
    if (k === 'screen') {
      const s = decodeScreen(data, file).screen;
      const colors = /^colou?rs?$/i.test(a[0] ?? '');
      if (colors && !s.colors) return { error: `${file} has no colours` };
      return { bytes: colors ? s.colors : s.chars, note: `the ${colors ? 'colours' : 'characters'} of a ${s.w}x${s.h} screen`, preview: { kind: 'screen', w: s.w, h: s.h, chars: s.chars, colors: s.colors } };
    }
    if (k === 'bitmap' || k === 'koala') {
      // Koala: load address, 8000 bitmap, 1000 screen, 1000 colours, the background
      const body = data.length === 10003 ? data.subarray(2) : data;
      if (body.length !== 10001) return { error: `${file} is no Koala picture (10003 bytes)` };
      const parts = { all: [0, 10001], bitmap: [0, 8000], screen: [8000, 9000], colors: [9000, 10000], colours: [9000, 10000], background: [10000, 10001] };
      const p = parts[(a[0] ?? 'all').toLowerCase()];
      if (!p) return { error: `bitmap "file", part: ${Object.keys(parts).join(', ')}` };
      return { bytes: body.subarray(p[0], p[1]), note: `${a[0] ?? 'the whole'} Koala picture${a[0] ? ' part' : ''}`, preview: { kind: 'koala', data: body } };
    }
    if (k === 'sound' || k === 'sid' || k === 'music') {
      if (/\.sng$/i.test(file)) return { error: 'a song of the composer: export it as .sid first (Export in the sound editor), then embed the .sid' };
      const magic = String.fromCharCode(...data.subarray(0, 4));
      if (magic !== 'PSID' && magic !== 'RSID') return { error: `${file} is no .sid file` };
      const off = data[6] << 8 | data[7];
      let load = data[8] << 8 | data[9];
      let body = data.subarray(off);
      if (!load) { load = body[0] | body[1] << 8; body = body.subarray(2); }
      const init = data[10] << 8 | data[11], play = data[12] << 8 | data[13];
      return { bytes: body, note: `music: load at $${load.toString(16)}, init $${init.toString(16)}, play $${play.toString(16)}`, load, preview: { kind: 'bytes' } };
    }
    if (k === 'binary' || k === 'bin' || k === 'bytes' || k === 'tiles' || k === 'map') {
      const from = a[0] == null ? 0 : num(a[0]), count = a[1] == null ? data.length - from : num(a[1]);
      if (!Number.isFinite(from) || !Number.isFinite(count)) return { error: 'binary "file", from, count' };
      const bytes = data.subarray(from, from + count);
      return { bytes, note: `${bytes.length} bytes from ${from}`, preview: { kind: 'bytes' } };
    }
  } catch (e) {
    return { error: `${file}: ${e.message}` };
  }
  return { error: `@embed ${kind}: sprite, charset, screen, bitmap, sound or binary` };
}

// the DATA lines of bytes: 'data 1,2,3' (16 a line)
export const dataLines = bytes => {
  const out = [];
  for (let i = 0; i < bytes.length; i += PER_LINE) out.push(`data ${[...bytes.subarray(i, i + PER_LINE)].join(',')}`);
  return out;
};

// the DATA lines of the @embed line src[i]: { texts, r } or { error } - with line numbers the first DATA
// line has the number of the line, the others count on from it (error: they run into the next line)
function expandEmbed(m, src, i, readFile, labelMode, errors) {
  const l = src[i];
  const r = embedData(m[2], m[3], m[4], readFile);
  if (r.error) { errors.push({ line: i + 1, msg: `@embed: ${r.error}` }); return null; }
  const data = dataLines(r.bytes);
  const own = /^\s*(\d+)/.exec(l);
  if (own && !labelMode) {
    const n = Number(own[1]);
    const next = src.slice(i + 1).map(x => /^\s*(\d+)/.exec(x)?.[1]).find(Boolean);
    if (next != null && n + data.length - 1 >= Number(next)) {
      errors.push({ line: i + 1, msg: `@embed: its ${data.length} DATA lines need the numbers ${n}-${n + data.length - 1}, line ${next} comes first: leave room or use the label mode` });
    }
    return { texts: data.map((d, k) => `${n + k} ${d}`), r };
  }
  const indent = /^\s*/.exec(l)[0];
  return { texts: data.map(d => indent + d), r };
}

// the program for the tokenizer: { lines: [{ text, src }], errors, embeds: [{ line, count, note }] }
// opts: { defines, readFile(path) -> bytes | null, labelMode }
export function preprocess(text, { defines = '', readFile = () => null, labelMode = false } = {}) {
  const src = String(text).split('\n');
  const { active, errors } = activeLines(text, defines);
  const lines = [], embeds = [];
  src.forEach((l, i) => {
    if (!active[i]) { lines.push({ text: '', src: i + 1 }); return; }
    const m = EMBED.exec(l);
    if (!m) { lines.push({ text: l, src: i + 1 }); return; }
    const e = expandEmbed(m, src, i, readFile, labelMode, errors);
    if (!e) { lines.push({ text: '', src: i + 1 }); return; }
    for (const t of e.texts) lines.push({ text: t, src: i + 1 });
    embeds.push({ line: i + 1, count: e.texts.length, bytes: e.r.bytes.length, note: e.r.note });
  });
  return { lines, errors, embeds };
}

// the source with every DATA @embed line as its DATA lines, all else as it is (the directives too, and
// an @embed of a branch that is off) - the Export of the code view: { text, errors, count }
export function resolveEmbeds(text, { readFile = () => null, labelMode = false } = {}) {
  const src = String(text).split('\n');
  const out = [], errors = [];
  let count = 0;
  src.forEach((l, i) => {
    const m = EMBED.exec(l);
    const e = m && expandEmbed(m, src, i, readFile, labelMode, errors);
    if (!e) { out.push(l); return; }
    out.push(...e.texts);
    count++;
  });
  return { text: out.join('\n'), errors, count };
}
