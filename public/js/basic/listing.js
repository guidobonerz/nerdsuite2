// Text-listing output for non-Commodore dialects (no tokenized binaries):
//   atari / turbo -> ATASCII listing loadable with ENTER "D:..." (EOL = $9B)
//   loco          -> CPC ASCII file as written by SAVE "x",A (CR LF, terminated by $1A)

/** ATASCII escape names (inside strings/REM; {$xx} works everywhere). {inv}...{/inv} sets bit 7. */
export const ATASCII_CODES = [
  { name: 'clear', code: 0x7d, desc: 'clear screen' },
  { name: 'up', code: 0x1c, desc: 'cursor up' },
  { name: 'down', code: 0x1d, desc: 'cursor down' },
  { name: 'left', code: 0x1e, desc: 'cursor left' },
  { name: 'right', code: 0x1f, desc: 'cursor right' },
  { name: 'esc', code: 0x1b, desc: 'escape (print next control char literally)' },
  { name: 'bell', code: 0xfd, desc: 'buzzer' },
  { name: 'bs', code: 0x7e, desc: 'backspace / delete char' },
  { name: 'tab', code: 0x7f, desc: 'tab' },
  { name: 'insert', code: 0xff, desc: 'insert char' },
  { name: 'delete', code: 0xfe, desc: 'delete char' },
  { name: 'delline', code: 0x9c, desc: 'delete line' },
  { name: 'insline', code: 0x9d, desc: 'insert line' },
  { name: 'clrtab', code: 0x9e, desc: 'clear tab stop' },
  { name: 'settab', code: 0x9f, desc: 'set tab stop' },
  { name: 'inv', code: -1, desc: 'start inverse video (sets bit 7)' },
  { name: '/inv', code: -1, desc: 'end inverse video' },
];
const ATASCII_BY_NAME = new Map(ATASCII_CODES.filter((c) => c.code >= 0).map((c) => [c.name, c.code]));
const ATASCII_BY_CODE = new Map(ATASCII_CODES.filter((c) => c.code >= 0).map((c) => [c.code, c.name]));

const FORMATS = { 'atascii-lst': 'atari', 'cpc-ascii': 'cpc' };

function parseEscape(s, i, atari) {
  const close = s.indexOf('}', i + 1);
  if (close < 0) return { error: `unterminated escape "${s.slice(i, i + 12)}"` };
  const name = s.slice(i + 1, close).toLowerCase();
  const end = close + 1;
  const m = /^\$([0-9a-f]{2})$/.exec(name);
  if (m) return { code: parseInt(m[1], 16), end };
  if (atari) {
    if (name === 'inv') return { inv: true, end };
    if (name === '/inv') return { inv: false, end };
    if (ATASCII_BY_NAME.has(name)) return { code: ATASCII_BY_NAME.get(name), end };
  }
  return { error: `unknown escape {${s.slice(i + 1, close)}}` };
}

/** Atari: everything outside strings, REM and DATA is uppercased (Atari BASIC only accepts uppercase). */
function atariLine(body) {
  const out = [];
  let quote = false;
  let literal = false; // after REM / DATA: rest of line verbatim
  let inv = false;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '{') {
      const r = parseEscape(body, i, true);
      if (r.error) return r;
      if (r.inv !== undefined) inv = r.inv;
      else out.push(r.code);
      i = r.end;
      continue;
    }
    const c = ch.charCodeAt(0);
    if (c < 0x20 || c > 0x7e) return { error: `unsupported character "${ch}" (use {$xx})` };
    if (!quote && !literal) {
      // statement start: beginning, after ':' or THEN
      const before = String.fromCharCode(...out).trimEnd();
      if (before === '' || before.endsWith(':') || /THEN$/.test(before)) {
        const kw = /^(rem|data)/i.exec(body.slice(i));
        if (kw) {
          for (const k of kw[1].toUpperCase()) out.push(k.charCodeAt(0));
          i += kw[1].length;
          literal = true;
          continue;
        }
      }
    }
    if (ch === '"' && !literal) {
      quote = !quote;
      out.push(0x22);
    } else if (!quote && !literal) {
      out.push(ch.toUpperCase().charCodeAt(0));
    } else {
      out.push(inv ? c | 0x80 : c);
    }
    i++;
  }
  if (out.includes(0x9b)) return { error: 'EOL character ($9B) is not allowed inside a line' };
  return { bytes: out };
}

/** CPC: keywords outside strings/REM/'/DATA are uppercased, variables keep their case. */
function cpcLine(body, words) {
  const out = [];
  let quote = false;
  let rem = false;
  let data = false;
  let i = 0;
  const push = (s) => { for (const ch of s) out.push(ch.charCodeAt(0)); };
  while (i < body.length) {
    const ch = body[i];
    if (ch === '{') {
      const r = parseEscape(body, i, false);
      if (r.error) return r;
      out.push(r.code);
      i = r.end;
      continue;
    }
    const c = ch.charCodeAt(0);
    if (c < 0x20 || c > 0x7e) return { error: `unsupported character "${ch}" (use {$xx})` };
    if (!quote && !rem && !data) {
      const m = /^[a-z][a-z0-9.]*[$%!]?/i.exec(body.slice(i));
      if (m) {
        const word = m[0];
        const lower = word.toLowerCase();
        const isKw = words.has(lower);
        push(isKw ? word.toUpperCase() : word);
        if (isKw && lower === 'rem') rem = true;
        if (isKw && lower === 'data') data = true;
        i += word.length;
        continue;
      }
      if (ch === "'") rem = true;
    }
    if (ch === '"' && !rem) quote = !quote;
    if (ch === ':' && !quote) data = false;
    out.push(c);
    i++;
  }
  if (out.some((b) => b === 0x0d || b === 0x0a || b === 0x1a)) return { error: 'CR, LF and $1A are not allowed inside a line' };
  return { bytes: out };
}

const wordCache = new WeakMap();
function keywordWords(def) {
  if (!wordCache.has(def)) {
    const set = new Set();
    for (const kw of def.keywords) for (const part of kw.name.toLowerCase().split(' ')) if (/^[a-z]/.test(part)) set.add(part);
    wordCache.set(def, set);
  }
  return wordCache.get(def);
}

/** tokenize() for dialects with def.output !== 'prg'. */
export function tokenizeListing(text, def) {
  const atari = def.output === 'atascii-lst';
  const words = atari ? null : keywordWords(def);
  const maxBytes = atari ? 120 : 255;
  const errors = [];
  const lines = [];
  const bytes = [];
  let prev = -1;
  String(text ?? '').split(/\r\n|\r|\n/).forEach((raw, idx) => {
    const lineNo = idx + 1;
    if (/^\s*$/.test(raw)) return;
    const m = /^\s*(\d+)/.exec(raw);
    if (!m) return void errors.push({ line: lineNo, msg: 'missing line number' });
    const number = parseInt(m[1], 10);
    if (m[1].length > 5 || number < def.minLine || number > def.maxLine) {
      return void errors.push({ line: lineNo, msg: `line number ${m[1]} out of range (${def.minLine}-${def.maxLine})` });
    }
    if (number === prev) return void errors.push({ line: lineNo, msg: `duplicate line number ${number}` });
    if (number < prev) {
      return void errors.push({ line: lineNo, msg: `line number ${number} is not greater than previous line ${prev}` });
    }
    prev = number;
    const body = raw.slice(m[0].length).replace(/^\s+/, '').replace(/\s+$/, '');
    if (!body) return void errors.push({ line: lineNo, msg: `line ${number} is empty` });
    const r = atari ? atariLine(body) : cpcLine(body, words);
    if (r.error) return void errors.push({ line: lineNo, msg: r.error });
    const lineBytes = [...Array.from(`${number} `, (ch) => ch.charCodeAt(0)), ...r.bytes];
    if (lineBytes.length > maxBytes) {
      return void errors.push({ line: lineNo, msg: `line ${number} too long (${lineBytes.length} chars, max ${maxBytes})` });
    }
    lines.push({ src: lineNo, number, addr: bytes.length });
    bytes.push(...lineBytes, ...(atari ? [0x9b] : [0x0d, 0x0a]));
  });
  if (!atari) bytes.push(0x1a);
  return {
    ok: errors.length === 0, errors, prg: null, listing: Uint8Array.from(bytes), format: def.output, start: null, lines,
  };
}

const hex = (c) => `{$${c.toString(16).padStart(2, '0')}}`;

/** detokenize() for listing formats: decodes the bytes back to editable text. */
export function detokenizeListing(data, def) {
  const atari = FORMATS[def.output] === 'atari';
  const out = [];
  let line = '';
  let inv = false;
  const flush = () => {
    if (inv) { line += '{/inv}'; inv = false; }
    if (line !== '') out.push(line);
    line = '';
  };
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (atari) {
      if (c === 0x9b) { flush(); continue; }
      const base = c & 0x7f;
      const printable = (x) => x >= 0x20 && x <= 0x7a && x !== 0x7b; // '{' is reserved for escapes
      if (ATASCII_BY_CODE.has(c)) {
        if (inv) { line += '{/inv}'; inv = false; }
        line += `{${ATASCII_BY_CODE.get(c)}}`;
      } else if (c >= 0x80 && printable(base) && base !== 0x22) {
        if (!inv) { line += '{inv}'; inv = true; }
        line += String.fromCharCode(base);
      } else {
        if (inv) { line += '{/inv}'; inv = false; }
        line += c < 0x80 && (printable(c) || c === 0x7c) ? String.fromCharCode(c) : hex(c);
      }
    } else {
      if (c === 0x1a) break;
      if (c === 0x0d || c === 0x0a) {
        if (c === 0x0d && data[i + 1] === 0x0a) i++;
        flush();
        continue;
      }
      line += c >= 0x20 && c <= 0x7e && c !== 0x7b ? String.fromCharCode(c) : hex(c);
    }
  }
  flush();
  return out.length ? out.join('\n') + '\n' : '';
}
