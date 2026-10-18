// zx81.js - the program files of the Sinclair ZX81: a .p file is the memory from $4009 (VERSN) up to
// E_LINE as the ROM saves it - the system variables, the BASIC program at $407D, the display file
// and the variables. The BASIC program is stored in the ZX81 character set with its keywords as
// tokens and every number literal followed by $7E and its value as a 5 byte float.
//
//   buildP(lines)        the .p file of tokenized lines [{ number, bytes }] (it runs its first line)
//   codeP(code, start)   machine code in a 1 REM line, started by 2 RAND USR start ($4082 and on)
//   tokenizeZx81(text)   a BASIC listing -> { ok, errors, bytes (the .p), lines }
//   detokenizeZx81(p)    a .p file -> its listing

export const PROGRAM = 0x407d;          // the first line of the program
export const REM_CODE = 0x4082;         // the first byte after '1 REM': where machine code in it starts

// the characters $00-$3F: space, the block graphics, " £ $ : ? ( ) > < = + - * / ; , . 0-9 A-Z
const CHARS = ' ▘▝▀▖▌▞▛▒🮎🮏"£$:?()><=+-*/;,.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CHAR_CODE = new Map([...CHARS].map((c, k) => [c, k]));
export const charOf = code => [...CHARS][code & 0x3f];

// the tokens: $40-$42 and $C0-$FF (as the ROM lists them, without their spaces)
export const TOKENS = {
  0x40: 'RND', 0x41: 'INKEY$', 0x42: 'PI',
  0xc0: '""', 0xc1: 'AT', 0xc2: 'TAB', 0xc4: 'CODE', 0xc5: 'VAL', 0xc6: 'LEN', 0xc7: 'SIN', 0xc8: 'COS', 0xc9: 'TAN',
  0xca: 'ASN', 0xcb: 'ACS', 0xcc: 'ATN', 0xcd: 'LN', 0xce: 'EXP', 0xcf: 'INT', 0xd0: 'SQR', 0xd1: 'SGN', 0xd2: 'ABS', 0xd3: 'PEEK',
  0xd4: 'USR', 0xd5: 'STR$', 0xd6: 'CHR$', 0xd7: 'NOT', 0xd8: '**', 0xd9: 'OR', 0xda: 'AND', 0xdb: '<=', 0xdc: '>=', 0xdd: '<>',
  0xde: 'THEN', 0xdf: 'TO', 0xe0: 'STEP', 0xe1: 'LPRINT', 0xe2: 'LLIST', 0xe3: 'STOP', 0xe4: 'SLOW', 0xe5: 'FAST', 0xe6: 'NEW',
  0xe7: 'SCROLL', 0xe8: 'CONT', 0xe9: 'DIM', 0xea: 'REM', 0xeb: 'FOR', 0xec: 'GOTO', 0xed: 'GOSUB', 0xee: 'INPUT', 0xef: 'LOAD',
  0xf0: 'LIST', 0xf1: 'LET', 0xf2: 'PAUSE', 0xf3: 'NEXT', 0xf4: 'POKE', 0xf5: 'PRINT', 0xf6: 'PLOT', 0xf7: 'RUN', 0xf8: 'SAVE',
  0xf9: 'RAND', 0xfa: 'IF', 0xfb: 'CLS', 0xfc: 'UNPLOT', 0xfd: 'CLEAR', 0xfe: 'RETURN', 0xff: 'COPY',
};
const NEWLINE = 0x76, NUMBER = 0x7e, REM = 0xea, QUOTE = 0x0b;
// the words, longest first; 'GO TO' and 'GO SUB' as the Spectrum writes them are GOTO and GOSUB
const WORDS = [...Object.entries(TOKENS).filter(([, w]) => /^[A-Z]/.test(w)).map(([t, w]) => [w, Number(t)]),
  ['GO TO', 0xec], ['GO SUB', 0xed]].sort((a, b) => b[0].length - a[0].length);
const OPERATORS = [['**', 0xd8], ['<=', 0xdb], ['>=', 0xdc], ['<>', 0xdd]];

// a number as the 5 bytes of the ZX81: the exponent + $80, then the mantissa (0.5 <= m < 1) in 4 bytes,
// big endian, its top bit (always 1) replaced by the sign; 0 is 5 zero bytes
export function float5(v) {
  if (!Number.isFinite(v)) throw new Error(`${v} is no number of the ZX81`);
  if (v === 0) return [0, 0, 0, 0, 0];
  let e = Math.floor(Math.log2(Math.abs(v))) + 1;
  let m = Math.abs(v) / 2 ** e;
  if (m >= 1) { m /= 2; e++; } else if (m < 0.5) { m *= 2; e--; }
  let mant = Math.round(m * 2 ** 32);
  if (mant >= 2 ** 32) { mant /= 2; e++; }
  if (e + 128 < 1 || e + 128 > 255) throw new Error(`${v} is out of the range of the ZX81`);
  const b = [mant >>> 24 & 0x7f | (v < 0 ? 0x80 : 0), mant >>> 16 & 255, mant >>> 8 & 255, mant & 255];
  return [e + 128, ...b];
}
export function fromFloat5([e, ...b]) {
  if (!e) return 0;
  const mant = ((b[0] | 0x80) * 2 ** 24) + b[1] * 2 ** 16 + b[2] * 2 ** 8 + b[3];
  return (b[0] & 0x80 ? -1 : 1) * mant / 2 ** 32 * 2 ** (e - 128);
}

const word = (a, v) => { a.push(v & 255, v >> 8 & 255); };

// the .p file of the lines; runs the line at `run` (an address, default: the first line), null: none
export function buildP(lines, { run = PROGRAM } = {}) {
  const prog = [];
  for (const l of lines) {
    prog.push(l.number >> 8, l.number & 255);
    word(prog, l.bytes.length + 1);
    prog.push(...l.bytes, NEWLINE);
  }
  const dfile = PROGRAM + prog.length;
  const display = new Array(25).fill(NEWLINE);      // a collapsed display: 24 empty lines
  const vars = dfile + display.length, eline = vars + 1;
  const sys = [];
  sys.push(0);                                       // $4009 VERSN
  word(sys, 0);                                      // $400A E_PPC
  word(sys, dfile); word(sys, dfile + 1);            // $400C D_FILE, $400E DF_CC
  word(sys, vars); word(sys, 0);                     // $4010 VARS, $4012 DEST
  word(sys, eline); word(sys, eline - 1);            // $4014 E_LINE, $4016 CH_ADD
  word(sys, 0);                                      // $4018 X_PTR
  word(sys, eline + 5); word(sys, eline + 5);        // $401A STKBOT, $401C STKEND
  sys.push(0);                                       // $401E BERG
  word(sys, 0x405d);                                 // $401F MEM: MEMBOT
  sys.push(0);                                       // $4021
  sys.push(2);                                       // $4022 DF_SZ
  word(sys, 0);                                      // $4023 S_TOP
  word(sys, 0xffff);                                 // $4025 LAST_K
  sys.push(0xff, 55);                                // $4027 DB_ST, $4028 MARGIN (50 Hz)
  word(sys, run ?? dfile);                           // $4029 NXTLIN: the line LOAD runs (D_FILE: none)
  word(sys, 0); sys.push(0); word(sys, 0);           // $402B OLDPPC, $402D FLAGX, $402E STRLEN
  word(sys, 0x0c8d); word(sys, 0); word(sys, 0xffff); // $4030 T_ADDR, $4032 SEED, $4034 FRAMES
  word(sys, 0); sys.push(0xbc);                      // $4036 COORDS, $4038 PR_CC
  sys.push(0x21, 0x18, 0x40);                        // $4039 S_POSN (column 33, line 24), $403B CDFLAG: SLOW
  sys.push(...new Array(32).fill(0), NEWLINE);       // $403C PRBUFF
  sys.push(...new Array(30).fill(0), 0, 0);          // $405D MEMBOT, $407B
  return Uint8Array.from([...sys, ...prog, ...display, 0x80]);
}

// machine code assembled for start ($4082 or higher): 1 REM <code> and 2 RAND USR exec
export function codeP(code, start = REM_CODE, exec = start) {
  if (start < REM_CODE) throw new Error(`ZX81 code starts at $4082 (16514) or higher, in the REM line: *= $4082 - this one at $${start.toString(16)}`);
  const rem = [REM, ...new Array(start - REM_CODE).fill(0), ...code];
  const usr = String(exec);
  const call = [0xf9, 0xd4, ...[...usr].map(c => CHAR_CODE.get(c)), NUMBER, ...float5(exec)];
  return buildP([{ number: 1, bytes: rem }, { number: 2, bytes: call }], { run: PROGRAM + 4 + rem.length + 1 });
}

// --- the BASIC listing ------------------------------------------------------------------------------

const isLetter = c => /[A-Za-z]/.test(c ?? '');
const NUM = /^(\d+\.?\d*|\.\d+)(E[+-]?\d+)?/i;

// one line of the listing (after its number) -> { bytes } or { error }
function lineBytes(body) {
  const out = [];
  let i = 0, inv = 0, rem = false, ident = false;
  const char = ch => {
    const c = CHAR_CODE.get(ch.toUpperCase());
    if (c == null) return `the ZX81 has no character "${ch}" (use {$xx} for its codes)`;
    out.push(c | inv);
    return null;
  };
  const escape = () => {
    const close = body.indexOf('}', i);
    if (close < 0) return { error: `unterminated escape "${body.slice(i, i + 12)}"` };
    const name = body.slice(i + 1, close).toLowerCase();
    i = close + 1;
    if (name === 'inv') inv = 0x80;
    else if (name === '/inv') inv = 0;
    else if (/^\$[0-9a-f]{2}$/.test(name)) out.push(parseInt(name.slice(1), 16));
    else return { error: `unknown escape {${name}} - {$xx}, {inv} and {/inv}` };
    return null;
  };
  while (i < body.length) {
    const ch = body[i];
    if (ch === '{') { const e = escape(); if (e) return e; continue; }
    if (rem) { const e = char(ch); if (e) return { error: e }; i++; continue; }
    if (ch === '"') {
      // a string: its characters, "" in it is the quote image
      out.push(QUOTE);
      i++;
      while (i < body.length) {
        if (body[i] === '"' && body[i + 1] === '"') { out.push(0xc0); i += 2; continue; }
        if (body[i] === '"') break;
        if (body[i] === '{') { const e = escape(); if (e) return e; continue; }
        const e = char(body[i]);
        if (e) return { error: e };
        i++;
      }
      if (i >= body.length) return { error: 'the string has no closing "' };
      out.push(QUOTE);
      i++;
      continue;
    }
    if (ch === ' ') { ident = false; i++; continue; }
    const rest = body.slice(i).toUpperCase();
    const op = OPERATORS.find(([o]) => rest.startsWith(o));
    if (op) { out.push(op[1]); i += op[0].length; ident = false; continue; }
    // a keyword or a number where no name goes on (A1, TOTAL are names)
    if (!ident) {
      const kw = WORDS.find(([w]) => rest.startsWith(w) && (w.endsWith('$') || !isLetter(rest[w.length])));
      if (kw) {
        out.push(kw[1]);
        i += kw[0].length;
        if (kw[1] === REM) { rem = true; if (body[i] === ' ') i++; }
        continue;
      }
      const n = NUM.exec(rest);
      if (n) {
        for (const c of n[0]) { const e = char(c); if (e) return { error: e }; }
        out.push(NUMBER, ...float5(Number(n[0])));
        i += n[0].length;
        continue;
      }
    }
    const e = char(ch);
    if (e) return { error: e };
    ident = isLetter(ch) || (ident && /\d/.test(ch));
    i++;
  }
  return { bytes: out };
}

// a listing -> { ok, errors, bytes: the .p file, lines: [{ src, number, addr }] }
export function tokenizeZx81(text) {
  const errors = [], lines = [];
  let prev = -1, addr = PROGRAM;
  String(text ?? '').split(/\r\n|\r|\n/).forEach((raw, idx) => {
    const src = idx + 1;
    if (/^\s*$/.test(raw)) return;
    const m = /^\s*(\d+)\s*/.exec(raw);
    if (!m) return void errors.push({ line: src, msg: 'missing line number' });
    const number = Number(m[1]);
    if (number < 1 || number > 9999) return void errors.push({ line: src, msg: `line number ${m[1]} out of range (1-9999)` });
    if (number <= prev) return void errors.push({ line: src, msg: `line number ${number} is not greater than the line before (${prev})` });
    prev = number;
    const body = raw.slice(m[0].length).trimEnd();
    if (!body) return void errors.push({ line: src, msg: `line ${number} is empty` });
    const r = lineBytes(body);
    if (r.error) return void errors.push({ line: src, msg: r.error });
    lines.push({ src, number, addr, bytes: r.bytes });
    addr += r.bytes.length + 5;
  });
  const bytes = errors.length ? null : buildP(lines);
  return { ok: !errors.length, errors, bytes, lines: lines.map(({ src, number, addr: a }) => ({ src, number, addr: a })) };
}

// a .p file -> the listing (the program from $407D to D_FILE)
export function detokenizeZx81(p) {
  const at = a => a - 0x4009;
  const dfile = p[at(0x400c)] | p[at(0x400c) + 1] << 8;
  const out = [];
  let k = at(PROGRAM);
  while (k + 4 <= at(dfile) && k < p.length) {
    const number = p[k] << 8 | p[k + 1], len = p[k + 2] | p[k + 3] << 8;
    const body = p.subarray(k + 4, k + 4 + len - 1);
    let s = '', quote = false, rem = false, inv = false;
    for (let j = 0; j < body.length; j++) {
      const c = body[j];
      if (c === NUMBER && !rem && !quote) { j += 5; continue; }
      if (!rem && !quote && TOKENS[c] && c >= 0xc0) {
        const w = TOKENS[c];
        s += /^[A-Z]/.test(w) ? `${s && !s.endsWith(' ') ? ' ' : ''}${w} ` : w;
        if (c === REM) rem = true;
        continue;
      }
      if (TOKENS[c]) { s += c === 0xc0 ? '""' : TOKENS[c]; continue; }
      const on = (c & 0x80) !== 0;
      if (on !== inv) { s += on ? '{inv}' : '{/inv}'; inv = on; }
      if ((c & 0x7f) >= 0x40) { s += `{$${c.toString(16).padStart(2, '0')}}`; continue; }
      if (c === QUOTE && !rem) quote = !quote;
      s += charOf(c);
    }
    if (inv) s += '{/inv}';
    out.push(`${number} ${s.trimEnd()}`);
    k += 4 + len;
  }
  return out.join('\n') + '\n';
}
