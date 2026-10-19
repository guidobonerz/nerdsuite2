// Commodore BASIC tokenizer / detokenizer, compatible with VICE petcat (token values and text conventions).
// Plain ES module, no dependencies; runs in browsers and Node.

import { DIALECTS } from './dialects.js';
import { lookupControlCode, controlCodeName } from './petscii.js';
import { tokenizeListing, detokenizeListing } from './listing.js';
import { tokenizeZx81, detokenizeZx81 } from '../zx81.js';

export { DIALECTS };

const MAX_LINE_NUMBER = 63999;
const MAX_LINE_BYTES = 255;
const OPERATORS = '+-*/^>=<';

// ------------------------------------------------------------------ dialect preparation

const cache = new Map();

function getDialect(id) {
  if (cache.has(id)) return cache.get(id);
  const d = DIALECTS[id];
  if (!d) throw new Error(`Unknown BASIC dialect "${id}"`);
  // petcat: common keyword range is $80-$CB, or $80-$FD for BASIC 3.5/7.0/65 ($CE excluded on 7.0 and 65)
  const maxCommon = id === 'v35' || id === 'v7' || id === 'v65' ? 0xfd : 0xcb;
  const prefixed = []; // matched first (Simons' $64xx, 7.0 $FExx/$CExx); petcat tries $FE before $CE
  const common = [];
  const ext = []; // extension tokens > common range (BASIC 4.0 $CC-$DA)
  const single = new Map(); // byte -> name
  const twoByte = new Map(); // prefix -> Map(byte -> name)
  for (const kw of d.keywords) {
    if (Array.isArray(kw.token)) {
      const [pre, b] = kw.token;
      if (!twoByte.has(pre)) twoByte.set(pre, new Map());
      twoByte.get(pre).set(b, kw.name);
      prefixed.push({ name: kw.name, bytes: [pre, b] });
    } else {
      single.set(kw.token, kw.name);
      if (kw.token === 0xff) continue; // pi: '~' is converted as a character
      const entry = { name: kw.name, bytes: [kw.token] };
      if (kw.token <= maxCommon) common.push(entry);
      else ext.push(entry);
    }
  }
  const byToken = (a, b) => (a.bytes[0] - b.bytes[0]) || ((a.bytes[1] ?? 0) - (b.bytes[1] ?? 0));
  // $FE group before $CE group (petcat order); inside a group the longest match wins, ties go to later tokens
  const groups = [];
  const fe = prefixed.filter((e) => e.bytes[0] === 0xfe).sort(byToken);
  const ce = prefixed.filter((e) => e.bytes[0] === 0xce).sort(byToken);
  const other = prefixed.filter((e) => e.bytes[0] !== 0xfe && e.bytes[0] !== 0xce).sort(byToken);
  for (const g of [other, fe, ce]) if (g.length) groups.push(g);
  const prep = { id, def: d, prefixed: groups, common: common.sort(byToken), ext: ext.sort(byToken), single, twoByte };
  cache.set(id, prep);
  return prep;
}

/** Longest keyword of `list` starting at `pos` in the lowercase string `s` (ties: later token). */
function longest(list, s, pos) {
  let best = null;
  for (const kw of list) {
    if (s.startsWith(kw.name, pos) && (!best || kw.name.length >= best.name.length)) best = kw;
  }
  return best;
}

/** Keyword the tokenizer would pick at `pos` (petcat precedence rules), or null. */
function matchKeyword(prep, s, pos) {
  for (const g of prep.prefixed) {
    const m = longest(g, s, pos);
    if (m) return m;
  }
  const c = longest(prep.common, s, pos);
  const e = prep.ext.length ? longest(prep.ext, s, pos) : null;
  if (c && e) return e.name.length >= c.name.length ? e : c;
  return e || c;
}

// ------------------------------------------------------------------ tokenizer

// the code editor holds a byte of a string that has no character of its own (a {control code}, a
// graphic) as one character: U+EE00 + the byte (lang-basic.js)
export const PETSCII_BYTE = 0xee00;
const UNICODE_MAP = { '£': 0x5c, 'π': 0xff, '←': 0x5f, '↑': 0x5e };

/** petcat's ascii_to_petscii: the byte of a character of a string, or -1. */
export function asciiToPetscii(ch) {
  if (ch in UNICODE_MAP) return UNICODE_MAP[ch];
  const c = ch.charCodeAt(0);
  if (c >= PETSCII_BYTE && c <= PETSCII_BYTE + 0xff) return c - PETSCII_BYTE;   // a byte as the editor holds it
  if (c > 0x7e) return -1;
  if (c === 0x7e) return 0xff; // '~' = pi
  if (c >= 0x5b && c <= 0x5f) return c;
  if (c >= 0x60) return c ^ 0x20; // a-z -> $41-$5A
  if (c >= 0x41 && c <= 0x5a) return c | 0x80; // A-Z -> $C1-$DA (shifted)
  return c;
}

/**
 * Parses a control code at s[i] === '{'. Returns { bytes, end } or { error }.
 * Formats (petcat): {name}, {$xx}, {nnn} (decimal), {n name}, {nname}, {name*n}.
 */
export function parseControlCode(s, i, dialect) {
  const close = s.indexOf('}', i + 1);
  if (close < 0) return { error: `unterminated control code "${s.slice(i, i + 12)}"` };
  let body = s.slice(i + 1, close);
  let count = 1;
  const lead = /^(\d+)/.exec(body);
  if (lead) {
    if (lead[1].length === body.length) {
      const v = parseInt(body, 10);
      if (v > 255) return { error: `character code out of range: {${body}}` };
      return { bytes: [v], end: close + 1 };
    }
    count = parseInt(lead[1], 10);
    body = body.slice(lead[1].length);
    if (body[0] === ' ') body = body.slice(1);
  }
  let code = lookupControlCode(body, dialect);
  if (code < 0) {
    const star = body.lastIndexOf('*');
    if (star > 0 && /^\d+$/.test(body.slice(star + 1))) {
      code = lookupControlCode(body.slice(0, star), dialect);
      count = parseInt(body.slice(star + 1), 10);
    }
  }
  if (code < 0) return { error: `unknown control code {${s.slice(i + 1, close)}}` };
  if (count > 255) return { error: `repeat count too large in {${s.slice(i + 1, close)}}` };
  return { bytes: new Array(count).fill(code), end: close + 1 };
}

function tokenizeLine(text, prep) {
  const out = [];
  const lower = text.toLowerCase();
  let quote = false;
  let rem = false;
  let data = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') quote = !quote;
    if (ch === '{') {
      const r = parseControlCode(text, i, prep.id);
      if (r.error) return { error: r.error };
      out.push(...r.bytes);
      i = r.end;
      continue;
    }
    const code = !quote && !rem && !data;
    if (code && (/[a-z]/i.test(ch) || OPERATORS.includes(ch))) {
      const kw = matchKeyword(prep, lower, i);
      if (kw) {
        out.push(...kw.bytes);
        i += kw.name.length;
        if (kw.bytes.length === 1) {
          if (kw.bytes[0] === 0x8f) rem = true;
          else if (kw.bytes[0] === 0x83) data = true;
        }
        continue;
      }
    }
    if (code && ch === '?') { // PRINT shortcut
      out.push(0x99);
      i++;
      continue;
    }
    // outside strings/REM/DATA letters are case-insensitive: always $41-$5A
    const p = asciiToPetscii(code ? lower[i] : ch);
    if (p < 0) return { error: `unsupported character "${ch}"` };
    out.push(p);
    if (ch === ':' && !quote) data = false;
    i++;
  }
  return { bytes: out };
}

/**
 * Tokenizes BASIC source text into a PRG (with 2-byte load address).
 * @returns {{ok:boolean, errors:{line:number,msg:string}[], prg:Uint8Array, start:number,
 *            lines:{src:number, number:number, addr:number}[]}}
 */
// srcLines: the line of the source each line of text came from (the preprocessor: @embed makes many of one)
export function tokenize(text, { dialect = 'v2', start, machine, srcLines } = {}) {
  const def = DIALECTS[dialect];
  if (def?.output === 'zx81-p') {
    // a .p file (zx81.js); the lines and errors in the lines of the source
    const r = tokenizeZx81(text);
    const src = n => srcLines?.[n - 1] ?? n;
    return { ...r, prg: null, listing: r.bytes, format: def.output, start: 0x407d,
      errors: r.errors.map(e => ({ ...e, line: src(e.line) })), lines: r.lines.map(l => ({ ...l, src: src(l.src) })) };
  }
  if (def && def.output !== 'prg') return tokenizeListing(text, def);
  const prep = getDialect(dialect);
  if (start == null) {
    if (machine != null) {
      const m = prep.def.machines?.[machine];
      if (!m) throw new Error(`Unknown machine "${machine}" for dialect "${dialect}"`);
      start = m.start;
    } else {
      start = prep.def.start;
    }
  }
  const errors = [];
  const parsed = [];
  const src = String(text ?? '').split(/\r\n|\r|\n/);
  let prevNumber = -1;
  src.forEach((raw, idx) => {
    const lineNo = srcLines?.[idx] ?? idx + 1;
    if (/^\s*$/.test(raw) || raw[0] === ';') return; // blank line / petcat comment
    const m = /^\s*(\d+)/.exec(raw);
    if (!m) {
      errors.push({ line: lineNo, msg: 'missing line number' });
      return;
    }
    const number = parseInt(m[1], 10);
    if (m[1].length > 5 || number > MAX_LINE_NUMBER) {
      errors.push({ line: lineNo, msg: `line number ${m[1]} out of range (0-${MAX_LINE_NUMBER})` });
      return;
    }
    if (number === prevNumber) {
      errors.push({ line: lineNo, msg: `duplicate line number ${number}` });
      return;
    }
    if (number < prevNumber) {
      errors.push({ line: lineNo, msg: `line number ${number} is not greater than previous line ${prevNumber}` });
      return;
    }
    prevNumber = number;
    const body = raw.slice(m[0].length).replace(/^\s+/, '');
    if (!body) {
      errors.push({ line: lineNo, msg: `line ${number} is empty` });
      return;
    }
    const r = tokenizeLine(body, prep);
    if (r.error) {
      errors.push({ line: lineNo, msg: r.error });
      return;
    }
    if (r.bytes.length > MAX_LINE_BYTES) {
      errors.push({ line: lineNo, msg: `line ${number} too long (${r.bytes.length} bytes tokenized, max ${MAX_LINE_BYTES})` });
      return;
    }
    parsed.push({ src: lineNo, number, bytes: r.bytes });
  });

  const bytes = [start & 0xff, (start >> 8) & 0xff];
  const lines = [];
  let addr = start;
  for (const l of parsed) {
    const next = addr + l.bytes.length + 5;
    if (next + 2 > 0x10000) {
      errors.push({ line: l.src, msg: 'program too large: exceeds address $FFFF' });
      break;
    }
    lines.push({ src: l.src, number: l.number, addr });
    bytes.push(next & 0xff, next >> 8, l.number & 0xff, l.number >> 8, ...l.bytes, 0);
    addr = next;
  }
  bytes.push(0, 0);
  return { ok: errors.length === 0, errors, prg: Uint8Array.from(bytes), start, lines };
}

// ------------------------------------------------------------------ detokenizer

const hex = (c) => `{$${c.toString(16).padStart(2, '0')}}`;
const LITERAL_OPS = new Set([0x2a, 0x2b, 0x2d, 0x2f, 0x3c, 0x3d, 0x3e, 0x5e]);

/** petcat's _p_toascii (control codes enabled): the source form of a byte in a string. */
export function charOut(c, dialect) {
  if (c === 0x40) return '@';
  if (c >= 0x20 && c < 0x40) return String.fromCharCode(c);
  if (c >= 0x41 && c <= 0x5a) return String.fromCharCode(c + 0x20);
  if (c >= 0x5b && c <= 0x5f) return '[\\]^_'[c - 0x5b];
  if (c >= 0xc1 && c <= 0xda) return String.fromCharCode(c - 0x80);
  if (c === 0xff) return '~';
  if (c === 0xc0) return '{shift-*}';
  if (c === 0xa0 || c === 0xde || c === 0x0d || c === 0x0a) return hex(c);
  const name = controlCodeName(c, dialect);
  return name ? `{${name}}` : hex(c);
}

/** Byte -> ASCII char for keyword lookahead ('\0' for non-matchable bytes). */
function lookChar(c) {
  if (c >= 0x41 && c <= 0x5a) return String.fromCharCode(c + 0x20);
  if (c >= 0x20 && c < 0x60) return String.fromCharCode(c);
  return '\0';
}

/** Escaped form of raw bytes: always re-tokenizes to exactly these bytes. */
function escapeBytes(bytes) {
  return Array.from(bytes, (c) => (c >= 0x41 && c <= 0x5a ? `{${String.fromCharCode(c + 0x20)}}` : hex(c))).join('');
}

/**
 * Renders one line's content. Pieces are first rendered petcat-style, then the text is re-tokenized and any
 * piece where the bytes would differ (e.g. letters merging with a following keyword: "I"+FRE -> "ifre" = IF ...)
 * is replaced by its escaped form until the line round-trips exactly.
 */
function detokenizeLine(b, prep) {
  const pieces = renderPieces(b, prep);
  const texts = pieces.map((p) => p.text);
  for (let iter = 0; iter <= pieces.length; iter++) {
    const r = tokenizeLine(texts.join(''), prep);
    if (!r.error && r.bytes.length === b.length && r.bytes.every((x, i) => x === b[i])) break;
    let d = 0;
    if (!r.error) while (d < b.length && r.bytes[d] === b[d]) d++;
    let k = r.error ? -1 : pieces.findIndex((p) => d >= p.start && d < p.end);
    if (k < 0) k = pieces.length - 1;
    while (k >= 0 && texts[k] === pieces[k].alt) k--; // already escaped: blame an earlier piece
    if (k < 0 || iter === pieces.length) return escapeBytes(b);
    texts[k] = pieces[k].alt;
  }
  return texts.join('');
}

/** Splits a line into rendered pieces: [{ text, alt (escaped form), start, end (byte range) }]. */
function renderPieces(b, prep) {
  const look = Array.from(b, lookChar).join('');
  let firstNonSpace = b.findIndex((c) => c !== 0x20);
  if (firstNonSpace < 0) firstNonSpace = b.length;
  let lastNonSpace = b.length - 1;
  while (lastNonSpace >= 0 && b[lastNonSpace] === 0x20) lastNonSpace--;
  const pieces = [];
  const emit = (start, len, text) => {
    const end = Math.min(start + len, b.length);
    pieces.push({ text, start, end, alt: escapeBytes(b.subarray(start, end)) });
  };
  let quote = false;
  let rem = false;
  let data = false;
  let i = 0;
  while (i < b.length) {
    const c = b[i];
    const code = !quote && !rem && !data;
    if (code && c >= 0x80 && c !== 0xff) {
      const two = prep.twoByte.get(c);
      if (two) {
        const n = b[i + 1];
        emit(i, 2, n !== undefined && two.has(n) ? two.get(n) : escapeBytes(b.subarray(i, i + 2)));
        i += 2;
        continue;
      }
      const name = prep.single.get(c);
      emit(i, 1, name ?? hex(c));
      if (c === 0x8f) rem = true;
      else if (c === 0x83) data = true;
      i++;
      continue;
    }
    if (code && c === 0x64 && prep.id === 'simons') {
      const n = b[i + 1];
      if (n !== undefined && n < 0x80) {
        emit(i, 2, prep.twoByte.get(0x64).get(n) ?? hex(0x64) + hex(n));
        i += 2;
      } else {
        emit(i, 1, hex(0x64));
        i++;
      }
      continue;
    }
    let text;
    if (c === 0x22) {
      quote = !quote;
      text = '"';
    } else if (c === 0x20) {
      text = i < firstNonSpace || i > lastNonSpace ? hex(0x20) : ' ';
    } else if (code && LITERAL_OPS.has(c)) {
      text = `{${String.fromCharCode(c)}}`; // would become an operator token
    } else if (code && c === 0x3f) {
      text = hex(c); // would become PRINT
    } else if (code && c >= 0x41 && c <= 0x5a && matchKeyword(prep, look, i)) {
      text = `{${String.fromCharCode(c + 0x20)}}`; // literal keyword text, petcat style: {p}rint
    } else {
      text = charOut(c, prep.id);
      if (c === 0x3a && !quote) data = false;
    }
    emit(i, 1, text);
    i++;
  }
  return pieces;
}

/**
 * Converts a tokenized PRG (with load address) back to petcat-style text
 * (lowercase keywords, {codes} for control characters). Stops at the end-of-program marker.
 */
export function detokenize(prg, { dialect = 'v2' } = {}) {
  const def = DIALECTS[dialect];
  if (def?.output === 'zx81-p') return detokenizeZx81(prg instanceof Uint8Array ? prg : Uint8Array.from(prg));
  if (def && def.output !== 'prg') return detokenizeListing(prg instanceof Uint8Array ? prg : Uint8Array.from(prg), def);
  const prep = getDialect(dialect);
  const data = prg instanceof Uint8Array ? prg : Uint8Array.from(prg);
  const lines = [];
  let p = 2;
  while (p + 4 <= data.length && data[p + 1] !== 0) {
    const number = data[p + 2] | (data[p + 3] << 8);
    p += 4;
    let end = p;
    while (end < data.length && data[end] !== 0) end++;
    lines.push(`${number} ${detokenizeLine(data.subarray(p, end), prep)}`);
    p = end + 1;
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}
