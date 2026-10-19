// typed.js - how long a BASIC line is to type in on the machine: the limit of its screen editor
// (Settings › Editor › BASIC and assembler per platform) is about the keys, not about the program.
//
// A BASIC of tokens (the Commodores: a .prg; the ZX81: a .p) stores a keyword as a token, and the keyword
// can be typed shorter than it is written: on a Commodore as its abbreviation - its first letters and
// the next one shifted ("pO" POKE, "goS" GOSUB), "?" PRINT - on the ZX81 as one key. A line written out
// in full may be too long for the editor and still be typed in: its length is the one with the shortest
// keywords. Strings, the text of REM and DATA count as they are; a {code} counts the keys it stands for.
//
// A BASIC of text (the listings of Atari BASIC to ENTER, of Locomotive, TRS-80 and BBC BASIC) is typed as
// it is written: every character counts.

import { DIALECTS } from './dialects.js';
import { parseControlCode } from './basic.js';

// the output of a dialect that holds tokens (basic/dialects.js output)
const TOKENS = new Set(['prg', 'zx81-p']);
export const tokenBased = dialect => TOKENS.has(DIALECTS[dialect]?.output);

// the keywords in the order the Commodore tokenizer tries them: the table of the one byte tokens, then
// the tables of two (BASIC 7, BASIC 65, Simons') - the first that matches is taken
function tableOrder(dialect) {
  const key = k => (Array.isArray(k.token) ? k.token[0] * 256 + k.token[1] + 0x10000 : k.token ?? 0x20000);
  return [...(DIALECTS[dialect]?.keywords ?? [])].filter(k => k.name && k.name !== '~').sort((a, b) => key(a) - key(b));
}

// the shortest way to type each keyword on a Commodore: name (lower case) -> keys. An abbreviation is the
// first n letters and the next one shifted; the tokenizer takes the first keyword of its table whose first
// n letters are those and whose next one is that letter - or one that is all of them, shorter
const cache = new Map();
function shortest(dialect) {
  if (cache.has(dialect)) return cache.get(dialect);
  const table = tableOrder(dialect).map(k => k.name.toLowerCase());
  const out = new Map();
  table.forEach((name, i) => {
    let best = name.length;
    for (let n = 1; n + 1 < name.length; n++) {
      if (!/[a-z]/.test(name[n])) continue;               // only a letter has a shifted one
      const prefix = name.slice(0, n);
      const first = table.findIndex(o => (o.length <= n ? prefix.startsWith(o) : o.startsWith(prefix) && o[n] === name[n]));
      if (first === i) { best = n + 1; break; }
    }
    if (!out.has(name)) out.set(name, best);
  });
  if (out.has('print')) out.set('print', 1);              // ?
  cache.set(dialect, out);
  return out;
}

// the keywords by their first character, each list in the order of the table (a line is read at every
// letter: not the whole table each time)
const firsts = new Map();
function firstLetters(dialect) {
  if (!firsts.has(dialect)) {
    const m = new Map();
    for (const name of tableOrder(dialect).map(k => k.name.toLowerCase())) (m.get(name[0]) ?? m.set(name[0], []).get(name[0])).push(name);
    firsts.set(dialect, m);
  }
  return firsts.get(dialect);
}

// the line in pieces as they are typed: step(from, to, keys) for the text line[from, to) that takes `keys`
// keys - the spaces around the line are none
function walk(line, dialect, step) {
  const from = line.length - line.trimStart().length, end = line.trimEnd().length;
  if (!tokenBased(dialect)) {
    // a text BASIC: as written, a character a key
    for (let i = from; i < end; i++) step(i, i + 1, 1);
    return;
  }
  const zx = DIALECTS[dialect]?.output === 'zx81-p';
  const byFirst = firstLetters(dialect);
  const keys = zx ? null : shortest(dialect);
  const low = line.toLowerCase();
  let inString = false, raw = false, data = false;
  for (let i = from; i < end;) {
    const ch = line[i];
    if (raw || inString || data) {
      if (ch === '"' && !raw) inString = !inString;
      else if (ch === ':' && data && !inString) { data = false; step(i, i + 1, 1); i++; continue; }
      // a {code} of a string: the keys it stands for
      const c = inString && ch === '{' ? parseControlCode(line, i, dialect) : null;
      if (c && !c.error) { step(i, c.end, c.bytes.length); i = c.end; continue; }
      step(i, i + 1, 1);
      i++;
      continue;
    }
    if (ch === '"') { inString = true; step(i, i + 1, 1); i++; continue; }
    const k = byFirst.get(low[i])?.find(name => low.startsWith(name, i));
    if (!k) { step(i, i + 1, 1); i++; continue; }
    step(i, i + k.length, zx ? 1 : keys.get(k) ?? k.length);
    i += k.length;
    if (k === 'rem') raw = true;
    if (k === 'data') data = true;
  }
}

// the keys of a line of a dialect (the line number too, not the spaces around the line)
export function typedLength(line, dialect) {
  let n = 0;
  walk(line, dialect, (a, b, keys) => { n += keys; });
  return n;
}

// the column of the line where it passes `max` keys - the first piece that does not fit; null: it fits.
// The editor asks for every line at every key: the answers are kept
const columns = new Map();
export function limitColumn(line, max, dialect) {
  if (line.length <= max && !line.includes('{')) return null;   // a key is a character at least - but {20 right}
  const key = `${dialect}\u0000${max}\u0000${line}`;
  if (columns.has(key)) return columns.get(key);
  let n = 0, at = null;
  walk(line, dialect, (a, b, keys) => { n += keys; if (at === null && n > max) at = a; });
  if (columns.size > 5000) columns.clear();
  columns.set(key, at);
  return at;
}
