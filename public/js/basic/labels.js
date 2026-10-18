// labels.js - the label mode of a BASIC program: no line numbers in the source, labels instead.
//
//   loop:                      a line of a name and ':' only: the label of the next line of code
//     print "hello"            a line of code: it gets its number when the program is built
//     goto loop                GOTO, GOSUB, THEN, ELSE, ON .. GOTO, RUN, LIST, RESTORE, TRAP, RESUME: a label
//
// resolveLabels() gives the program its numbers (10, 20, 30 ...: start and step), the line count stays,
// so an error or the debugger points at the line of the source; a line with a number of its own keeps
// it (the next ones count on from there). toLabels() and toNumbers() convert a program from one mode
// to the other (the label mode button of the code editor).

const LABEL_LINE = /^\s*([a-z_][\w]*)\s*:\s*$/i;
// the words a line number (a label) follows; a jump: a name after it must be a label
const WORDS = 'goto|go\\s*to|gosub|then|else|run|list|restore|trap|resume';
const JUMP = /^(goto|go\s*to|gosub)$/i;
const REFS = new RegExp(`(?<![a-z_])(${WORDS})(\\s*)([a-z_0-9][\\w]*(?:\\s*,\\s*[a-z_0-9][\\w]*)*)`, 'gi');

// the name of a label line, or null
export const labelOf = line => LABEL_LINE.exec(line)?.[1] ?? null;
const isCode = line => !/^\s*$/.test(line) && !/^\s*;/.test(line) && !labelOf(line);

// the labels of a program: [{ name, line }] (line: 1-based)
export function scanLabels(text) {
  const out = [];
  String(text).split('\n').forEach((l, i) => { const n = labelOf(l); if (n) out.push({ name: n, line: i + 1 }); });
  return out;
}

// the parts of a line outside its strings and its REM: fn(code) -> code
function mapCode(body, fn) {
  let out = '', rest = body;
  while (rest) {
    const q = rest.indexOf('"');
    const rem = /(?<![a-z_])rem/i.exec(rest);
    if (rem && (q < 0 || rem.index < q)) return out + fn(rest.slice(0, rem.index)) + rest.slice(rem.index);
    if (q < 0) return out + fn(rest);
    const end = rest.indexOf('"', q + 1);
    out += fn(rest.slice(0, q)) + (end < 0 ? rest.slice(q) : rest.slice(q, end + 1));
    rest = end < 0 ? '' : rest.slice(end + 1);
  }
  return out;
}

// the references in the code of a line: replace(word, name, isJump, after) -> text or null (stays)
function replaceRefs(code, replace) {
  return code.replace(REFS, (all, word, sp, list, at, whole) => {
    const after = whole.slice(at + all.length);
    // after THEN / ELSE a name followed by '=' or '(' is a statement (THEN A=1), no label
    if (!JUMP.test(word) && /^\s*[=(]/.test(after) && !list.includes(',')) return all;
    return word + sp + list.replace(/[a-z_0-9][\w]*/gi, name => replace(word, name, JUMP.test(word)) ?? name);
  });
}

// the program with its numbers: { text, errors: [{ line, msg }], labels: [{ name, line, number }] }
export function resolveLabels(text, { start = 10, step = 10 } = {}) {
  const lines = String(text).split('\n');
  const errors = [];
  // the numbers of the lines of code, and the labels: the number of the next line of code
  const numbers = new Array(lines.length).fill(null);
  let n = start - step;
  lines.forEach((l, i) => {
    if (!isCode(l)) return;
    const own = /^\s*(\d+)/.exec(l);
    if (own) {
      const v = Number(own[1]);
      if (v <= n) errors.push({ line: i + 1, msg: `line number ${v} is not greater than the line before (${n})` });
      n = Math.max(v, n + 1);
    } else n += step;
    numbers[i] = n;
  });
  const labels = [], byName = new Map();
  lines.forEach((l, i) => {
    const name = labelOf(l);
    if (!name) return;
    const at = numbers.findIndex((x, k) => k > i && x != null);
    if (at < 0) { errors.push({ line: i + 1, msg: `the label ${name} has no line of code after it` }); return; }
    const key = name.toLowerCase();
    if (byName.has(key)) { errors.push({ line: i + 1, msg: `the label ${name} is there twice (line ${byName.get(key).line} too)` }); return; }
    const label = { name, line: i + 1, number: numbers[at] };
    labels.push(label);
    byName.set(key, label);
  });
  const out = lines.map((l, i) => {
    if (numbers[i] == null) return labelOf(l) ? '' : l;
    const body = l.replace(/^\s*\d*\s*/, '');
    const code = mapCode(body, part => replaceRefs(part, (word, name, jump) => {
      if (/^\d+$/.test(name)) return null;
      const label = byName.get(name.toLowerCase());
      if (label) return String(label.number);
      if (jump) errors.push({ line: i + 1, msg: `there is no label ${name}` });
      return null;
    }));
    return `${numbers[i]} ${code}`;
  });
  return { text: out.join('\n'), errors, labels };
}

// a program with line numbers in the label mode: the lines a jump goes to get a label (l100 for 100),
// the numbers go
export function toLabels(text) {
  const lines = String(text).split('\n');
  const exists = new Set();
  for (const l of lines) { const m = /^\s*(\d+)/.exec(l); if (m) exists.add(Number(m[1])); }
  const targets = new Set();
  for (const l of lines) {
    mapCode(l.replace(/^\s*\d+/, ''), part => replaceRefs(part, (w, name) => { if (/^\d+$/.test(name) && exists.has(Number(name))) targets.add(Number(name)); return null; }));
  }
  const out = [];
  for (const l of lines) {
    const m = /^\s*(\d+)\s?(.*)$/.exec(l);
    if (!m) { out.push(l); continue; }
    if (targets.has(Number(m[1]))) out.push(`l${m[1]}:`);
    out.push(`  ${mapCode(m[2], part => replaceRefs(part, (w, name) => (/^\d+$/.test(name) && targets.has(Number(name)) ? `l${name}` : null)))}`);
  }
  return out.join('\n');
}

// the label the caret is in (its line, or a jump to it: GOTO LOOP, GOTOLOOP, ON X GOSUB A,B), or null
export function basicLabelAt(text, caret) {
  const t = String(text);
  const a = t.lastIndexOf('\n', caret - 1) + 1, e = t.indexOf('\n', caret);
  const line = t.slice(a, e < 0 ? t.length : e), col = caret - a;
  const own = labelOf(line);
  if (own) return own;
  const known = new Map(scanLabels(t).map(l => [l.name.toLowerCase(), l.name]));
  // the strings and REM as spaces: the places stay where they are
  const code = mapCode(line, part => part).replace(/"[^"]*"?/g, s => ' '.repeat(s.length));
  const rem = /(?<![a-z_])rem/i.exec(code);
  const plain = rem ? code.slice(0, rem.index) : code;
  for (const m of plain.matchAll(REFS)) {
    let at = m.index + m[1].length + m[2].length;
    for (const part of m[3].split(',')) {
      const name = part.trim(), from = at + part.indexOf(name);
      if (col >= from && col <= from + name.length && known.has(name.toLowerCase())) return known.get(name.toLowerCase());
      at += part.length + 1;
    }
  }
  return null;
}

// a label renamed: its line and every jump to it (case does not matter, as in BASIC) -> { text, count }
export function renameLabel(text, old, next) {
  let count = 0;
  const key = old.toLowerCase();
  const out = String(text).split('\n').map(l => {
    if (labelOf(l)?.toLowerCase() === key) { count++; return l.replace(/[a-z_]\w*/i, next); }
    if (!isCode(l)) return l;
    return mapCode(l, part => replaceRefs(part, (w, name) => (name.toLowerCase() === key ? (count++, next) : null)));
  });
  return { text: out.join('\n'), count };
}

// a program in the label mode with line numbers again: the labels go, the jumps get their numbers
// -> { text, errors }
export function toNumbers(text, opts) {
  const r = resolveLabels(text, opts);
  const src = String(text).split('\n');
  return { text: r.text.split('\n').filter((l, i) => !labelOf(src[i])).join('\n'), errors: r.errors };
}
