// lang-acme.js - the ACME assembler language for the code editor (codeeditor.js): colours,
// definitions of a source, and autocompletion of mnemonics, pseudo ops, labels and macros.
//
// The mnemonics and pseudo ops with their descriptions come from acme/docs.js, the data the
// assembler itself is made of. The labels come from the sources of the project (scanDefinitions)
// and from the symbols of the last assembly.

import * as docs from './acme/docs.js';
import { spans, filterItems } from './codeeditor.js';
import { mnemonicDoc, registerDoc, asmHelp } from './cpudocs.js';

// --- the data of the assembler, whatever form docs.js gives it --------------------------------

const asItem = x => (typeof x === 'string' ? { name: x } : x);

export function mnemonics(cpu = '6502') {
  const m = docs.MNEMONICS ?? [];
  const list = Array.isArray(m) ? m : (m[cpu] ?? m['6502'] ?? Object.values(m)[0] ?? []);
  return (Array.isArray(list) ? list : Object.entries(list).map(([name, v]) => ({ name, ...(typeof v === 'string' ? { desc: v } : v) }))).map(asItem);
}
export function pseudoOps() {
  const p = docs.PSEUDO_OPS ?? [];
  const list = Array.isArray(p) ? p : Object.entries(p).map(([name, v]) => ({ name, ...(typeof v === 'string' ? { desc: v } : v) }));
  return list.map(asItem).map(x => ({ ...x, name: x.name.startsWith('!') ? x.name : '!' + x.name }));
}
export function cpus() {
  const c = docs.CPUS ?? ['6502', 'nmos6502', '6510', '65c02', 'r65c02', 'w65c02'];
  return (Array.isArray(c) ? c : Object.keys(c)).map(x => (typeof x === 'string' ? x : x.name));
}

let mnemonicSet = null, mnemonicCpu = null;
function isMnemonic(word, cpu) {
  if (mnemonicCpu !== cpu) { mnemonicSet = new Set(mnemonics(cpu).map(x => x.name.toLowerCase())); mnemonicCpu = cpu; }
  return mnemonicSet.has(word.toLowerCase());
}

// --- tokens -----------------------------------------------------------------------------

const NUM = /^(\$[0-9a-fA-F]+|0x[0-9a-fA-F]+|%[01.#]+|&[0-7]+|\d+(\.\d+)?)/;
const IDENT = /^[.@]?[A-Za-z_][\w]*/;

// the tokens of one line: [{ cls, text }]
export function lineTokens(line, cpu = '6502') {
  const out = [];
  let k = 0, statement = true;            // statement: the next word may be a mnemonic or a pseudo op
  const push = (cls, text) => { out.push({ cls, text }); k += text.length; };
  // a label at the start of the line
  const lead = /^([.@]?[A-Za-z_][\w]*|[+-]+)(?=[\s:=;]|$)/.exec(line);
  if (lead && !isMnemonic(lead[1], cpu)) { push('tok-name', lead[1]); }
  while (k < line.length) {
    const rest = line.slice(k);
    const ch = rest[0];
    if (ch === ';') { push('tok-comment', rest); break; }
    if (/\s/.test(ch)) { push(null, /^\s+/.exec(rest)[0]); continue; }
    if (ch === '"' || ch === "'") {
      const m = new RegExp(`^${ch}(\\\\.|[^${ch}\\\\])*${ch}?`).exec(rest);
      push('tok-str', m[0]); statement = false; continue;
    }
    if (ch === ':') { push(null, ':'); statement = true; continue; }
    if (ch === '!' && /^![A-Za-z]/.test(rest)) { push('tok-flow', /^![A-Za-z0-9]+/.exec(rest)[0]); statement = false; continue; }
    if (ch === '*' && statement && /^\*\s*=/.test(rest)) { push('tok-flow', '*'); statement = false; continue; }
    if (ch === '+' && statement && /^\+[A-Za-z_]/.test(rest)) { push('tok-event', /^\+[\w.]+/.exec(rest)[0]); statement = false; continue; }
    if (ch === '{' || ch === '}' || ch === '(' || ch === ')' || ch === '[' || ch === ']') { push('tok-bracket', ch); if (ch === '{' || ch === '}') statement = true; continue; }
    if (ch === '#') { push('tok-op', '#'); continue; }
    const num = NUM.exec(rest);
    if (num && !(ch === '%' && !statement && /^%[^01.#]/.test(rest))) { push('tok-num', num[0]); statement = false; continue; }
    const id = IDENT.exec(rest);
    if (id) {
      let w = id[0];
      if (/^af$/i.test(w) && rest[2] === "'") { push('tok-sym', "af'"); statement = false; continue; }   // the Z80's shadow AF
      if (statement && isMnemonic(w, cpu)) {
        push('tok-kw', w);
        const size = /^\+[12]/.exec(line.slice(k));        // lda+2: the size forced
        if (size) push('tok-kw', size[0]);
      } else push(/^[xy]$/i.test(w) && /,\s*$/.test(line.slice(0, k)) ? 'tok-kw' : 'tok-sym', w);
      statement = false;
      continue;
    }
    push(null, ch);
  }
  return out;
}

export function highlight(text, cpu = '6502') {
  const out = [];
  const lines = text.split('\n');
  lines.forEach((l, i) => { out.push(...lineTokens(l, cpu)); if (i < lines.length - 1) out.push({ cls: null, text: '\n' }); });
  return spans(out);
}

// --- definitions -----------------------------------------------------------------------------

// the labels, constants, macros and zones a source defines: [{ name, kind, line, value? }]
export function scanDefinitions(text, cpu = '6502') {
  const out = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/;.*$/, '');
    const line1 = i + 1;
    let m = /^\s*!macro\s+([A-Za-z_][\w.]*)\s*(.*?)\s*\{?\s*$/i.exec(line);
    if (m) { out.push({ name: m[1], kind: 'macro', line: line1, params: m[2] }); return; }
    m = /^\s*!(?:zone|zn)\s+([A-Za-z_][\w]*)/i.exec(line);
    if (m) { out.push({ name: m[1], kind: 'zone', line: line1 }); }
    m = /^\s*!set\s+([A-Za-z_][\w]*)\s*=\s*(.*)$/i.exec(line);
    if (m) { out.push({ name: m[1], kind: 'const', line: line1, value: m[2].trim() }); return; }
    m = /^\s*([.@]?[A-Za-z_][\w]*)\s*=\s*([^=].*)$/.exec(line);
    if (m && !isMnemonic(m[1], cpu)) { out.push({ name: m[1], kind: 'const', line: line1, value: m[2].trim() }); return; }
    m = /^([.@]?[A-Za-z_][\w]*):?(?=\s|$)/.exec(line);
    if (m && !isMnemonic(m[1], cpu)) out.push({ name: m[1], kind: 'label', line: line1 });
  });
  return out;
}

// --- completion ---------------------------------------------------------------------------------

const hex = n => '$' + n.toString(16).padStart(n > 0xff ? 4 : 2, '0');

// ctx: { cpu(), machine() (the registers of its chips), definitions() -> [{ name, kind, file, line, value }] of the whole project,
//        symbols() -> [{ name, value }] of the last assembly }
export function acmeLanguage(ctx = {}) {
  const cpu = () => ctx.cpu?.() ?? '6502';
  return {
    comment: ';',
    autoTrigger: ch => ch === '!' || ch === '+',
    highlight: text => highlight(text, cpu()),
    complete(text, caret, { force } = {}) {
      const lineFrom = text.lastIndexOf('\n', caret - 1) + 1;
      const before = text.slice(lineFrom, caret);
      if (/;/.test(before.replace(/"[^"]*"|'[^']*'/g, ''))) return null;      // in a comment
      if ((before.match(/"/g) ?? []).length % 2) return null;                   // in a string
      const word = /[!+]?[.@]?[\w]*$/.exec(before)[0];
      const from = caret - word.length;
      const head = before.slice(0, before.length - word.length);
      // where a statement starts: at the start of the line after the indent or a label, after ':' or '{'
      // (a word before is a label - unless it is a mnemonic: then this is its operand)
      const lead = /^\s*([.@]?[A-Za-z_]\w*)(\+[12])?:?\s+$/.exec(head);
      const statement = lead ? !isMnemonic(lead[1], cpu()) : /^\s*$|^[+-]+\s+$|[:{]\s*$/.test(head);
      const defs = ctx.definitions?.() ?? [];
      const syms = ctx.symbols?.() ?? [];
      // after !cpu: the processors
      if (/!cpu\s+$/i.test(head)) return { from, to: caret, items: filterItems(cpus().map(c => ({ label: c, kind: 'cpu' })), word) };
      // after !to "file",
      if (/!to\s+"[^"]*"\s*,\s*$/i.test(head)) return { from, to: caret, items: filterItems(['cbm', 'plain', 'apple'].map(c => ({ label: c, kind: 'pseudo' })), word) };
      const items = [];
      if (word.startsWith('!') || (statement && !word.startsWith('+') && force)) {
        for (const p of pseudoOps()) items.push({ label: p.name, kind: 'pseudo', detail: p.desc, syntax: p.syntax });
      }
      if (word.startsWith('+')) {
        for (const d of defs.filter(x => x.kind === 'macro')) items.push({ label: '+' + d.name, kind: 'macro', hint: d.params || '', detail: `macro ${d.name} ${d.params ?? ''} - ${d.file ?? ''}:${d.line}` });
        return { from, to: caret, items: filterItems(items, word), open: true };
      }
      if (statement && !word.startsWith('!')) {
        // the modes with their opcodes, bytes and cycles, and the flags they change (cpudocs.js)
        for (const m of mnemonics(cpu())) items.push({ label: m.name.toLowerCase(), kind: 'mnemonic', detail: m.desc, doc: mnemonicDoc(cpu(), m.name, m.desc) });
      }
      // in the operand of an instruction: its doc, the bits of the register it addresses, the registers at $..
      const machine = ctx.machine?.();
      const value = name => syms.find(s => s.name === name)?.value ?? (v => (v && /^\$[0-9a-f]+$/i.test(v) ? parseInt(v.slice(1), 16) : /^\d+$/.test(v ?? '') ? Number(v) : null))(defs.find(d => d.name === name)?.value?.trim());
      const help = statement ? null : asmHelp({ before, caret, cpu: cpu(), machine, isMnemonic: w => isMnemonic(w, cpu()), valueOf: value });
      if (help?.hex) return { from: help.hex.from, to: caret, items: help.hex.items, info: help.info, open: help.hex.typed.length > 2 };
      if (!statement || force) {
        const seen = new Set();
        const add = (name, kind, detail, v) => {
          if (seen.has(name)) return;
          seen.add(name);
          const doc = v != null ? registerDoc(machine, v) : null;          // a label of a register: its bits
          items.push({ label: name, kind, detail, ...(doc ? { doc } : {}) });
        };
        for (const s of syms) add(s.name, 'label', `${s.name} = ${hex(s.value)}`, s.value);
        for (const d of defs) if (d.kind !== 'macro' && d.kind !== 'zone') add(d.name, d.kind === 'const' ? 'const' : 'label', `${d.kind} ${d.name}${d.value ? ' = ' + d.value : ''} - ${d.file ?? ''}:${d.line}`, value(d.name));
      }
      // the word itself is no suggestion (the label being typed counts as a definition of it already)
      const list = filterItems(items, word).filter(x => x.label !== word || x.kind === 'mnemonic' || x.kind === 'pseudo');
      return { from, to: caret, items: list, open: word.startsWith('!'), info: help?.info };
    },
  };
}
