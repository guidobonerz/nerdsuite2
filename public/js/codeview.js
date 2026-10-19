// codeview.js - the Code view of nerdsuite: the sources of the project in tabs - ACME assembler
// (.asm .a .s .inc) and BASIC (.bas) in the dialect of the file - with colours, autocompletion,
// the errors of the last build, breakpoints in the gutter and the line the CPU stopped at.
//
// The text of an open file is kept here until it is saved (Save of the app bar, Ctrl+S) - the
// build takes what the editor shows (texts()), saved or not.

import { h, mount, signal, icon, iconButton, select, promptDialog, snackbar, confirmRemove, openMenu, sidePanel, section, button, toggleSwitch } from './pui.js';
import { codeEditor, revealLine, caretAt } from './codeeditor.js';
import { acmeLanguage, scanDefinitions, cpus } from './lang-acme.js';
import { kickassLanguage, scanDefinitions as scanKick } from './lang-kickass.js';
import { starterKick, platformOf } from './platforms.js';
import { platformPref } from './platformprefs.js';
import { typedLength, limitColumn, tokenBased } from './basic/typed.js';
import { basicLanguage, lineNumbers, renumber, dialectList, inString, isCommodore, petsciiCharset, toEditorText, toSourceText } from './lang-basic.js';
import { scanLabels, toLabels, toNumbers, renameLabel, basicLabelAt } from './basic/labels.js';
import { wordAt, renameInSource, localScope } from './refactor.js';
import { CPU_TABLES } from './acme/acme.js';

// the instructions of every CPU: no label is renamed to one
const MNEMONIC_NAMES = new Set(Object.values(CPU_TABLES).flatMap(t => Object.keys(t)));
import { openPetsciiPanel } from './petsciipanel.js';
import { listSources, hasFile, readText, readBinary, writeText, removeFile, isOpen, allFiles, isSource } from './project.js';
import { embedInlay } from './embedview.js';
import { EMBED, resolveEmbeds } from './basic/preprocess.js';
import { readSettings, writeSettings, isAsm, isBasic, dialectOf, labelModeOf, machineOf, assemblerOf, ASSEMBLERS, kickassStatus, codeAddresses, isCodeLine } from './nsbuild.js';
import * as vice from './vice.js';
import { exportName } from './export.js';

const KEY = 'nerdsuite.code';

const EXT = { asm: 'asm', kick: 'asm', inc: 'inc', kickinc: 'asm', bas: 'bas', c: 'c' };
const isC = p => /\.[ch]$/i.test(p);
const TEMPLATES = {
  asm: name => `; ${name} - assembled with the ACME compatible assembler of nerdsuite
!cpu 6510
!to "${name}.prg", cbm

*= $0801
        !byte $0c, $08, $0a, $00, $9e          ; 10 SYS
        !text "2064"                            ; the address of start
        !byte $00, $00, $00

*= $0810
start:
        lda #$00
        sta $d020                               ; the border black
        sta $d021                               ; the background black
-       inc $d020
        jmp -
`,
  inc: name => `; ${name} - included with !source "${name}.inc"
`,
  bas: () => `10 print "{clr}hello world"
20 goto 10
`,
  // for a compiler command of a toolchain (the Settings): cc65, oscar64 ...
  c: name => `// ${name}.c - compiled by the toolchain of the project (Settings › Toolchains)
#include <stdio.h>

int main(void)
{
    printf("hello world\\n");
    return 0;
}
`,
};

export function createCodeView(el, bar, hooks = {}) {
  const st = {
    open: [],                       // the paths of the tabs
    current: null,                  // the path shown
    buffers: new Map(),             // path -> { text, saved }
    carets: new Map(),              // path -> { from, to, scroll }
    outline: true,
    embeds: false,                  // BASIC: the data of every DATA @embed shown after its line
    addresses: true,                // assembler: the addresses of the last build in the gutter, not the line numbers
    search: '',                     // the search of the header: its matches marked
    caret: { line: 1, col: 1 },
  };
  try { const kept = JSON.parse(localStorage.getItem(KEY) ?? '{}'); Object.assign(st, { outline: kept.outline ?? true, embeds: !!kept.embeds, addresses: kept.addresses ?? true }); } catch { /* none */ }
  // the addresses of the instruction lines of the last good build: path -> { text: at the build, lines: Map line -> address }
  let addresses = new Map();
  let limitTold = 0;                  // when the barrier of a line was last told (not at every key)
  const version = signal(0);
  const input = { current: null };
  let views = null;
  let errors = new Map();           // path -> Map line -> message (the last build)
  let symbols = [];                 // the symbols of the last assembly

  const update = () => { version.value++; };
  const settings = () => readSettings();

  // --- files ---------------------------------------------------------------------------------

  // BASIC: the file holds the {control codes} of its strings, the editor one character per byte (lang-basic.js)
  const toEditor = (path, t) => (isBasic(path) ? toEditorText(t, dialectOf(path)) : t);
  const toFile = (path, t) => (isBasic(path) ? toSourceText(t, dialectOf(path)) : t);
  const buffer = path => {
    if (!st.buffers.has(path)) {
      const text = hasFile(path) ? toEditor(path, readText(path)) : '';
      st.buffers.set(path, { text, saved: text });
    }
    return st.buffers.get(path);
  };
  const text = path => buffer(path).text;
  const dirty = path => st.buffers.has(path) && st.buffers.get(path).text !== st.buffers.get(path).saved;
  const isDirty = () => [...st.buffers.keys()].some(dirty);

  function keepCaret() {
    const ta = input.current;
    if (st.current && ta) st.carets.set(st.current, { from: ta.selectionStart, to: ta.selectionEnd, scroll: ta.scrollTop });
  }
  function restoreCaret() {
    const ta = input.current, c = st.carets.get(st.current);
    if (!ta) return;
    if (!c) return firstLine(ta);
    ta.setSelectionRange(Math.min(c.from, ta.value.length), Math.min(c.to, ta.value.length));
    ta.scrollTop = c.scroll;
  }
  // a file shown the first time: the caret at the start of its first line of code (assembler: the first
  // instruction - not the comments, the directives, the data, a label alone; BASIC: the first line), the
  // file from its top - not at its end, where the browser leaves it
  function firstLine(ta, { scroll = true } = {}) {
    const lines = ta.value.split('\n');
    const code = l => (isAsm(st.current) ? isCodeLine(l) && l.replace(/;.*$|\/\/.*$/, '').trim() && !/^\s*[.@!]?[\w.]+:\s*$/.test(l.replace(/;.*$|\/\/.*$/, '')) : l.trim());
    const k = Math.max(0, lines.findIndex(code));
    const at = lines.slice(0, k).reduce((n, l) => n + l.length + 1, 0) + (/^\s*/.exec(lines[k] ?? '')[0].length);
    ta.setSelectionRange(at, at);
    if (scroll) ta.scrollTop = 0;
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
    if (k * lh > ta.clientHeight - 2 * lh) revealLine(ta, k + 1);         // further down than the first screen: shown
    ta.dispatchEvent(new Event('scroll'));
    st.caret = caretAt(ta.value, at);
    update();                                    // Ln and Col of the bar
  }

  function open(path, line = null, { focus = true } = {}) {
    if (!path) return;
    keepCaret();
    if (!st.open.includes(path)) st.open.push(path);
    st.current = path;
    buffer(path);
    persist();
    update();
    hooks.onRoute?.();
    requestAnimationFrame(() => {
      restoreCaret();
      if (line) revealLine(input.current, line, { select: true, text: text(path) });
      else if (focus) input.current?.focus({ preventScroll: true });
    });
  }

  async function closeTab(path) {
    if (dirty(path) && !(await confirmRemove({ what: `the changes of ${path}`, verb: 'remove', undo: false }))) return;
    keepCaret();
    const k = st.open.indexOf(path);
    st.open.splice(k, 1);
    st.buffers.delete(path);
    if (st.current === path) st.current = st.open[Math.min(k, st.open.length - 1)] ?? null;
    persist();
    update();
    hooks.onRoute?.();
    hooks.onDirty?.();
  }

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify({ outline: st.outline, embeds: st.embeds, addresses: st.addresses })); } catch { /* no storage */ }
    try { sessionStorage.setItem(`${KEY}.tabs`, JSON.stringify({ open: st.open, current: st.current })); } catch { /* no storage */ }
  }

  // the project changed (opened, another one): the tabs of the session again, else the main program
  function reset() {
    st.buffers.clear();
    st.carets.clear();
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(`${KEY}.tabs`) ?? 'null'); } catch { /* none */ }
    const sources = isOpen() ? listSources() : [];
    st.open = (saved?.open ?? []).filter(p => sources.includes(p));
    st.current = st.open.includes(saved?.current) ? saved.current : st.open[0] ?? null;
    if (!st.open.length) {
      const main = settings().main;
      const first = sources.includes(main) ? main : sources[0];
      if (first) { st.open = [first]; st.current = first; }
    }
    errors = new Map();
    update();
    // the file shown: its caret on its first line of code (the scroll of a reload is the UI state's: uistate.js)
    requestAnimationFrame(() => { if (st.current && input.current && !st.carets.has(st.current)) firstLine(input.current, { scroll: false }); });
  }

  // the label mode of a BASIC file on or off: the program is converted (labels <-> line numbers)
  function toggleLabelMode(path) {
    const b = buffer(path), on = !labelModeOf(path);
    let next = b.text;
    if (on) next = toLabels(b.text);
    else {
      const r = toNumbers(b.text);
      if (r.errors.length) { snackbar(`The labels have errors - line ${r.errors[0].line}: ${r.errors[0].msg}`, { error: true, timeout: 8000 }); return; }
      next = r.text;
    }
    writeSettings({ labelModes: { ...settings().labelModes, [path]: on || undefined } });
    if (next !== b.text) { b.text = next; hooks.onDirty?.(); }
    update();
    snackbar(on ? 'Label mode: the jumps go to labels (name:), the lines get their numbers when the program is built' : 'Line numbers again');
  }

  // a new source file: its name, its kind, the template
  async function newFile() {
    const v = await promptDialog({
      title: 'New source file', ok: 'Create',
      fields: [
        { name: 'kind', label: 'Kind', value: settings().assembler === 'kickass' ? 'kick' : 'asm', radios: [
          { value: 'asm', label: 'Assembler (ACME)' }, { value: 'kick', label: 'Assembler (KickAssembler)' },
          { value: 'inc', label: 'Assembler include (ACME)' }, { value: 'kickinc', label: 'Assembler include (KickAssembler)' }, { value: 'bas', label: 'BASIC' },
          { value: 'c', label: 'C (for the compiler of a toolchain)' }] },
        { name: 'name', label: 'Name', value: 'main', mono: true,
          validate: (n, all) => (!/^[\w-]+$/.test(n) ? 'letters, digits, - and _' : hasFile(`src/${n}.${EXT[all.kind]}`) ? 'there is such a file' : null) },
        { name: 'dialect', label: 'BASIC dialect', value: machineOf(settings().machine).basic[0] ?? 'v2', when: x => x.kind === 'bas',
          options: dialectList().map(d => ({ value: d.id, label: d.name })) },
      ],
    });
    if (!v) return;
    const path = `src/${v.name}.${EXT[v.kind]}`;
    const kick = v.kind === 'kick' || v.kind === 'kickinc';
    if (kick && !(await kickassStatus()).available) snackbar('KickAssembler was not found on the server: set KICKASS (and JAVA) and restart it. The file is made anyway.', { error: true, timeout: 8000 });
    writeText(path, v.kind === 'kick' ? starterKick(machineOf(settings().machine), v.name) : v.kind === 'kickinc' ? `// ${v.name}.asm - included with #import "${v.name}.asm"\n` : TEMPLATES[v.kind](v.name));
    if (v.kind === 'bas') writeSettings({ dialects: { ...settings().dialects, [path]: v.dialect } });
    // the assembler of the file, when it is not the project's
    const own = kick ? 'kickass' : 'acme';
    if (isAsm(path) && own !== (settings().assembler ?? 'acme')) writeSettings({ assemblers: { ...settings().assemblers, [path]: own } });
    if (!settings().main && v.kind !== 'inc' && v.kind !== 'kickinc') writeSettings({ main: path });
    open(path);
    snackbar(`${path} created`);
  }

  async function renameFile(path) {
    const v = await promptDialog({ title: `Rename ${path}`, ok: 'Rename',
      fields: [{ name: 'path', label: 'Path', value: path, mono: true,
        validate: p => (!/^[\w./-]+\.(asm|a|s|inc|bas|c|h|txt)$/i.test(p) ? 'a path ending in .asm .a .s .inc .bas .c .h or .txt' : p !== path && hasFile(p) ? 'there is such a file' : null) }] });
    if (!v || v.path === path) return;
    const b = buffer(path);
    writeText(v.path, toFile(path, b.text));
    removeFile(path);
    const s = settings();
    const dialects = { ...s.dialects };
    if (dialects[path]) { dialects[v.path] = dialects[path]; delete dialects[path]; }
    writeSettings({ dialects, main: s.main === path ? v.path : s.main });
    st.buffers.delete(path);
    st.buffers.set(v.path, { text: b.text, saved: b.text });
    st.open = st.open.map(p => (p === path ? v.path : p));
    if (st.current === path) st.current = v.path;
    persist();
    update();
    hooks.onRoute?.();
  }

  async function deleteFile(path) {
    if (!(await confirmRemove({ what: path, undo: false }))) return;
    st.buffers.delete(path);
    removeFile(path);
    const s = settings();
    if (s.main === path) writeSettings({ main: null });
    const k = st.open.indexOf(path);
    if (k >= 0) st.open.splice(k, 1);
    if (st.current === path) st.current = st.open[0] ?? null;
    persist();
    update();
    hooks.onDirty?.();
  }

  // every open file into the project: the paths written
  function saveChanges() {
    const out = [];
    for (const [path, b] of st.buffers) {
      if (b.text === b.saved) continue;
      writeText(path, toFile(path, b.text));
      b.saved = b.text;
      out.push(path);
    }
    update();
    return out;
  }

  // the texts of the open files as the build reads them, saved or not
  const texts = () => new Map([...st.buffers].filter(([, b]) => b.text !== b.saved).map(([p, b]) => [p, toFile(p, b.text)]));

  // --- the languages ---------------------------------------------------------------------------

  // the definitions of every assembler source of the project: what the completion offers
  function definitions() {
    const out = [];
    for (const p of isOpen() ? listSources() : []) {
      if (!isAsm(p) || assemblerOf(p) !== which) continue;
      for (const d of scanOf(p)(st.buffers.get(p)?.text ?? readText(p))) out.push({ ...d, file: p });
    }
    return out;
  }
  let which = 'acme';                     // the assembler of the file in the editor: its definitions
  const kick = path => isAsm(path) && assemblerOf(path) === 'kickass';
  const scanOf = path => (kick(path) ? scanKick : scanDefinitions);
  const asm = acmeLanguage({ cpu: () => settings().cpu || machineOf(settings().machine).cpu || '6510', machine: () => settings().machine, definitions, symbols: () => symbols });
  const kickLang = kickassLanguage({ cpu: () => '_6502', machine: () => settings().machine, definitions, symbols: () => symbols });
  // the files of the project for DATA @embed (basic/preprocess.js), and their data after the line when the bar shows it
  const projectBinary = p => (hasFile(p) ? readBinary(p) : null);
  const basic = basicLanguage({ dialect: () => dialectOf(st.current), machine: () => settings().machine, labelMode: () => labelModeOf(st.current),
    defines: () => settings().defines ?? '', files: () => (isOpen() ? allFiles().filter(p => !isSource(p) && !p.startsWith('reference/')) : []),
    inlay: line => (st.embeds && line.includes('@embed') ? embedInlay(line, projectBinary) : null) });
  // C: the colours of KickAssembler come closest (// and /* */ comments, #include)
  const langOf = path => { which = kick(path) || isC(path) ? 'kickass' : 'acme'; return isBasic(path) ? basic : kick(path) || isC(path) ? kickLang : asm; };

  // rename the label at the caret, and every reference to it (F2, refactor.js): a global one in every
  // source of its assembler, a local one (.name, @name) in its part of the file, a label of the BASIC label
  // mode in its program. The files that change open as tabs, unsaved; the snackbar undoes it all
  // given: the name of a label (the outline, the bar), else the one at the caret
  async function renameSymbol(given = null) {
    const path = st.current, ta = input.current;
    if (!path || !ta) return;
    const basicMode = isBasic(path);
    if (basicMode && !labelModeOf(path)) { snackbar('A BASIC program renames its labels in the label mode (the label button of the bar)'); return; }
    // BASIC needs no spaces (GOTOLOOP): the label whose name the caret is in, in its line
    const name = given ?? (basicMode ? basicLabelAt(text(path), ta.selectionStart) : null) ?? wordAt(text(path), ta.selectionStart)?.word;
    // what can be renamed: a label of the program, a definition of the project (label, constant, macro)
    const known = basicMode ? scanLabels(text(path)).find(l => l.name.toLowerCase() === name?.toLowerCase())
      : name && definitions().find(d => d.name === name && d.kind !== 'zone');
    if (!known) { snackbar(name ? `${name} is no label of the ${basicMode ? 'program' : 'project'}: F2 renames a label at the caret` : 'F2 renames the label at the caret', { timeout: 5000 }); return; }
    const old = known.name;
    const local = !basicMode && /^[.@]/.test(old);
    const lang = kick(path) ? 'kickass' : 'acme';
    const files = basicMode || local ? [path] : listSources().filter(p => isAsm(p) && assemblerOf(p) === which);
    const scope = local ? localScope(text(path), ta.selectionStart, old) : null;
    const prefix = local ? old[0] : '';
    const taken = n => (basicMode ? scanLabels(text(path)).some(l => l.name.toLowerCase() === n.toLowerCase() && l.name !== old)
      : definitions().some(d => d.name === n && (!local || d.file === path)));
    const v = await promptDialog({ title: `Rename ${old}`, ok: 'Rename', fields: [{
      name: 'name', label: `New name${local ? ` (local: ${prefix}…)` : ''}`, value: old, mono: true,
      validate: t => {
        const n = t.trim();
        if (n === old) return null;
        if (!new RegExp(`^${local ? `\\${prefix}` : ''}[A-Za-z_]\\w*$`).test(n)) return local ? `${prefix} and then letters, digits and _` : 'letters, digits and _, not first a digit';
        if (!basicMode && MNEMONIC_NAMES.has(n.toLowerCase())) return `${n} is an instruction`;
        return taken(n) ? `there is a ${n} already` : null;
      },
    }] });
    const next = v?.name.trim();
    if (!next || next === old) return;
    const before = new Map(), changed = [];
    let count = 0;
    for (const p of files) {
      const t = text(p);
      const r = basicMode ? renameLabel(t, old, next) : renameInSource(t, old, next, { lang, ...(scope && p === path ? { from: scope[0], to: scope[1] } : {}) });
      if (!r.count) continue;
      before.set(p, t);
      buffer(p).text = r.text;
      count += r.count;
      changed.push(p);
      if (!st.open.includes(p)) st.open.push(p);           // to be seen, and saved
    }
    persist();
    update();
    hooks.onDirty?.();
    snackbar(`${old} is ${next} now: ${count} place${count === 1 ? '' : 's'}${changed.length > 1 ? ` in ${changed.length} files` : ''}`, {
      timeout: 8000, action: 'Undo',
      onaction: () => { for (const [p, t] of before) if (st.buffers.has(p)) st.buffers.get(p).text = t; update(); hooks.onDirty?.(); },
    });
  }

  // the label at a place of a source: a definition of the project (assembler), a label of the label mode
  // (BASIC), or null
  function labelAtOffset(path, at) {
    const t = text(path);
    if (isBasic(path)) return labelModeOf(path) ? basicLabelAt(t, at) : null;
    if (!isAsm(path)) return null;
    const w = wordAt(t, at)?.word;
    return w && definitions().some(d => d.name === w && d.kind !== 'zone') ? w : null;
  }

  // the menu of a right click in the editor (not in a string of Commodore BASIC: the PETSCII panel)
  function editorMenu(path, at, x, y, inSelection) {
    const ta = input.current;
    if (!ta) return;
    const label = labelAtOffset(path, at);
    const basicNoLabels = isBasic(path) && !labelModeOf(path);
    const hasSel = !!inSelection;            // a click outside the selection moves the caret: nothing selected then
    const refocus = () => ta.focus({ preventScroll: true });
    const def = label && isAsm(path) ? definitions().find(d => d.name === label) : null;
    const labelLine = label && isBasic(path) ? scanLabels(text(path)).find(l => l.name === label)?.line : null;
    openMenu({ x, y }, [
      { header: 'Refactor' },
      {
        label: label ? `Rename ${label}…` : 'Rename…', icon: 'edit', kbd: 'F2', disabled: !label,
        tip: label ? `${label} and every reference to it${isAsm(path) && !/^[.@]/.test(label) ? ', in every source of the project' : ''}`
          : basicNoLabels ? 'BASIC renames labels in the label mode (the label button of the bar)' : 'no label here: right click on a label or on a reference to it',
        onclick: () => { refocus(); renameSymbol(label); },
      },
      (def || labelLine) && {
        label: `Go to ${label}`, icon: 'arrow_forward', kbd: isAsm(path) ? 'Ctrl+click' : undefined,
        tip: def ? `${def.file}:${def.line}` : `line ${labelLine}`,
        onclick: () => (def ? open(def.file, def.line) : open(path, labelLine)),
      },
      { divider: true },
      { label: 'Cut', icon: 'content_cut', kbd: 'Ctrl+X', disabled: !hasSel, onclick: () => { refocus(); document.execCommand('cut'); } },
      { label: 'Copy', icon: 'content_copy', kbd: 'Ctrl+C', disabled: !hasSel, onclick: () => { refocus(); document.execCommand('copy'); } },
      { label: 'Paste', icon: 'content_paste', kbd: 'Ctrl+V', onclick: () => paste(path) },
      { divider: true },
      { label: 'Comment or uncomment the lines', icon: 'comment', kbd: 'Ctrl+/',
        onclick: () => { refocus(); ta.dispatchEvent(new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true, cancelable: true })); } },
      { label: 'Select all', icon: 'select_all', kbd: 'Ctrl+A', onclick: () => { refocus(); ta.select(); } },
    ]);
  }

  // Paste of the menu: the clipboard through the language (BASIC: its {codes} as one character a byte),
  // typed in so that Ctrl+Z undoes it
  async function paste(path) {
    const ta = input.current;
    if (!ta) return;
    let clip;
    try { clip = await navigator.clipboard.readText(); } catch { snackbar('The browser does not give the clipboard to the page: Ctrl+V pastes', { timeout: 5000 }); return; }
    ta.focus({ preventScroll: true });
    const lang = langOf(path), t = clip.replace(/\r\n?/g, '\n');
    const ins = lang.pasteText ? lang.pasteText(ta.value, ta.selectionStart, t) : t;
    if (!document.execCommand('insertText', false, ins)) {
      ta.setRangeText(ins, ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // go to the definition of a word (Ctrl+click)
  function gotoDefinition(word) {
    const name = word.replace(/^\+/, '');
    const d = definitions().find(x => x.name === name) ?? definitions().find(x => x.name.toLowerCase() === name.toLowerCase());
    if (d) open(d.file, d.line);
  }

  // --- the errors of a build --------------------------------------------------------------------

  function setBuild(build) {
    errors = new Map();
    for (const e of build?.errors ?? []) {
      if (!e.file || !e.line) continue;
      if (!errors.has(e.file)) errors.set(e.file, new Map());
      const m = errors.get(e.file);
      m.set(e.line, m.has(e.line) ? `${m.get(e.line)}\n${e.msg}` : e.msg);
    }
    if (build?.kind === 'asm' && build.ok) {
      symbols = build.symbols ?? [];
      addresses = new Map([...codeAddresses(build)].map(([file, lines]) => [file, { text: text(file), lines }]));
    }
    update();
  }

  // --- the bar -----------------------------------------------------------------------------------

  function barView() {
    version.value; vice.bpVersion.value;    // eslint-disable-line no-unused-expressions
    if (!isOpen()) return null;
    const path = st.current, s = settings();
    // Build, Run, Debug, the Ultimate: their state from app.js (runState)
    const run = hooks.runState?.value ?? {};
    const runButton = (key, ic, fn) => run[key] && !run[key].hidden
      && iconButton(ic, run[key].tip ?? key, fn, '', { disabled: !!run[key].disabled });
    return h('div', { class: 'screen-bar' },
      h('span', { class: 'md-title-medium' }, 'Code'),
      h('span', { class: 'screen-bar__sep' }),
      runButton('build', 'build', () => hooks.build?.()),
      runButton('run', 'play', () => hooks.run?.()),
      runButton('debug', 'debug', () => hooks.debug?.()),
      runButton('ultimate', 'cpu', () => hooks.ultimate?.()),
      hooks.runState && h('span', { class: 'screen-bar__sep' }),
      iconButton('add', 'New source file', newFile),
      iconButton('folder', 'Open a source of the project', e => openMenu(e.currentTarget,
        listSources().length ? listSources().map(p => ({ label: p, icon: isBasic(p) ? 'description' : 'code', onclick: () => open(p) }))
          : [{ label: 'no sources yet', disabled: true }])),
      h('span', { class: 'screen-bar__sep' }),
      iconButton('undo', 'Undo (Ctrl+Z)', () => { input.current?.focus(); document.execCommand('undo'); }),
      iconButton('redo', 'Redo (Ctrl+Y)', () => { input.current?.focus(); document.execCommand('redo'); }),
      path && h('span', { class: 'screen-bar__sep' }),
      // the main program: what Build, Run and Debug make
      path && !/\.inc$/i.test(path) && iconButton('flag', s.main === path ? 'The main program: Build, Run and Debug make it' : 'Make this the main program',
        () => { writeSettings({ main: path }); update(); hooks.onMain?.(); }, s.main === path ? 'md-icon-button--selected' : ''),
      path && isBasic(path) && select({ label: 'Dialect', hideLabel: true, dense: true, value: dialectOf(path), cls: 'ns-bar__select',
        options: dialectList().map(d => ({ value: d.id, label: d.name })),
        onchange: v => {
          // the strings in the form of the new dialect: through the {codes} of the file
          const b = buffer(path), file = toFile(path, b.text), saved = toFile(path, b.saved);
          writeSettings({ dialects: { ...s.dialects, [path]: v } });
          b.text = toEditor(path, file);
          b.saved = toEditor(path, saved);
          update();
        } }),
      // the label mode: labels instead of line numbers (basic/labels.js) - switching converts the program
      path && isBasic(path) && iconButton('label', labelModeOf(path) ? 'Label mode: labels instead of line numbers - click for line numbers again' : 'Label mode: labels instead of line numbers',
        () => toggleLabelMode(path), labelModeOf(path) ? 'md-icon-button--selected' : ''),
      // DATA @embed: the data of the file after the line (its picture, its bytes)
      path && isBasic(path) && iconButton(st.embeds ? 'visibility' : 'visibility_off', st.embeds ? 'Hide the data of the DATA @embed lines' : 'Show the data of the DATA @embed lines in the editor (sprites, characters, screens, bitmaps, bytes)',
        () => { st.embeds = !st.embeds; persist(); update(); }, st.embeds ? 'md-icon-button--selected' : ''),
      // the label mode: rename the label at the caret with every jump to it (F2)
      path && isBasic(path) && labelModeOf(path) && iconButton('edit', 'Rename the label at the caret, with every GOTO, GOSUB, THEN … to it (F2)', () => renameSymbol()),
      path && isBasic(path) && !labelModeOf(path) && iconButton('sort', 'Renumber the lines (10, 20, 30 …) with GOTO, GOSUB and THEN', () => {
        const b = buffer(path), next = renumber(b.text);
        if (next !== b.text) { b.text = next; update(); hooks.onDirty?.(); }
      }),
      // the assembler of the file: ACME or KickAssembler (a file of its own, or the project's)
      path && isAsm(path) && select({ label: 'Assembler', hideLabel: true, dense: true, value: assemblerOf(path), cls: 'ns-bar__select',
        options: ASSEMBLERS.map(a => ({ value: a.id, label: a.name })),
        onchange: v => {
          const assemblers = { ...s.assemblers };
          if (v === (s.assembler ?? 'acme')) delete assemblers[path]; else assemblers[path] = v;
          writeSettings({ assemblers });
          if (v === 'kickass') kickassStatus().then(k => { if (!k.available) snackbar('KickAssembler was not found on the server: set KICKASS (and JAVA) and restart it', { error: true, timeout: 8000 }); });
          update();
        } }),
      // the gutter: the addresses of the last build or the line numbers
      path && isAsm(path) && toggleSwitch('Addresses', st.addresses, on => { st.addresses = on; persist(); update(); },
        { cls: 'ns-bar__switch', tip: 'On: the gutter shows the addresses of the last build (instruction and label lines). Off: line numbers' }),
      path && isAsm(path) && !kick(path) && select({ label: 'CPU', hideLabel: true, dense: true, value: s.cpu || machineOf(s.machine).cpu || '6510', cls: 'ns-bar__select',
        options: cpus().map(c => ({ value: c, label: c })),
        onchange: v => { writeSettings({ cpu: v }); update(); } }),
      h('div', { class: 'app-bar__spacer' }),
      path && h('span', { class: 'md-body-small ns-caret', 'data-i18n': 'off' }, `Ln ${st.caret.line}, Col ${st.caret.col}`),
      iconButton('right_panel_open', st.outline ? 'Hide the outline' : 'Show the outline', () => { st.outline = !st.outline; persist(); update(); }, st.outline ? 'md-icon-button--selected' : ''));
  }

  // --- the body ---------------------------------------------------------------------------------

  function tabsView() {
    return h('div', { class: 'ns-tabs', role: 'tablist' },
      st.open.map(p => h('div', { class: `ns-tab ${p === st.current ? 'ns-tab--active' : ''}`, role: 'tab', 'aria-selected': String(p === st.current),
        title: p, onclick: () => open(p), onauxclick: e => { if (e.button === 1) closeTab(p); },
        oncontextmenu: e => { e.preventDefault(); openMenu({ x: e.clientX, y: e.clientY }, [
          { label: 'Rename…', icon: 'edit', onclick: () => renameFile(p) },
          { label: 'Make it the main program', icon: 'flag', onclick: () => { writeSettings({ main: p }); update(); } },
          { label: 'Close', icon: 'close', onclick: () => closeTab(p) },
          { divider: true },
          { label: 'Delete the file', icon: 'delete', danger: true, onclick: () => deleteFile(p) },
        ]); } },
      icon(isBasic(p) ? 'description' : 'code'),
      h('span', { class: 'ns-tab__name', 'data-i18n': 'off' }, p.split('/').pop()),
      settings().main === p && h('span', { class: 'ns-tab__main', title: 'main program' }, icon('flag')),
      dirty(p) && h('span', { class: 'ns-tab__dot' }),
      h('button', { class: 'ns-tab__close', type: 'button', 'aria-label': 'Close', onclick: e => { e.stopPropagation(); closeTab(p); } }, icon('close')))),
      h('button', { class: 'ns-tab ns-tab--add', type: 'button', title: 'New source file', onclick: newFile }, icon('add')));
  }

  function editorView() {
    const path = st.current;
    if (!path) {
      return h('div', { class: 'empty-state' }, icon('code'), h('div', { class: 'md-title-medium' }, 'No source open'),
        h('div', { class: 'md-body-medium' }, 'Create an assembler or BASIC source, or open one of the project.'),
        h('div', { class: 'start-screen__actions' }, button('New source file', { icon: 'add', variant: 'filled', onclick: newFile })));
    }
    const b = buffer(path);
    const marks = vice.breakpointMarks(path);
    const at = vice.here.value;
    if (at?.file === path) marks.set(at.line, marks.has(at.line) ? `${marks.get(at.line)} here` : 'here');
    // the addresses of the last build on the instruction lines (st.addresses), dimmed once the file changed
    const built = isAsm(path) && st.addresses ? addresses.get(path) : null;
    // BASIC: the longest line the machine's editor takes (Settings, platformprefs.js) - a red line, a barrier
    // for typing; a BASIC of tokens counts its keywords as typed abbreviated (basic/typed.js). Not in the
    // label mode: its lines get their numbers in the build (which warns of long lines then)
    const platform = platformOf(settings().machine), max = isBasic(path) && !labelModeOf(path) ? platformPref(platform.id, 'basicLine') : 0;
    const dialect = isBasic(path) ? dialectOf(path) : null;
    const limit = max ? {
      max, length: l => typedLength(l, dialect), column: l => limitColumn(l, max, dialect),
      hint: tokenBased(dialect)
        ? `The ${platform.short} takes ${max} keys a line. A line may go past this line: its keywords are typed abbreviated (pO for POKE) - but after LIST it is longer than the screen editor takes`
        : `The ${platform.short} takes ${max} characters a line (Settings › Editor › BASIC and assembler per platform)`,
    } : null;
    return codeEditor({
      value: b.text,
      lang: langOf(path),
      marks, errors: errors.get(path),
      search: st.search,
      limit,
      onLimit: () => {
        const now = Date.now();
        if (now - limitTold < 4000) return;
        limitTold = now;
        snackbar(tokenBased(dialect) ? `The line is full: the ${platform.short} takes ${max} keys, with the keywords abbreviated` : `The line is full: the ${platform.short} takes ${max} characters`, { timeout: 3000 });
      },
      gutterText: built && new Map([...built.lines].map(([line, a]) => [line, a.toString(16).padStart(4, '0')])),
      gutterStale: built && built.text !== b.text ? 'the addresses of the last build - the file changed since: build again' : null,
      inputRef: input,
      // breakpoints: the lines of an assembler source (BASIC runs in the interpreter: no breakpoints)
      onGutter: isAsm(path) ? line => vice.toggleBreakpoint(path, line) : undefined,
      onDefinition: isAsm(path) ? gotoDefinition : undefined,
      // F2: rename the label at the caret, with every reference
      onkeydown: e => { if (e.key === 'F2' && !e.ctrlKey && !e.altKey && !e.metaKey && (isAsm(path) || isBasic(path))) { e.preventDefault(); renameSymbol(); return true; } return false; },
      // a right click in a string of Commodore BASIC: the PETSCII panel (colours, keys, characters)
      // elsewhere: the menu of the editor - rename (refactor), the definition, the clipboard, the comment
      onContext: (at, insert, e, { inSelection } = {}) => {
        if (isBasic(path) && isCommodore(dialectOf(path)) && inString(b.text, at)) {
          openPetsciiPanel({ x: e.clientX, y: e.clientY, dialect: dialectOf(path), insert });
          return true;
        }
        editorMenu(path, at, e.clientX, e.clientY, inSelection);
        return true;
      },
      onCaret: (line, col) => { st.caret = { line, col }; update(); },
      oninput: v => {
        const was = b.text === b.saved;
        b.text = v;
        const c = input.current ? caretAt(v, input.current.selectionStart) : st.caret;
        st.caret = { line: c.line, col: c.col };
        update();
        if (was !== (b.text === b.saved)) hooks.onDirty?.();
      },
    });
  }

  // the outline: the labels, macros and constants of an assembler source, the lines of a BASIC program
  function outlineView() {
    const path = st.current;
    if (!path) return '';
    const t = text(path);
    if (isBasic(path)) {
      // the labels of the label mode; a program with line numbers has no outline
      if (!labelModeOf(path)) return h('div', { class: 'section__hint' }, 'The outline lists the labels of the label mode (the label button of the bar).');
      const labels = scanLabels(t);
      // a click goes there, a right click or a double click renames the label with its jumps
      return section(`Labels (${labels.length})`, h('div', { class: 'ns-outline' }, labels.map(x => h('button', { class: 'ns-outline__item', type: 'button', onclick: () => open(path, x.line),
        title: `${x.name} - line ${x.line} · right click or double click: rename it with every jump to it`,
        ondblclick: () => renameSymbol(x.name), oncontextmenu: e => { e.preventDefault(); renameSymbol(x.name); } },
        icon('label'), h('span', { class: 'ns-outline__text', 'data-i18n': 'off' }, x.name), h('span', { class: 'ns-outline__line' }, x.line)))));
    }
    const defs = scanOf(path)(t);
    const group = (title, kinds, ic) => {
      const list = defs.filter(d => kinds.includes(d.kind) && !d.name.startsWith('.') && !d.name.startsWith('@'));
      return list.length ? section(`${title} (${list.length})`, h('div', { class: 'ns-outline' }, list.map(d => h('button', { class: 'ns-outline__item', type: 'button', onclick: () => open(path, d.line) },
        icon(ic), h('span', { class: 'ns-outline__text', 'data-i18n': 'off' }, d.name), d.value ? h('span', { class: 'ns-outline__num' }, d.value.slice(0, 16)) : '',
        h('span', { class: 'ns-outline__line' }, d.line))))) : '';
    };
    const bps = vice.allBreakpoints().filter(b => b.file === path);
    return [
      group('Labels', ['label'], 'label'),
      group('Macros and functions', ['macro', 'function'], 'function'),
      group('Constants', ['const'], 'tag'),
      group('Zones', ['zone'], 'folder'),
      bps.length ? section(`Breakpoints (${bps.length})`, h('div', { class: 'ns-outline' }, bps.map(b => h('button', { class: 'ns-outline__item', type: 'button', onclick: () => open(path, b.line) },
        h('span', { class: `ns-bp-dot ${b.enabled ? '' : 'ns-bp-dot--off'}` }), h('span', { class: 'ns-outline__text' }, `line ${b.line}`))))) : '',
    ];
  }

  function bodyView() {
    version.value; vice.bpVersion.value; vice.here.value; petsciiCharset.value;    // eslint-disable-line no-unused-expressions
    if (!isOpen()) return null;
    return h('div', { class: 'screen-body' },
      h('div', { class: 'screen-main ns-code-main' }, tabsView(), editorView()),
      st.outline && st.current ? sidePanel('Outline', outlineView()) : null);
  }

  function render() {
    views ??= [mount(bar, barView), mount(el, bodyView)];
    update();
  }

  // the line the CPU stopped at: its file opened there
  vice.onEvent(type => {
    if (type !== 'stopped') return;
    const at = vice.here.value;
    if (at && hooks.isShown?.()) open(at.file, null, { focus: false });
    if (at) requestAnimationFrame(() => revealLine(input.current, at.line));
  });

  function exportFormats() {
    if (!st.current) return [];
    const p = st.current;
    const name = exportName(p.split('/').pop().replace(/\.[^.]*$/, ''), p.split('.').pop());
    const source = { label: `${p.split('/').pop()} (the source)`, icon: 'description', name,
      type: 'text/plain', description: 'Source', bytes: () => new TextEncoder().encode(toFile(p, text(p))) };
    if (!isBasic(p) || !text(p).split('\n').some(l => EMBED.test(l))) return [source];
    // the DATA @embed lines as the DATA lines of their bytes: a source without the files it embeds
    return [source, { label: `${p.split('/').pop()} (the source, @embed resolved to DATA lines)`, icon: 'data_array', name,
      type: 'text/plain', description: 'Source', bytes: () => {
        const r = resolveEmbeds(text(p), { readFile: projectBinary, labelMode: labelModeOf(p) });
        if (r.errors.length) throw new Error(`line ${r.errors[0].line}: ${r.errors[0].msg}`);
        return new TextEncoder().encode(toFile(p, r.text));
      } }];
  }

  // a text file of the computer into src/
  function importFormats() {
    return [{ label: 'A source file (.asm .a .s .inc .bas .txt)', icon: 'upload_file', accept: '.asm,.a,.s,.inc,.bas,.txt',
      open: async (bytes, fileName) => {
        const name = fileName.split(/[\/]/).pop().replace(/[^\w.-]/g, '_');
        const path = `src/${name}`;
        if (hasFile(path) && !(await confirmRemove({ what: path, verb: 'reset', undo: false }))) return;
        writeText(path, new TextDecoder().decode(bytes).replace(/\r\n?/g, '\n'));
        st.buffers.delete(path);
        open(path);
        snackbar(`${path} imported`);
      } }];
  }

  return {
    render, open, reset, newFile, isDirty, saveChanges, texts, setBuild,
    current: () => st.current,
    exportFormats, importFormats,
    showLine: (file, line) => open(file, line),
    // a label renamed elsewhere (the disassembler): in this source too - its buffer, unsaved, as a tab
    renameIn(file, old, next) {
      if (!hasFile(file) && !st.buffers.has(file)) return 0;
      const r = renameInSource(text(file), old, next, { lang: kick(file) ? 'kickass' : 'acme' });
      if (!r.count) return 0;
      buffer(file).text = r.text;
      if (!st.open.includes(file)) st.open.push(file);
      persist();
      update();
      hooks.onDirty?.();
      return r.count;
    },
    focus: () => input.current?.focus(),
    findIn: () => input.current,
    // the text of the search of the header: its matches marked in the editor
    setSearch(text) { if ((text ?? '') !== st.search) { st.search = text ?? ''; update(); } },
  };
}
