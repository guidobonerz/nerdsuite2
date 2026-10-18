// lang-basic.js - the Commodore BASIC dialects for the code editor (codeeditor.js): colours,
// autocompletion of the keywords of the dialect, of the {control codes} in strings and of the line
// numbers after GOTO / GOSUB / THEN, and Enter that proposes the next line number.
//
// The keywords come from basic/dialects.js, the tables the tokenizer itself uses.

import { DIALECTS } from './basic/dialects.js';
import * as petscii from './basic/petscii.js';
import { ATASCII_CODES } from './basic/listing.js';
import { asciiToPetscii, parseControlCode, charOut, PETSCII_BYTE } from './basic/basic.js';
import { h, signal } from './pui.js';

// the Commodore dialects are written in lower case (petcat); Atari BASIC and Locomotive BASIC in capitals
const COMMODORE = new Set(['v2', 'v4', 'v35', 'v7', 'simons']);
export const keywordCase = (dialect, name) => (COMMODORE.has(dialect) ? name.toLowerCase() : name.toUpperCase());
export const isCommodore = dialect => COMMODORE.has(dialect);
import { spans, filterItems, setCustomGlyphs } from './codeeditor.js';
import { charsetByKey, charsetFileSize, onCharsetChange } from './chr.js';
import { hasFile, onProjectChange } from './project.js';
import { keywordDoc, registerDoc, registersLike } from './cpudocs.js';
import { labelOf, scanLabels } from './basic/labels.js';
import { activeLines, isDirective } from './basic/preprocess.js';

export const dialectList = () => Object.entries(DIALECTS).map(([id, d]) => ({ id, name: d.name ?? id, machine: d.machine }));

const keywordCache = new Map();
// the keywords of a dialect, longest first (the tokenizer matches the longest one)
export function keywords(dialect = 'v2') {
  if (!keywordCache.has(dialect)) {
    const d = DIALECTS[dialect] ?? DIALECTS.v2 ?? Object.values(DIALECTS)[0];
    const list = (d?.keywords ?? []).map(k => (typeof k === 'string' ? { name: k } : k)).filter(k => k.name);
    keywordCache.set(dialect, list.slice().sort((a, b) => b.name.length - a.name.length));
  }
  return keywordCache.get(dialect);
}

export function controlCodes(dialect = 'v2') {
  if (dialect === 'atari' || dialect === 'turbo') return ATASCII_CODES;
  if (!COMMODORE.has(dialect)) return [];          // Locomotive, ZX81, TRS-80, BBC BASIC: {$xx} only
  const c = petscii.CONTROL_CODES ?? {};
  const list = Array.isArray(c) ? c : Object.entries(c).map(([name, v]) => ({ name, code: typeof v === 'number' ? v : v?.code, desc: v?.desc }));
  return list.map(x => (typeof x === 'string' ? { name: x } : x)).filter(x => x.name);
}

// true when the offset lies in a string of its line (between its quotes, or after an open one); a
// quote after REM opens none
export function inString(text, at) {
  const before = text.slice(text.lastIndexOf('\n', at - 1) + 1, at);
  let open = false;
  for (let k = 0; k < before.length; k++) {
    if (before[k] === '"') open = !open;
    else if (!open && /^rem/i.test(before.slice(k, k + 3))) return false;
  }
  return open;
}

// --- the strings of the Commodore dialects in the PETSCII glyphs of the C64 font ----------------
//
// The font (app.css) holds the glyphs at U+EE00 + screen code (upper case / graphics) and U+EF00 +
// screen code (lower / upper case); a glyph is 1em wide, so at font-size 1ch it takes one column of
// the code - the coloured layer stays under the letters of the textarea. A {control code} keeps the
// columns of its text and shows the glyph of its byte: the control codes as the reverse characters
// the C64 shows in quote mode.

const CHARSET_KEY = 'ns-petscii-charset';
// the character set of the glyphs: 'upper' or 'lower' (the ROM of the C64), or 'chr:<path>', a charset
// of the project (the PETSCII panel switches it); a charset of the project is drawn with a font made of
// its characters (codeeditor.js setCustomGlyphs), at the places of the upper case set
const validCharset = cs => (cs === 'lower' || cs === 'upper' || /^chr:./.test(cs ?? '') ? cs : 'upper');
export const petsciiCharset = signal((() => { try { return validCharset(globalThis.localStorage?.getItem(CHARSET_KEY)); } catch { return 'upper'; } })());
export function setPetsciiCharset(cs) {
  petsciiCharset.value = validCharset(cs);
  try { localStorage.setItem(CHARSET_KEY, petsciiCharset.value); } catch { /* private mode */ }
}
export const customCharsetPath = (cs = petsciiCharset.value) => (cs.startsWith('chr:') ? cs.slice(4) : null);

// the 256 characters of a charset of the project, or null (not in the project): a file of 128 characters
// (1024 bytes) gets the reversed ones as the ROM has them
export function charsetGlyphs(path) {
  if (!path || !hasFile(path)) return null;
  const bytes = charsetByKey(path);
  if (!bytes) return null;
  const out = bytes.slice(0, 2048);
  if ((charsetFileSize(path) ?? 2048) <= 1026) for (let i = 0; i < 1024; i++) out[1024 + i] = ~out[i] & 0xff;
  return out;
}
// the font of the custom charset follows the choice and the char editor (its changes come in batches)
let shownGlyphs = null;
const syncCustom = () => {
  const g = charsetGlyphs(customCharsetPath());
  if (g === shownGlyphs || (g && shownGlyphs && g.every((b, k) => b === shownGlyphs[k]))) return;     // the same: no new font
  shownGlyphs = g;
  setCustomGlyphs(g);
};
if (typeof document !== 'undefined') {
  petsciiCharset.subscribe(syncCustom);
  onCharsetChange(syncCustom);
  onProjectChange(syncCustom);
}

// the screen code a byte shows as in a string (quote mode)
export function quoteScreenCode(c) {
  if (c < 0x20) return c + 0x80;           // control codes: reverse @ A B ...
  if (c < 0x40) return c;
  if (c < 0x60) return c - 0x40;
  if (c < 0x80) return c - 0x20;
  if (c < 0xa0) return c + 0x40;           // control codes: reverse of the shifted characters
  if (c < 0xc0) return c - 0x40;
  if (c < 0xff) return c - 0x80;
  return 0x5e;                             // pi
}
const glyphs = (bytes, charset) => String.fromCharCode(...bytes.map(c => (charset === 'lower' ? 0xef00 : 0xee00) + quoteScreenCode(c)));

// the tokens of a string with its quotes: its characters and {codes} as glyphs
function petsciiTokens(str, dialect, charset, push) {
  let k = 0, run = '';
  const flush = () => { if (run) { push('tok-str tok-petscii', run, glyphs([...run].map(asciiToPetscii), charset)); run = ''; } };
  while (k < str.length) {
    const ch = str[k];
    if (ch === '{') {
      const code = parseControlCode(str, k, dialect);
      if (!code.error) {
        flush();
        const text = str.slice(k, code.end), n = text.length;
        const shown = code.bytes.length <= n ? code.bytes : code.bytes.slice(0, Math.max(1, n - 4));
        push('tok-flow tok-pill tok-petscii-code', text, h('span', { class: 'tok-petscii' }, glyphs(shown, charset)), { width: `${n}ch` });
        k = code.end;
        continue;
      }
      // an unknown code: its text, readable (the build names it)
      const close = str.indexOf('}', k);
      if (close > 0) { flush(); push('tok-flow', str.slice(k, close + 1)); k = close + 1; continue; }
    }
    if (ch === '"' || asciiToPetscii(ch) < 0) { flush(); push('tok-str', ch); k++; continue; }
    run += ch;
    k++;
  }
  flush();
}

// --- the editor's form of the strings: one character per byte ---------------------------------------
//
// The files hold petcat's {control codes} (basic/petscii.js); the editor holds a byte of a string that
// has no character of its own as one character, U+EE00 + byte, so it takes one column like on the C64
// (codeeditor.js gives these characters the width of a column). Opening converts the {codes} in the
// strings, saving, building and copying write them back.

// the editor's character of a byte in a string: itself when it has one, else U+EE00 + byte
export function editorChar(c, dialect = 'v2') {
  const s = c === 0x22 ? null : charOut(c, dialect);
  return s && s.length === 1 ? s : String.fromCharCode(PETSCII_BYTE + c);
}

// a line in pieces: [text, inString] - the strings without their quotes, nothing after REM
function stringParts(line) {
  const out = [];
  let at = 0, open = false;
  for (let k = 0; k < line.length; k++) {
    if (line[k] === '"') {
      out.push([line.slice(at, k + (open ? 0 : 1)), open]);
      at = k + (open ? 0 : 1);
      open = !open;
    } else if (!open && /^rem/i.test(line.slice(k, k + 3))) break;
  }
  out.push([line.slice(at), open]);
  return out;
}

// the {codes} in the strings of a source as the editor's characters
export function toEditorText(text, dialect = 'v2') {
  if (!COMMODORE.has(dialect) || !text.includes('{')) return text;
  return text.split('\n').map(line => stringParts(line).map(([part, str]) => {
    if (!str || !part.includes('{')) return part;
    let out = '';
    for (let k = 0; k < part.length;) {
      const code = part[k] === '{' ? parseControlCode(part, k, dialect) : { error: true };
      if (code.error) { out += part[k++]; continue; }
      out += code.bytes.map(c => editorChar(c, dialect)).join('');
      k = code.end;
    }
    return out;
  }).join('')).join('\n');
}

// the editor's characters as the {codes} of the file (petcat)
export const toSourceText = (text, dialect = 'v2') =>
  text.replace(/[-]/g, ch => { const c = ch.charCodeAt(0) - PETSCII_BYTE; return c === 0x22 ? '{$22}' : charOut(c, dialect); });

// a pasted text at an offset: its {codes} as characters, also when it is put into a string
export function pasteText(text, at, pasted, dialect = 'v2') {
  if (!inString(text, at)) return toEditorText(pasted, dialect);
  return toEditorText('"' + pasted, dialect).slice(1);
}

const JUMPS = /\b(goto|go\s*to|gosub|then|run|list|restore|trap|resume|renumber|collision|else)\s*([\d\s,]*)$/i;

// the tokens of one line: the line number, keywords, strings with their {codes}, REM to the end
// labels: the label mode (basic/labels.js) - a Set of the names (lower case): a label line is a name,
// so is a label after GOTO, GOSUB, THEN ... (not split into the keywords in it)
export function lineTokens(line, dialect = 'v2', { labels = null } = {}) {
  const out = [];
  const kws = keywords(dialect);
  let k = 0;
  const push = (cls, text, show, style) => { if (text) { out.push({ cls, text, show, style }); k += text.length; } };
  if (labels && labelOf(line)) { push('tok-name', line); return out; }
  const glyphed = COMMODORE.has(dialect);   // the strings in PETSCII glyphs
  const num = /^\s*\d+/.exec(line);
  if (num) push('tok-num tok-lineno', num[0]);
  const lower = line.toLowerCase();
  let data = false;
  while (k < line.length) {
    const ch = line[k];
    if (ch === "'" && (dialect === 'loco' || dialect === 'trs80')) { push('tok-comment', line.slice(k)); break; }   // Locomotive, Level II: ' is REM
    if (ch === '"') {
      const end = line.indexOf('"', k + 1);
      const str = end < 0 ? line.slice(k) : line.slice(k, end + 1);
      if (glyphed) { petsciiTokens(str, dialect, petsciiCharset.value, push); continue; }
      // the {codes} in it
      let at = 0;
      for (const m of str.matchAll(/\{[^{}]*\}/g)) {
        push('tok-str', str.slice(at, m.index));
        push('tok-flow', m[0]);
        at = m.index + m[0].length;
      }
      push('tok-str', str.slice(at));
      continue;
    }
    if (data) {                                       // DATA: plain values up to the next ':'
      const m = /^[^:"]+/.exec(line.slice(k));
      if (m) { push('tok-num', m[0]); continue; }
      if (ch === ':') { data = false; push(null, ':'); continue; }
    }
    const kw = kws.find(x => lower.startsWith(x.name.toLowerCase(), k));
    if (kw) {
      const name = line.slice(k, k + kw.name.length);
      const low = kw.name.toLowerCase();
      if (low === 'rem' || (low === "'")) { push('tok-kw', name); push('tok-comment', line.slice(k)); break; }
      push(/^(if|then|else|goto|gosub|return|for|next|on|go|do|loop|while|until|exit|begin|bend)$/.test(low) ? 'tok-flow' : 'tok-kw', name);
      if (low === 'data') {
        data = true;
        // DATA @embed kind "file", args (basic/preprocess.js)
        const em = /^(\s*)(@embed)(\s*[a-z]*)(\s*"[^"]*"?)?(.*)$/i.exec(line.slice(k));
        if (em) {
          push(null, em[1]); push('tok-flow tok-directive', em[2]); push('tok-kw', em[3]); push('tok-str', em[4]); push('tok-num', em[5]);
          break;
        }
      }
      // the label mode: the labels after a jump word
      if (labels && LABEL_WORDS.has(low)) {
        for (;;) {
          const m = /^(\s*)([a-z_]\w*)/i.exec(line.slice(k));
          if (!m || !labels.has(m[2].toLowerCase())) break;
          push(null, m[1]);
          push('tok-name', m[2]);
          const comma = /^\s*,/.exec(line.slice(k));
          if (!comma) break;
          push(null, comma[0]);
        }
      }
      continue;
    }
    const n = /^(\d+\.?\d*(e[+-]?\d+)?|\.\d+|\$[0-9a-f]+|%[01]+)/i.exec(line.slice(k));
    if (n) { push('tok-num', n[0]); continue; }
    const v = /^[a-z][a-z0-9]*[$%]?/i.exec(line.slice(k));
    if (v) { push('tok-sym', v[0]); continue; }
    if ('()'.includes(ch)) { push('tok-bracket', ch); continue; }
    push(null, ch);
  }
  return out;
}

const LABEL_WORDS = new Set(['goto', 'go to', 'gosub', 'then', 'else', 'run', 'list', 'restore', 'trap', 'resume']);

// a directive line (basic/preprocess.js): #define, @if ...
function directiveTokens(line) {
  const m = /^(\s*)(\d*)(\s*)([#@][a-z]+)(.*)$/i.exec(line);
  if (!m) return [{ cls: 'tok-flow', text: line }];
  return [{ cls: null, text: m[1] }, { cls: 'tok-num tok-lineno', text: m[2] }, { cls: null, text: m[3] }, { cls: 'tok-flow tok-directive', text: m[4] }, { cls: 'tok-sym', text: m[5] }]
    .filter(t => t.text);
}

// opts: labelMode; defines (the project's: the lines an @if leaves out are dimmed); inlay(line, index) ->
// a node after the end of the line (the data of an @embed) or null
export function highlight(text, dialect = 'v2', { labelMode = false, defines = '', inlay = null } = {}) {
  const out = [];
  const lines = text.split('\n');
  const labels = labelMode ? new Set(scanLabels(text).map(l => l.name.toLowerCase())) : null;
  const directives = /^\s*\d*\s*[#@]/m.test(text);
  const { active } = directives ? activeLines(text, defines) : { active: null };
  lines.forEach((l, i) => {
    const toks = directives && isDirective(l) ? directiveTokens(l)
      : active && !active[i] ? [{ cls: 'tok-inactive', text: l }]
        : lineTokens(l, dialect, { labels });
    out.push(...spans(toks));
    const extra = inlay?.(l, i);
    if (extra) out.push(extra);
    if (i < lines.length - 1) out.push('\n');
  });
  return out;
}

// the line numbers of a program: [{ number, line }]
export function lineNumbers(text) {
  const out = [];
  text.split('\n').forEach((l, i) => { const m = /^\s*(\d+)/.exec(l); if (m) out.push({ number: Number(m[1]), line: i + 1, text: l.slice(m[0].length).trim() }); });
  return out;
}

// renumber a program: start, step; the targets of GOTO, GOSUB, THEN ... follow
export function renumber(text, start = 10, step = 10) {
  const map = new Map();
  let n = start;
  for (const { number } of lineNumbers(text)) { if (!map.has(number)) { map.set(number, n); n += step; } }
  return text.split('\n').map(l => {
    const m = /^(\s*)(\d+)(.*)$/.exec(l);
    if (!m) return l;
    // the line numbers after the jump words, outside strings
    const body = m[3].split(/("[^"]*"?)/).map((part, i) => (i % 2 ? part : part.replace(/\b(goto|go\s*to|gosub|then|run|list|restore|trap|resume|else)(\s*)([\d\s,]+)/gi,
      (all, w, sp, nums) => w + sp + nums.replace(/\d+/g, d => String(map.get(Number(d)) ?? d))))).join('');
    return m[1] + (map.get(Number(m[2])) ?? m[2]) + body;
  }).join('\n');
}

// ctx: { dialect() }
// the keywords whose first argument is an address: their completion offers the registers
const ADDRESS_KEYWORDS = new Set(['poke', 'peek', 'wait', 'sys']);

// the keyword whose arguments the caret is in: the innermost open function (PEEK(, MID$(), else the
// statement (after the last ':' or THEN) -> { k, index: the argument at the caret (by its commas),
// args: [text], rest: the text after the keyword } or null
export function signatureAt(before, list) {
  const s = before.replace(/"[^"]*"?/g, m => ' '.repeat(m.length)).toLowerCase();      // no strings
  let stmt = s.slice(s.lastIndexOf(':') + 1);
  const then = stmt.lastIndexOf('then');
  if (then >= 0) stmt = stmt.slice(then + 4);
  stmt = stmt.replace(/^\s*\d+/, m => ' '.repeat(m.length));                           // the line number
  const byLength = list.slice().sort((a, b) => b.name.length - a.name.length);
  // the arguments of a text: split at the commas outside brackets
  const split = t => {
    const args = [''];
    let depth = 0;
    for (const ch of t) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) args.push('');
      else args[args.length - 1] += ch;
    }
    return args;
  };
  const open = [];
  for (let i = 0; i < stmt.length; i++) {
    if (stmt[i] === '(') open.push(i);
    else if (stmt[i] === ')') open.pop();
  }
  for (let o = open.length - 1; o >= 0; o--) {
    const head = stmt.slice(0, open[o]).replace(/\s+$/, '');
    const k = byLength.find(x => head.endsWith(x.name.replace(/\($/, '')));
    if (k) {
      const rest = stmt.slice(open[o] + 1), args = split(rest);
      return { k, index: args.length - 1, args, rest };
    }
  }
  const t = stmt.replace(/^\s+/, '');
  const k = byLength.find(x => t.startsWith(x.name));
  if (!k || t.length === k.name.length) return null;          // still typing the keyword
  const rest = t.slice(k.name.length), args = split(rest);
  return { k, index: args.length - 1, args, rest };
}

// the directives of the preprocessor (basic/preprocess.js) for the completion
const DIRECTIVE_ITEMS = [
  { label: '#define', kind: 'pseudo', syntax: '#define name [value]', detail: 'defines a name for @if (the project settings define names too)' },
  { label: '#undef', kind: 'pseudo', syntax: '#undef name', detail: 'the name is no longer defined' },
  { label: '@if', kind: 'pseudo', syntax: '@if name | !name | name = value | name <> value', detail: 'the lines up to @elif, @else or @end are in the program only when the condition holds' },
  { label: '@elif', kind: 'pseudo', syntax: '@elif condition', detail: 'the next branch of an @if' },
  { label: '@else', kind: 'pseudo', syntax: '@else', detail: 'the lines when no branch of the @if was taken' },
  { label: '@end', kind: 'pseudo', syntax: '@end', detail: 'ends an @if' },
];
const EMBED_ITEM = { label: '@embed', kind: 'pseudo', insert: '@embed ', syntax: 'DATA @embed kind "file"[, args]', detail: 'DATA lines with the bytes of a file of the project: sprite, charset, screen, bitmap, sound, binary' };
const EMBED_KINDS = [
  ['sprite', 'sprite "x.spr"[, frame]', 'a frame of the sprite editor (its index or name): 64 bytes a sprite'],
  ['charset', 'charset "x.chr"[, first[, count]]', 'characters of a charset: 8 bytes each'],
  ['screen', 'screen "x.scr"[, colors]', 'the characters (or the colours) of a screen'],
  ['bitmap', 'bitmap "x.kla"[, all|bitmap|screen|colors|background]', 'a Koala picture or a part of it'],
  ['sound', 'sound "x.sid"', 'the music of a .sid file (the load address: the note of the line)'],
  ['binary', 'binary "x.bin"[, from[, count]]', 'any file: its bytes from an offset'],
].map(([label, syntax, detail]) => ({ label, kind: 'keyword', insert: `${label} "`, syntax: `DATA @embed ${syntax}`, detail }));
const EMBED_EXT = { sprite: /\.(spr|bin|raw)$/i, charset: /\.(chr|fnt|bin|raw)$/i, screen: /\.scr$/i, bitmap: /\.(kla|koa)$/i, sound: /\.sid$/i };

// a jump word and the label being typed after it (the label mode)
const LABEL_JUMP = /(?<![a-z_])(goto|go\s*to|gosub|then|else|run|list|restore|trap|resume)\s*(?:[a-z_]\w*\s*,\s*)*([a-z_]\w*)?$/i;

// ctx: { dialect(), machine(), labelMode() }
export function basicLanguage(ctx = {}) {
  const dialect = () => ctx.dialect?.() ?? 'v2';
  const labelMode = () => !!ctx.labelMode?.();
  return {
    comment: 'rem',
    commentRe: /^(\s*\d*\s*)rem ?/i,
    commentLine: l => l.replace(/^(\s*\d*\s*)/, '$1rem '),
    autoTrigger: ch => ch === '{',
    // a {code} just closed in a string of a Commodore dialect: its characters (one per byte)
    collapse(text, caret) {
      if (!COMMODORE.has(dialect()) || text[caret - 1] !== '}' || !inString(text, caret)) return null;
      const m = /\{[^{}"]*\}$/.exec(text.slice(0, caret));
      if (!m) return null;
      const code = parseControlCode(m[0], 0, dialect());
      return code.error ? null : { from: caret - m[0].length, to: caret, insert: code.bytes.map(c => editorChar(c, dialect())).join('') };
    },
    // the clipboard holds the {codes} of the file
    copyText: text => toSourceText(text, dialect()),
    pasteText: (text, at, pasted) => pasteText(text, at, pasted, dialect()),
    highlight: text => highlight(text, dialect(), { labelMode: labelMode(), defines: ctx.defines?.() ?? '', inlay: ctx.inlay }),
    // Enter after a numbered line: the next number, 10 on (or halfway to the next line); the label mode
    // has no numbers: the indent of the line
    newline(text, caret) {
      if (labelMode()) {
        const a = text.lastIndexOf('\n', caret - 1) + 1, line = text.slice(a, caret);
        return '\n' + (labelOf(line) ? '  ' : /^[ \t]*/.exec(line)[0]);
      }
      const a = text.lastIndexOf('\n', caret - 1) + 1;
      const m = /^\s*(\d+)/.exec(text.slice(a, caret));
      if (!m || text.slice(caret, text.indexOf('\n', caret) < 0 ? text.length : text.indexOf('\n', caret)).trim()) return '\n';
      const cur = Number(m[1]);
      const next = lineNumbers(text).map(x => x.number).filter(x => x > cur).sort((x, y) => x - y)[0];
      let n = cur + 10;
      if (next != null && n >= next) n = next - cur > 1 ? cur + Math.floor((next - cur) / 2) : null;
      return n == null ? '\n' : `\n${n} `;
    },
    complete(text, caret, { force } = {}) {
      const lineFrom = text.lastIndexOf('\n', caret - 1) + 1;
      const before = text.slice(lineFrom, caret);
      // the directives (basic/preprocess.js): at the start of a line, and @embed in a DATA line
      const dir = /^\s*(?:\d+\s*)?([#@]\w*)$/.exec(before);
      if (dir) return { from: caret - dir[1].length, to: caret, items: filterItems(DIRECTIVE_ITEMS, dir[1]), open: true };
      const emb = /\bdata\s*(@\w*)$/i.exec(before);
      if (emb) return { from: caret - emb[1].length, to: caret, items: filterItems([EMBED_ITEM], emb[1]), open: true };
      const kind = /\bdata\s*@embed\s+(\w*)$/i.exec(before);
      if (kind) return { from: caret - kind[1].length, to: caret, items: filterItems(EMBED_KINDS, kind[1]), open: true };
      const file = /\bdata\s*@embed\s+(\w+)\s*"([^"]*)$/i.exec(before);
      if (file) {
        const ext = EMBED_EXT[file[1].toLowerCase()];
        const items = (ctx.files?.() ?? []).filter(p => !ext || ext.test(p)).map(p => ({ label: p, kind: 'file', insert: `${p}"`, detail: `@embed ${file[1]} "${p}"` }));
        return { from: caret - file[2].length, to: caret + (text[caret] === '"' ? 1 : 0), items: filterItems(items, file[2]), open: true };
      }
      const quotes = (before.match(/"/g) ?? []).length;
      // in a string: the {control codes}
      if (quotes % 2) {
        const m = /\{([^{}]*)$/.exec(before);
        if (!m) return null;
        const items = controlCodes(dialect()).map(c => ({ label: `{${c.name}}`, kind: 'code', hint: c.code != null ? '$' + c.code.toString(16).padStart(2, '0') : '', detail: c.desc }));
        return { from: caret - m[0].length, to: caret + (text[caret] === '}' ? 1 : 0), items: filterItems(items, '{' + m[1]), open: true };
      }
      if (/\brem\b/i.test(before)) return null;
      // the label mode: after a jump the labels (GOTO, GOSUB: the list at once; THEN: once a letter is typed)
      if (labelMode()) {
        const lj = LABEL_JUMP.exec(before);
        if (lj) {
          const typed = lj[2] ?? '';
          const items = scanLabels(text).map(l => ({ label: l.name, kind: 'label', hint: `line ${l.line}`, detail: `the label ${l.name} - line ${l.line} of the source` }));
          if (items.length && (typed || force || /^go/i.test(lj[1]))) return { from: caret - typed.length, to: caret, items: filterItems(items, typed), open: true };
        }
      }
      // after a jump: the line numbers
      const jump = labelMode() ? null : JUMPS.exec(before);
      if (jump && /(^|[\s,])\d*$/.test(before)) {
        const m = /\d*$/.exec(before)[0];
        const items = lineNumbers(text).map(x => ({ label: String(x.number), kind: 'line', detail: x.text }));
        return { from: caret - m.length, to: caret, items: filterItems(items, m), open: force || m.length > 0 };
      }
      if (/^\s*\d*$/.test(before) && !force) return null;   // the line number itself
      // the keyword the caret is in the arguments of: its parameters, the one at the caret first
      const sig = signatureAt(before, keywords(dialect()));
      let info = sig ? [keywordDoc(sig.k, sig.rest)] : null;
      const machine = ctx.machine?.();
      if (sig && ADDRESS_KEYWORDS.has(sig.k.name)) {
        if (sig.index === 0) {
          // POKE 532..: the registers of the machine, by their decimal address
          const typed = /\d*$/.exec(before)[0];
          if (typed && /^\s*\d+$/.test(sig.args[0])) {
            const items = registersLike(machine, typed, { decimal: true }).map(r => ({ label: r.text, kind: 'const', hint: r.name, doc: registerDoc(machine, r.addr, { decimal: true }) }));
            const exact = registerDoc(machine, Number(typed), { decimal: true });
            if (exact) info.push(exact);
            if (items.length) return { from: caret - typed.length, to: caret, items, info, open: typed.length > 2 };
          }
        } else {
          const reg = /^\s*\d+\s*$/.test(sig.args[0]) && registerDoc(machine, Number(sig.args[0]), { decimal: true });
          if (reg) info.push(reg);                // POKE 53265, ...: the bits of that register
        }
      }
      const m = /[a-z]*[$]?$/i.exec(before)[0];
      const items = keywords(dialect()).slice().sort((a, b) => a.name.localeCompare(b.name))
        .map(k => ({ label: keywordCase(dialect(), k.name), kind: 'keyword', hint: k.short ?? '', syntax: k.syntax, detail: k.desc, doc: keywordDoc(k) }));
      return { from: caret - m.length, to: caret, items: filterItems(items, m), info };
    },
  };
}
