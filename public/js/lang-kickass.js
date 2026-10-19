// lang-kickass.js - the language of KickAssembler for the code editor (codeeditor.js): colours,
// the definitions of a source, and the completion of mnemonics, directives (.byte, .macro ...),
// preprocessor directives (#import ...), the library (LoadBinary, sin, BLACK ...) and the labels,
// constants, macros, functions and pseudo commands of the project.
//
// The directives and the library are those the installed KickAssembler reports (-asminfo, made
// into kickass/docs.js by tools/kickass-docs.mjs); the mnemonics those of the assembler (acme/docs.js).

import { DIRECTIVES, PPDIRECTIVES, LIBRARY } from './kickass/docs.js';
import { mnemonics } from './lang-acme.js';
import { spans, filterItems } from './codeeditor.js';
import { mnemonicDoc, registerDoc, asmHelp, asmHover } from './cpudocs.js';

// the CPUs of .cpu, and the macros KickAssembler includes by itself (autoinclude.asm)
export const CPUS = ['_6502NoIllegals', '_6502', 'dtv', '_65c02'];
const AUTO_MACROS = [
  { name: 'BasicUpstart', params: 'address', desc: 'A BASIC line 10 SYS address at the start of BASIC ($0801).' },
  { name: 'BasicUpstart2', params: 'label', desc: 'BasicUpstart in a segment of its own at $0801: SYS to the label.' },
];
// the CPU of the KickAssembler mnemonics: _6502 (default without illegals) - completion offers the 6510 set
const cpuOf = cpu => (cpu === '_6502' || cpu === '6510' ? '6510' : cpu === '_65c02' || cpu === '65c02' ? '65c02' : '6502');

let mnemonicSet = null;
const isMnemonic = w => {
  mnemonicSet ??= new Set(mnemonics('6510').concat(mnemonics('65c02')).map(m => m.name.toLowerCase()));
  return mnemonicSet.has(w.toLowerCase());
};

// --- tokens ---------------------------------------------------------------------------------------

const NUM = /^(\$[0-9a-fA-F]+|%[01]+|\d+(\.\d+)?)/;

// the tokens of the whole text: a /* comment */ may run over lines
export function tokens(text) {
  const out = [];
  let k = 0, statement = true;
  const push = (cls, t) => { out.push({ cls, text: t }); k += t.length; };
  while (k < text.length) {
    const rest = text.slice(k), ch = rest[0];
    if (ch === '\n') { push(null, '\n'); statement = true; continue; }
    if (rest.startsWith('//')) { push('tok-comment', /^\/\/[^\n]*/.exec(rest)[0]); continue; }
    if (rest.startsWith('/*')) { const end = rest.indexOf('*/'); push('tok-comment', end < 0 ? rest : rest.slice(0, end + 2)); continue; }
    if (/[ \t]/.test(ch)) { push(null, /^[ \t]+/.exec(rest)[0]); continue; }
    if (ch === '"' || (ch === '@' && rest[1] === '"')) { const m = /^@?"(\\.|[^"\\\n])*"?/.exec(rest); push('tok-str', m[0]); statement = false; continue; }
    if (ch === '#' && statement && /^#[a-z]/i.test(rest)) { push('tok-flow', /^#\w+/.exec(rest)[0]); statement = false; continue; }
    if (ch === '#') { push('tok-op', '#'); continue; }
    if (ch === '.' && /^\.[a-z]/i.test(rest) && (statement || /[=\s:]$/.test(text.slice(Math.max(0, k - 1), k)))) {
      push('tok-flow', /^\.\w+/.exec(rest)[0]); statement = false; continue;
    }
    if (ch === '!' && /^![\w]*[:+-]/.test(rest)) {          // multi labels: !loop: and the references !loop+ !-
      const m = /^![\w]*(:|[+-]+)/.exec(rest);
      push(m[1] === ':' ? 'tok-name' : 'tok-sym', m[0]);
      if (m[1] === ':') statement = true;
      continue;
    }
    if (ch === '*' && statement && /^\*\s*=/.test(rest)) { push('tok-flow', '*'); statement = false; continue; }
    if ('{}()[]'.includes(ch)) { push('tok-bracket', ch); if (ch === '{' || ch === '}') statement = true; continue; }
    if (ch === ':' ) { push(null, ':'); statement = true; continue; }
    const num = NUM.exec(rest);
    if (num && !/^%[^01]/.test(rest)) { push('tok-num', num[0]); statement = false; continue; }
    const id = /^[A-Za-z_][\w]*/.exec(rest);
    if (id) {
      const w = id[0], after = rest.slice(w.length);
      if (/^:/.test(after) && statement) { push('tok-name', w); continue; }                    // a label
      if (statement && isMnemonic(w)) {
        push('tok-kw', w);
        const sfx = /^\.(zp|z|abs|a|im|i)\b/i.exec(text.slice(k));                             // lda.abs
        if (sfx) push('tok-kw', sfx[0]);
      } else push(/^\s*\(/.test(after) ? 'tok-event' : 'tok-sym', w);                              // a call
      statement = false;
      continue;
    }
    push(null, ch);
  }
  return out;
}

export const highlight = text => spans(tokens(text));

// --- definitions ------------------------------------------------------------------------------------

// what a source defines: [{ name, kind: 'label'|'const'|'macro'|'function'|'zone', line, value?, params? }]
export function scanDefinitions(text) {
  const out = [];
  let inComment = false;
  text.split('\n').forEach((raw, i) => {
    let line = raw;
    if (inComment) { const e = line.indexOf('*/'); if (e < 0) return; line = line.slice(e + 2); inComment = false; }
    line = line.replace(/\/\*.*?\*\//g, '');
    const open = line.indexOf('/*');
    if (open >= 0) { line = line.slice(0, open); inComment = true; }
    line = line.replace(/\/\/.*$/, '');
    const n = i + 1;
    let m;
    if ((m = /^\s*\.(macro|function|pseudocommand)\s+([A-Za-z_]\w*)\s*\(?([^){]*)/.exec(line))) {
      out.push({ name: m[2], kind: m[1] === 'macro' ? 'macro' : m[1] === 'function' ? 'function' : 'macro', line: n, params: m[3].trim(), pseudo: m[1] === 'pseudocommand' });
      return;
    }
    if ((m = /^\s*\.(namespace|filenamespace)\s+([A-Za-z_]\w*)/.exec(line))) { out.push({ name: m[2], kind: 'zone', line: n }); return; }
    if ((m = /^\s*\.(label|const|var|enum)\s+([A-Za-z_]\w*)\s*=\s*([^\n]*)/.exec(line))) { out.push({ name: m[2], kind: 'const', line: n, value: m[3].trim() }); return; }
    for (const l of line.matchAll(/(?:^|[\s{])([A-Za-z_]\w*):(?!:)/g)) out.push({ name: l[1], kind: 'label', line: n });
  });
  return out;
}

// --- completion ---------------------------------------------------------------------------------------

const hex = n => '$' + n.toString(16).padStart(n > 0xff ? 4 : 2, '0');

// ctx: { cpu(), definitions() -> [{ name, kind, file, line, value, params }], symbols() -> [{ name, value }] }
export function kickassLanguage(ctx = {}) {
  return {
    comment: '//',
    autoTrigger: ch => ch === '.' || ch === '#',
    highlight,
    // Shift and the mouse: the instruction, the directive, the number or the symbol under the pointer
    hover(text, at) {
      const defs = ctx.definitions?.() ?? [], syms = ctx.symbols?.() ?? [];
      const directive = w => {
        const d = [...DIRECTIVES, ...PPDIRECTIVES].find(x => x.name === w);
        if (d) return { title: d.name, syntax: d.example, desc: d.desc };
        const l = LIBRARY.find(x => x.name === w);
        return l ? { title: l.name, syntax: l.kind === 'function' ? `${l.name}(${l.args.join(' / ')})` : l.name, desc: `${l.lib} ${l.kind}` } : null;
      };
      return asmHover(text, at, {
        cpu: cpuOf(ctx.cpu?.()), machine: ctx.machine?.(), isMnemonic, comment: '//', pseudo: directive,
        valueOf: name => syms.find(s => s.name === name)?.value ?? null,
        whereOf: name => { const d = defs.find(x => x.name === name); return d ? `${d.kind} ${d.name}${d.value ? ' = ' + d.value : ''} - ${d.file ?? ''}:${d.line}` : null; },
      });
    },
    complete(text, caret, { force } = {}) {
      const lineFrom = text.lastIndexOf('\n', caret - 1) + 1;
      const before = text.slice(lineFrom, caret);
      if (/\/\//.test(before.replace(/"[^"]*"/g, ''))) return null;
      if ((before.match(/"/g) ?? []).length % 2) return null;
      let word = /[.#]?[\w]*$/.exec(before)[0];
      // # starts a preprocessor directive only at the start of a line; else it is lda #value
      if (word.startsWith('#') && !/^\s*$/.test(before.slice(0, before.length - word.length))) word = word.slice(1);
      const from = caret - word.length;
      const head = before.slice(0, before.length - word.length);
      const lead = /^\s*([A-Za-z_]\w*)(\.\w+)?\s+$/.exec(head);
      const statement = lead ? !isMnemonic(lead[1]) && !/^\./.test(lead[1]) : /^\s*$|^\s*(!?[\w]*:)\s*$|[{}]\s*$/.test(head);
      const defs = ctx.definitions?.() ?? [];
      const items = [];
      if (/\.cpu\s+$/.test(head)) return { from, to: caret, items: filterItems(CPUS.map(c => ({ label: c, kind: 'cpu' })), word) };
      if (word.startsWith('#')) {
        for (const d of PPDIRECTIVES) items.push({ label: d.name, kind: 'pseudo', syntax: d.example, detail: d.desc });
        return { from, to: caret, items: filterItems(items, word), open: true };
      }
      if (word.startsWith('.') && !/\w$/.test(head)) {
        for (const d of DIRECTIVES.filter(x => x.name.startsWith('.'))) items.push({ label: d.name, kind: 'pseudo', syntax: d.example, detail: d.desc });
        return { from, to: caret, items: filterItems(items, word), open: true };
      }
      if (statement) {
        for (const m of mnemonics(cpuOf(ctx.cpu?.()))) items.push({ label: m.name.toLowerCase(), kind: 'mnemonic', detail: m.desc, doc: mnemonicDoc(cpuOf(ctx.cpu?.()), m.name, m.desc) });
        for (const m of AUTO_MACROS) items.push({ label: m.name, insert: `${m.name}()`, caret: m.name.length + 1, kind: 'macro', hint: m.params, detail: m.desc });
        for (const d of defs.filter(x => x.kind === 'macro')) {
          items.push(d.pseudo ? { label: d.name, insert: `${d.name} `, kind: 'macro', hint: d.params, detail: `pseudo command ${d.name} - ${d.file ?? ''}:${d.line}` }
            : { label: d.name, insert: `${d.name}()`, caret: d.name.length + 1, kind: 'macro', hint: d.params, detail: `macro ${d.name}(${d.params ?? ''}) - ${d.file ?? ''}:${d.line}` });
        }
      }
      // in the operand of an instruction: its doc, the bits of the register it addresses, the registers at $..
      const machine = ctx.machine?.();
      const syms = ctx.symbols?.() ?? [];
      const help = statement ? null : asmHelp({ before, caret, cpu: cpuOf(ctx.cpu?.()), machine, isMnemonic, valueOf: name => syms.find(s => s.name === name)?.value ?? null });
      if (help?.hex) return { from: help.hex.from, to: caret, items: help.hex.items, info: help.info, open: help.hex.typed.length > 2 };
      if (!statement || force) {
        const seen = new Set();
        const add = x => { if (!seen.has(x.label)) { seen.add(x.label); items.push(x); } };
        for (const s of syms) {
          const doc = registerDoc(machine, s.value);       // a label of a register: its bits
          add({ label: s.name, kind: 'label', detail: `${s.name} = ${hex(s.value)}`, ...(doc ? { doc } : {}) });
        }
        for (const d of defs) {
          if (d.kind === 'macro' || d.kind === 'zone') continue;
          add(d.kind === 'function' ? { label: d.name, insert: `${d.name}()`, caret: d.name.length + 1, kind: 'macro', hint: d.params, detail: `function ${d.name}(${d.params ?? ''}) - ${d.file ?? ''}:${d.line}` }
            : { label: d.name, kind: d.kind === 'const' ? 'const' : 'label', detail: `${d.kind} ${d.name}${d.value ? ' = ' + d.value : ''} - ${d.file ?? ''}:${d.line}` });
        }
        for (const l of LIBRARY) {
          if (l.lib === '65xxMnemonics' && !/^[A-Z]{3}_/.test(word.toUpperCase())) continue;     // LDA_IMM ... only when asked for
          add(l.kind === 'function'
            ? { label: l.name, insert: `${l.name}()`, caret: l.name.length + 1, kind: 'macro', hint: l.args.length ? `${l.args.join('/')} arg${l.args.join() === '1' ? '' : 's'}` : '', detail: `${l.lib} function` }
            : { label: l.name, kind: 'const', detail: `${l.lib} constant` });
        }
      }
      const list = filterItems(items, word).filter(x => x.label !== word || x.kind === 'mnemonic' || x.kind === 'pseudo');
      return { from, to: caret, items: list, info: help?.info };
    },
  };
}
