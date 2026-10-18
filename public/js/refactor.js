// refactor.js - renaming a label of an assembler source and every reference to it (the code editor: F2).
//
//   wordAt(text, caret)                        the name at the caret: { word, from, to } or null
//   renameInSource(text, old, next, opts)      -> { text, count }: every whole word old outside comments
//                                              and strings; opts: { lang: 'acme' | 'kickass', from, to }
//   localScope(text, offset, name)             where an ACME local label counts: [from, to]
//
// A global name is renamed in every source of its assembler; a local one of ACME in its own part of the
// file: .name in its !zone, @name between the global labels around it. A word is whole when no letter,
// digit, _, '.', '@', '$' or '%' is next to it: loop, not .loop, loop2, $c0de or %0101.

export function wordAt(text, caret) {
  const before = /[.@]?[A-Za-z_]\w*$/.exec(text.slice(0, caret))?.[0] ?? '';
  const after = /^\w*/.exec(text.slice(caret))[0];
  const word = before + after;
  if (!/^[.@]?[A-Za-z_]\w*$/.test(word)) return null;
  return { word, from: caret - before.length, to: caret + after.length };
}

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// the parts of the text that are code (not a comment, not a string): [[from, to]]
function codeRanges(text, lang) {
  const out = [];
  let i = 0, start = 0;
  const n = text.length;
  const push = to => { if (to > start) out.push([start, to]); };
  while (i < n) {
    const ch = text[i];
    if (ch === '"' || (ch === "'" && lang === 'acme' && text[i + 2] === "'")) {    // a string; ACME 'a' a character
      push(i);
      const close = text.indexOf(ch, i + 1);
      const eol = text.indexOf('\n', i + 1);
      i = close < 0 || (eol >= 0 && eol < close) ? (eol < 0 ? n : eol) : close + 1;
      start = i;
      continue;
    }
    if ((lang === 'acme' && ch === ';') || (lang === 'kickass' && ch === '/' && text[i + 1] === '/')) {
      push(i);
      const eol = text.indexOf('\n', i);
      i = eol < 0 ? n : eol;
      start = i;
      continue;
    }
    if (lang === 'kickass' && ch === '/' && text[i + 1] === '*') {
      push(i);
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? n : close + 2;
      start = i;
      continue;
    }
    i++;
  }
  push(n);
  return out;
}

export function renameInSource(text, old, next, { lang = 'acme', from = 0, to = text.length } = {}) {
  const re = new RegExp(`(?<![\\w.@$%])${escape(old)}(?!\\w)`, 'g');
  let out = '', at = 0, count = 0;
  for (const [a, b] of codeRanges(text, lang)) {
    const lo = Math.max(a, from), hi = Math.min(b, to);
    if (lo >= hi) continue;
    const part = text.slice(lo, hi).replace(re, () => { count++; return next; });
    out += text.slice(at, lo) + part;
    at = hi;
  }
  return { text: out + text.slice(at), count };
}

// the part of an ACME source a local label is known in: [from, to]
export function localScope(text, offset, name) {
  const lines = text.split('\n');
  const starts = [];
  let p = 0;
  for (const l of lines) { starts.push(p); p += l.length + 1; }
  const lineAt = starts.findLastIndex(s => s <= offset);
  // .name: its zone (from a !zone to the next); @name: from the global label before it to the next one
  const border = name.startsWith('.')
    ? l => /^\s*!(zone|zn)\b/i.test(l)
    : l => /^[A-Za-z_]\w*:?(\s|$)/.test(l) && !/^\s*!/.test(l);
  let a = lineAt;
  while (a > 0 && !border(lines[a])) a--;
  let b = lineAt + 1;
  while (b < lines.length && !border(lines[b])) b++;
  return [starts[a], b < lines.length ? starts[b] : text.length];
}
