// disasmview.js - the Disassembler view: a binary of the project or of the last build, the
// disassembly on the left and the bytes on the right. In auto mode the code is found by tracing it
// from its entry points (disasm.js); the user selects ranges of the bytes and marks them as code or
// as data of a type (bytes, words, text, chars, sprites, a bitmap, tiles). The marks, the load address
// and the entry points of a file are kept in nerdsuite.json ('disassembler'). The operands are named by
// the memory map of the machine of the project (memmap.js); the side panel shows the register of the
// line with its bits, and previews the bytes as chars, sprites, a bitmap or the tiles of the NES and
// SNES; the disassembly is copied or saved as ACME source. A .prg, .nes, .sfc and .a26 bring their
// layout: the load address or the header, the vectors as entry points, and their machine. A file from
// outside the project can be dropped on the view or opened from the disk (extfiles.js).
//
// Only the lines and rows in view are made, like the Hex view.

import { h, mount, signal, iconButton, select, field, promptDialog, snackbar, sidePanel, section, button, icon, checkbox, segmented } from './pui.js';
import { allFiles, hasFile, readBinary, writeText, buildFiles, hasBuild, isOpen } from './project.js';
import { readSettings, writeSettings, machineOf, MACHINES } from './nsbuild.js';
import { disassembleAll, toSource, markRange, fileLayout, DATA_TYPES, TYPES, typeName, hex2, hex4 } from './disasm.js';
import { decodeBits, describeBits } from './memmap.js';
import { isExternal, externalFiles, readExternal, fileLabel, pickFile, dropTarget, addToProject } from './extfiles.js';
import { TEXTS } from './hexview.js';
import { PALETTE } from './c64.js';
import { CPU_TABLES } from './acme/acme.js';

// the instructions of every CPU: no label may be called like one (the source would read it as one)
const MNEMONIC_NAMES = new Set(Object.values(CPU_TABLES).flatMap(t => Object.keys(t)));

const ROW_H = 20;
const KEY = 'nerdsuite.disasm';
const COLOR_NAMES = ['black', 'white', 'red', 'cyan', 'purple', 'green', 'blue', 'yellow', 'orange', 'brown', 'light red', 'dark grey', 'grey', 'light green', 'light blue', 'light grey'];
// the keys that mark the selection
const MARK_KEYS = { c: 'code', d: 'bytes', w: 'words', t: 'text', p: 'petscii', s: 'screen', h: 'chars', r: 'sprites', m: 'bitmap', i: 'tiles', u: 'none' };
// the preview: what a thing is, and its size in bytes
const PREVIEW = {
  chars: { name: 'Chars', w: 8, h: 8, size: 8, cols: 16, many: 256 },
  sprites: { name: 'Sprites', w: 24, h: 21, size: 64, cols: 4, many: 16 },
  bitmap: { name: 'Bitmap', w: 320, h: 200, size: 8000, cols: 1, many: 1 },
  nes: { name: 'NES tiles', w: 8, h: 8, size: 16, cols: 16, many: 512, type: 'tiles', pens: 4 },
  snes2: { name: 'SNES 2bpp', w: 8, h: 8, size: 16, cols: 16, many: 512, type: 'tiles', pens: 4 },
  snes4: { name: 'SNES 4bpp', w: 8, h: 8, size: 32, cols: 16, many: 256, type: 'tiles', pens: 16 },
};

export function createDisasmView(el, bar, hooks = {}) {
  const st = {
    file: null, data: new Uint8Array(0), head: 0, bytes: null,    // head: the bytes before the data (a load address, a header)
    layout: null,                                                  // fileLayout: the base, the split, the vectors
    cfg: { base: 0, auto: true, regions: [], entries: [] },
    result: null, cursor: 0, anchor: null, focus: 'dis',
    width: 16, text: 'petscii', markType: 'bytes',
    scrollDis: 0, scrollHex: 0, back: [], undo: [], redo: [],
    preview: { mode: 'chars', mc: false, colors: [0, 1, 12, 15], zoom: 2, inline: true },
  };
  try { const kept = JSON.parse(localStorage.getItem(KEY) ?? '{}'); Object.assign(st, { width: kept.width ?? 16, text: kept.text ?? 'petscii', markType: kept.markType ?? 'bytes', preview: { ...st.preview, ...kept.preview } }); } catch { /* none */ }
  const version = signal(0);
  const update = () => { version.value++; };
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify({ width: st.width, text: st.text, markType: st.markType, preview: st.preview })); } catch { /* none */ } };
  let views = null, disEl = null, hexEl = null, dragging = false;
  // the rows in view need the height of their panel: drawn again when a panel is new (a file was
  // dropped on the empty view) or changes its size
  const sized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => update());
  const attach = n => { sized?.observe(n); requestAnimationFrame(update); };

  // the machine of the file: chosen in the side panel, else that of a cartridge, else the project's
  // (a .prg in a project of a Commodore: the project's, which may be a Plus/4 where the load address says VIC-20)
  const machine = () => {
    const own = readSettings().machine;
    if (st.cfg.machine) return st.cfg.machine;
    if (st.layout?.source === 'prg' && machineOf(own).family === 'commodore') return own;
    return st.layout?.machine || own;
  };
  // the CPU of that machine: the project's when it is one of the machine's (a 6502 for a C64 project), else the machine's own
  const cpu = () => {
    if (st.layout?.cpu && !st.cfg.machine) return st.layout.cpu;
    const s = readSettings(), m = machineOf(machine());
    return m.id === s.machine && m.cpus.includes(s.cpu) ? s.cpu : m.cpu;
  };
  const sel = () => (st.anchor == null ? [st.cursor, st.cursor] : [Math.min(st.anchor, st.cursor), Math.max(st.anchor, st.cursor)]);
  const addr = off => (st.cfg.base + off) & 0xffff;
  const lines = () => st.result?.lines ?? [];

  // --- files and settings ---------------------------------------------------------------------------

  function files() {
    const list = isOpen() ? allFiles().filter(p => /\.(prg|bin|raw|dat|a26|xex|nes|sfc|smc|rom)$/i.test(p)) : [];
    const built = hasBuild() ? [...buildFiles().keys()].filter(n => !/\.(lbl|lst)$/i.test(n)).map(n => `build:${n}`) : [];
    return [...list, ...built, ...externalFiles()];
  }

  function open(path) {
    let bytes = null;
    if (path?.startsWith('build:')) bytes = buildFiles().get(path.slice(6)) ?? null;
    else if (isExternal(path)) bytes = readExternal(path);
    else if (path && hasFile(path)) bytes = readBinary(path);
    st.file = bytes ? path : null;
    st.bytes = bytes ? new Uint8Array(bytes) : null;
    st.layout = bytes ? fileLayout(path, bytes) : null;
    st.head = st.layout?.head ?? 0;
    st.data = bytes ? st.bytes.subarray(st.head) : new Uint8Array(0);
    const kept = (readSettings().disassembler ?? {})[path] ?? {};
    st.cfg = { base: 0, auto: true, regions: [], entries: [], machine: null, ...kept };
    if (st.layout) st.cfg.base = st.layout.base;               // a .prg or a cartridge knows where it goes
    st.cursor = 0; st.anchor = null; st.back = []; st.undo = []; st.redo = [];
    st.scrollDis = st.scrollHex = 0;
    if (disEl) disEl.scrollTop = 0;
    if (hexEl) hexEl.scrollTop = 0;
    analyze();
    hooks.onRoute?.();
  }

  function analyze() {
    st.result = st.file ? disassembleAll(st.data, options()) : null;
    // where the run of each byte's type starts: the graphics in the lines count their chars, cells, tiles from there
    if (st.result) {
      const t = st.result.types, starts = new Int32Array(t.length);
      for (let i = 1; i < t.length; i++) starts[i] = t[i] === t[i - 1] ? starts[i - 1] : i;
      st.runStart = starts;
    }
    update();
  }

  function options() {
    const lay = st.layout;
    return { ...st.cfg, cpu: cpu(), machine: machine(), split: lay?.split ?? st.data.length,
      entries: [...(lay?.entries ?? []), ...st.cfg.entries], noBase: !!lay?.entries.length };
  }

  function save() {
    if (!st.file) return;
    const all = { ...(readSettings().disassembler ?? {}) };
    const { base, auto, regions, entries, machine: m, names, source: src } = st.cfg;
    all[st.file] = { base, auto, regions, entries, ...(m ? { machine: m } : {}), ...(names && Object.keys(names).length ? { names } : {}), ...(src ? { source: src } : {}) };
    writeSettings({ disassembler: all });
  }

  // a change of the settings of the file, undone with Ctrl+Z
  function change(fn) {
    st.undo.push(JSON.stringify(st.cfg));
    if (st.undo.length > 200) st.undo.shift();
    st.redo = [];
    fn(st.cfg);
    save();
    analyze();
  }
  const undo = () => { if (!st.undo.length) return; st.redo.push(JSON.stringify(st.cfg)); st.cfg = JSON.parse(st.undo.pop()); save(); analyze(); };
  const redo = () => { if (!st.redo.length) return; st.undo.push(JSON.stringify(st.cfg)); st.cfg = JSON.parse(st.redo.pop()); save(); analyze(); };

  function mark(type, range = sel()) {
    if (!st.file || !st.data.length) return;
    const [a, b] = range;
    change(c => { c.regions = markRange(c.regions, a, b, type); });
    snackbar(type === 'none' ? `$${hex4(addr(a))}-$${hex4(addr(b))} unmarked` : `$${hex4(addr(a))}-$${hex4(addr(b))} marked as ${typeName(type).toLowerCase()}`);
  }

  const parseNum = t => { t = t.trim(); const v = /^(\$|0x)/i.test(t) ? parseInt(t.replace(/^(\$|0x)/i, ''), 16) : /^[0-9a-f]+$/i.test(t) && /[a-f]/i.test(t) ? parseInt(t, 16) : Number(t); return Number.isFinite(v) ? v & 0xffff : null; };

  // --- moving ------------------------------------------------------------------------------------------

  // the index of the line that holds offset off
  function lineIndex(off) {
    const L = lines();
    let lo = 0, hi = L.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (L[m].off <= off) lo = m; else hi = m - 1; }
    return lo;
  }

  function moveTo(at, { extend = false, reveal = 'both' } = {}) {
    at = Math.max(0, Math.min(at, st.data.length - 1));
    if (extend) st.anchor ??= st.cursor; else st.anchor = null;
    st.cursor = at;
    if (reveal === 'both' || reveal === 'hex') revealHex();
    if (reveal === 'both' || reveal === 'dis') revealDis();
    update();
  }
  // a line selects its bytes
  function selectLine(k, reveal = 'hex') {
    const l = lines()[k];
    if (!l) return;
    st.anchor = l.len > 1 ? l.off : null;
    st.cursor = l.off + l.len - 1;
    if (st.anchor == null) st.cursor = l.off;
    if (reveal === 'hex' || reveal === 'both') revealHex();
    if (reveal === 'dis' || reveal === 'both') revealDis();
    update();
  }
  // the target of the operand of the line at the cursor; Backspace comes back
  function follow() {
    const l = lines()[lineIndex(st.cursor)];
    if (l?.ref == null) return snackbar('The line points nowhere in the file', { error: true });
    st.back.push(st.cursor);
    selectLine(lineIndex(l.ref), 'both');
  }
  function goBack() { if (st.back.length) selectLine(lineIndex(st.back.pop()), 'both'); }

  function revealHex() {
    if (!hexEl) return;
    const y = Math.floor(st.cursor / st.width) * ROW_H;
    if (y < hexEl.scrollTop) hexEl.scrollTop = y;
    else if (y + ROW_H > hexEl.scrollTop + hexEl.clientHeight) hexEl.scrollTop = y + ROW_H - hexEl.clientHeight;
  }
  function revealDis() {
    if (!disEl) return;
    const y = lineIndex(st.cursor) * ROW_H;
    if (y < disEl.scrollTop || y + ROW_H > disEl.scrollTop + disEl.clientHeight) disEl.scrollTop = Math.max(0, y - disEl.clientHeight / 3);
  }

  async function gotoAddress() {
    const v = await promptDialog({ title: 'Go to', ok: 'Go', fields: [{ name: 'at', label: 'Address ($c000) or label (l_c000)', value: '', mono: true }] });
    if (!v) return;
    const t = v.at.trim();
    const lab = [...(st.result?.labels ?? [])].find(([, n]) => n === t);
    const a = lab ? lab[0] : parseNum(t);
    if (a == null || a < st.cfg.base || a >= st.cfg.base + st.data.length) return snackbar(`${t} is not in the file`, { error: true });
    st.back.push(st.cursor);
    selectLine(lineIndex(a - st.cfg.base), 'both');
  }

  // a label of its own for the line at the cursor: every operand that points there, and the source, use
  // it (cfg.names: { 'c000': 'main' }); an empty name gives the line its l_c000 / d_c000 again
  async function renameLabel(k = lineIndex(st.cursor)) {
    const l = lines()[k];
    if (!st.file || !l) return;
    const key = hex4(l.addr), own = st.cfg.names?.[key];
    const taken = name => {
      if (MNEMONIC_NAMES.has(name.toLowerCase())) return `${name} is an instruction`;
      const other = [...(st.result?.labels ?? [])].find(([a, n]) => n.toLowerCase() === name.toLowerCase() && a !== l.addr);
      if (other) return `$${hex4(other[0])} is called ${other[1]}`;
      if (st.result?.symbols?.has(name) || [...(st.result?.symbols?.keys() ?? [])].some(s => s.toLowerCase() === name.toLowerCase())) return `${name} is a register of the machine`;
      return null;
    };
    const v = await promptDialog({ title: `The label at $${key}`, ok: 'Rename', fields: [{
      name: 'name', label: 'Name (empty: the name of its address)', value: own ?? l.label ?? '', mono: true,
      validate: t => (!t.trim() ? null : !/^[A-Za-z_][\w]*$/.test(t.trim()) ? 'letters, digits and _, not first a digit' : /^[ld]_[0-9a-f]{4}$/i.test(t.trim()) ? 'a name of its own (l_xxxx and d_xxxx are the names of the addresses)' : taken(t.trim())),
    }] });
    if (!v) return;
    const name = v.name.trim();
    if ((name || undefined) === own) return;
    const before = l.label;
    change(c => {
      c.names = { ...(c.names ?? {}) };
      if (name) c.names[key] = name; else delete c.names[key];
    });
    // every reference in the disassembly follows by itself (its names); the source saved from it too
    const after = st.result?.labels.get(l.addr) ?? name;
    const src = st.cfg.source && hasFile(st.cfg.source) ? st.cfg.source : null;
    const there = src && before && after && before !== after ? hooks.renameInSource?.(src, before, after) ?? 0 : 0;
    snackbar(`${name ? `$${key} is ${name} now` : `$${key} has its own name again`}${there ? ` - and in ${src} (${there} place${there === 1 ? '' : 's'})` : ''} - Ctrl+Z undoes it here`);
  }

  // --- the source ----------------------------------------------------------------------------------------

  const source = () => {
    const name = st.file.replace(/^build:/, '').split('/').pop(), ext = (/\.([^.]*)$/.exec(name)?.[1] ?? 'bin').toLowerCase();
    const prg = st.layout?.source === 'prg';
    return toSource(st.result, { ...options(), name, head: prg ? null : st.bytes.subarray(0, st.head),
      format: { ext: prg ? 'prg' : ext, kind: prg ? 'cbm' : 'plain' } });
  };
  async function copySource() {
    if (!st.result) return;
    await navigator.clipboard.writeText(source());
    snackbar('Copied as ACME source');
  }
  async function saveSource() {
    if (!st.result) return;
    const stem = st.file.replace(/^build:/, '').split('/').pop().replace(/\.[^.]*$/, '').replace(/\W/g, '_');
    const v = await promptDialog({ title: 'Save the disassembly', ok: 'Save', fields: [
      { name: 'path', label: 'Path', value: `src/${stem}_dis.asm`, mono: true, validate: p => (!/^[\w./-]+\.(asm|a|s)$/i.test(p) ? 'a path ending in .asm .a or .s' : null) }] });
    if (!v) return;
    const existed = hasFile(v.path);
    writeText(v.path, source());
    // the source of this file: a label renamed here later is renamed there too
    st.cfg.source = v.path;
    save();
    snackbar(`${v.path} ${existed ? 'replaced' : 'saved'}`);
    hooks.openSource?.(v.path);
  }

  // --- keys ------------------------------------------------------------------------------------------------

  function commonKey(e) {
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return true; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return true; }
    if (mod && k === 'g') { e.preventDefault(); gotoAddress(); return true; }
    if (mod && e.shiftKey && k === 'c') { e.preventDefault(); copySource(); return true; }
    if (mod && k === 'a') { e.preventDefault(); st.anchor = 0; st.cursor = st.data.length - 1; update(); return true; }
    if (!mod && !e.altKey && MARK_KEYS[k]) { e.preventDefault(); mark(MARK_KEYS[k]); return true; }
    if (e.key === 'Escape') { st.anchor = null; update(); return true; }
    return false;
  }
  function onDisKey(e) {
    if (commonKey(e)) return;
    const rows = Math.max(1, Math.floor((disEl?.clientHeight ?? 400) / ROW_H) - 1);
    const moves = { ArrowUp: -1, ArrowDown: 1, PageUp: -rows, PageDown: rows };
    if (e.key in moves) {
      e.preventDefault();
      const k = Math.max(0, Math.min(lines().length - 1, lineIndex(st.cursor) + moves[e.key]));
      if (e.shiftKey) { st.anchor ??= st.cursor; st.cursor = lines()[k].off; revealDis(); revealHex(); update(); } else selectLine(k, 'both');
      return;
    }
    if (e.key === 'Home' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); selectLine(0, 'both'); return; }
    if (e.key === 'End' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); selectLine(lines().length - 1, 'both'); return; }
    if (e.key === 'Enter') { e.preventDefault(); follow(); return; }
    if (e.key === 'F2') { e.preventDefault(); renameLabel(); return; }
    if (e.key === 'Backspace') { e.preventDefault(); goBack(); }
  }
  function onHexKey(e) {
    if (commonKey(e)) return;
    const w = st.width, rows = Math.max(1, Math.floor((hexEl?.clientHeight ?? 400) / ROW_H) - 1);
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -w, ArrowDown: w, PageUp: -w * rows, PageDown: w * rows };
    if (e.key in moves) { e.preventDefault(); moveTo(st.cursor + moves[e.key], { extend: e.shiftKey }); return; }
    if (e.key === 'Home') { e.preventDefault(); moveTo(e.ctrlKey ? 0 : st.cursor - st.cursor % w, { extend: e.shiftKey }); return; }
    if (e.key === 'End') { e.preventDefault(); moveTo(e.ctrlKey ? st.data.length - 1 : st.cursor - st.cursor % w + w - 1, { extend: e.shiftKey }); }
  }

  // --- the panels ------------------------------------------------------------------------------------------

  function barView() {
    version.value;    // eslint-disable-line no-unused-expressions
    if (!isOpen()) return null;
    const list = files(), none = !st.file;
    return h('div', { class: 'screen-bar' },
      h('span', { class: 'md-title-medium' }, 'Disassembler'),
      h('span', { class: 'screen-bar__sep' }),
      select({ label: 'File', hideLabel: true, dense: true, value: st.file ?? '', cls: 'ns-hex__file',
        options: [{ value: '', label: list.length ? 'choose a file…' : 'no programs' }, ...list.map(p => ({ value: p, label: fileLabel(p) }))],
        onchange: v => open(v || null) }),
      iconButton('upload_file', 'Open a file from the disk (or drop it on the view)', openDisk),
      isExternal(st.file) && iconButton('note_add', 'Add the file to the project', addExternalFile),
      h('span', { class: 'screen-bar__sep' }),
      checkbox('Auto', st.cfg.auto, on => change(c => { c.auto = on; }), { tip: 'Auto: find the code by tracing it from its entry points, the rest is data', disabled: none }),
      h('span', { class: 'screen-bar__sep' }),
      iconButton('undo', 'Undo (Ctrl+Z)', undo, '', { disabled: !st.undo.length }),
      iconButton('redo', 'Redo (Ctrl+Y)', redo, '', { disabled: !st.redo.length }),
      h('span', { class: 'screen-bar__sep' }),
      iconButton('code', 'Mark the selection as code (C)', () => mark('code'), '', { disabled: none }),
      select({ label: 'Data type', hideLabel: true, dense: true, value: st.markType, cls: 'ns-bar__select',
        options: Object.entries(DATA_TYPES).map(([k, v]) => ({ value: k, label: v.name })), onchange: v => { st.markType = v; persist(); update(); } }),
      iconButton('data_object', 'Mark the selection as data of this type', () => mark(st.markType), '', { disabled: none }),
      iconButton('clear', 'Unmark the selection (U)', () => mark('none'), '', { disabled: none }),
      h('span', { class: 'screen-bar__sep' }),
      iconButton('arrow_forward', 'Go to an address or label (Ctrl+G)', gotoAddress, '', { disabled: none }),
      iconButton('label', 'Rename the label of the line (F2, or a double click on the label)', () => renameLabel(), '', { disabled: none }),
      iconButton('content_copy', 'Copy as ACME source (Ctrl+Shift+C)', copySource, '', { disabled: none }),
      iconButton('save_as', 'Save as ACME source in the project', saveSource, '', { disabled: none }),
      h('span', { class: 'screen-bar__sep' }),
      st.file && h('span', { class: 'md-body-small ns-dis__machine', 'data-i18n': 'off' }, `${machineOf(machine()).short} · ${cpu()}`),
      select({ label: 'Text', hideLabel: true, dense: true, value: st.text, cls: 'ns-bar__select',
        options: Object.entries(TEXTS).map(([k, v]) => ({ value: k, label: v.name })), onchange: v => { st.text = v; persist(); update(); } }),
      select({ label: 'Row', hideLabel: true, dense: true, value: String(st.width), cls: 'ns-hex__width',
        options: [8, 16].map(n => ({ value: String(n), label: `${n} bytes` })), onchange: v => { st.width = Number(v); persist(); update(); } }),
      h('div', { class: 'app-bar__spacer' }),
      st.file && h('span', { class: 'md-body-small ns-caret', 'data-i18n': 'off' }, `$${hex4(addr(st.cursor))} · ${st.data.length} bytes · ${st.cfg.auto ? 'auto' : 'manual'}`));
  }

  // the graphics of a line of chars, sprites, a bitmap or tiles, drawn in the line in the colors of the preview:
  // a pixel row of a char or a sprite (8 lines in a row show the char), a cell of a bitmap, the whole tile on its first line
  function inlineGfx(l) {
    const g = GFX[l.type], p = st.preview;
    const tileMode = ['nes', 'snes2', 'snes4'].includes(p.mode) ? p.mode : 'nes';
    const draw = cv => {
      if (!cv) return;
      if (l.type === 'chars' || l.type === 'sprites') return drawRow(cv, st.data.subarray(l.off, l.off + l.len), p, g.px);
      if (l.type === 'bitmap') return drawPreview(cv, st.data.subarray(l.off, l.off + 8), { ...p, mode: 'chars', zoom: 2 });
      const size = PREVIEW[tileMode].size, at = l.off - (st.runStart?.[l.off] ?? 0);
      if (at % size !== 0) { cv.width = cv.height = 0; return; }
      drawPreview(cv, st.data.subarray(l.off, l.off + size), { ...p, mode: tileMode, zoom: 2 });
    };
    return h('span', { class: 'ns-dis__gfx', style: { width: `${g.width}px` } }, h('canvas', { ref: draw }));
  }

  // the lines of the disassembly in view
  function disView() {
    const L = lines(), [a, b] = sel(), cur = lineIndex(st.cursor);
    // the selection: one frame around its lines
    const top = st.anchor != null ? lineIndex(a) : cur, bottom = st.anchor != null ? lineIndex(b) : cur;
    const height = disEl?.clientHeight ?? 600;
    const first = Math.max(0, Math.floor(st.scrollDis / ROW_H) - 2), last = Math.min(L.length, first + Math.ceil(height / ROW_H) + 5);
    const rows = [];
    for (let k = first; k < last; k++) {
      const l = L[k];
      const bytes = [...st.data.subarray(l.off, l.off + Math.min(l.len, 3))].map(hex2).join(' ') + (l.len > 3 ? ' …' : '');
      const on = st.anchor != null ? l.off <= b && l.off + l.len - 1 >= a : k === cur;
      rows.push(h('div', { class: `ns-dis__line ns-type--${l.type} ${on ? 'ns-dis__line--sel' : ''} ${on && k === top ? 'ns-dis__line--sel-top' : ''} ${on && k === bottom ? 'ns-dis__line--sel-bottom' : ''} ${k === cur ? 'ns-dis__line--cur' : ''} ${st.result.marked[l.off] ? 'ns-dis__line--marked' : ''}`,
        style: { top: `${k * ROW_H}px` },
        onpointerdown: e => { e.preventDefault(); disEl?.focus({ preventScroll: true }); st.focus = 'dis';
          if (e.shiftKey) { st.anchor ??= st.cursor; st.cursor = l.off + l.len - 1; revealHex(); update(); } else selectLine(k); },
        ondblclick: () => { if (l.ref != null) follow(); } },
      h('span', { class: 'ns-dis__addr' }, hex4(l.addr)),
      h('span', { class: 'ns-dis__bytes' }, bytes),
      // a double click on the label renames it (F2); a name of the user stands out
      h('span', { class: `ns-dis__label ${st.cfg.names?.[hex4(l.addr)] ? 'ns-dis__label--own' : ''}`, title: 'Double click or F2: rename the label',
        ondblclick: e => { e.stopPropagation(); renameLabel(k); } }, l.label ?? ''),
      st.preview.inline && GFX[l.type] && inlineGfx(l),
      h('span', { class: `ns-dis__text ${l.ref != null ? 'ns-dis__text--ref' : ''} ${l.view ? 'ns-dis__text--basic' : ''}`, title: l.view ? l.text : undefined }, l.view ?? l.text),
      (l.view ? l.note : l.comment) && h('span', { class: 'ns-dis__comment' }, `; ${l.view ? l.note : l.comment}`)));
    }
    return h('div', { class: 'ns-dis__list', tabindex: 0, onkeydown: onDisKey, 'data-i18n': 'off',
      ref: n => { if (n && disEl !== n) { disEl = n; n.scrollTop = st.scrollDis; attach(n); } },
      onscroll: e => { st.scrollDis = e.target.scrollTop; update(); } },
    h('div', { class: 'ns-hex__space', style: { height: `${L.length * ROW_H}px` } }, rows));
  }

  // the bytes in view, coloured by their type; dragged over they are selected
  function hexView() {
    const d = st.data, w = st.width, types = st.result?.types ?? [], marked = st.result?.marked ?? [];
    const total = Math.ceil(Math.max(d.length, 1) / w);
    const height = hexEl?.clientHeight ?? 600;
    const first = Math.max(0, Math.floor(st.scrollHex / ROW_H) - 2), last = Math.min(total, first + Math.ceil(height / ROW_H) + 5);
    const [a, b] = sel(), T = TEXTS[st.text];
    const rows = [];
    for (let r = first; r < last; r++) {
      const off = r * w, hex = [], txt = [];
      for (let k = 0; k < w; k++) {
        const i = off + k, has = i < d.length;
        const cls = `ns-hex__b ${has ? `ns-type--${types[i]}` : ''} ${has && marked[i] ? 'ns-dis__b--marked' : ''} ${i >= a && i <= b && st.anchor != null ? 'ns-hex__b--sel' : ''} ${i === st.cursor ? 'ns-hex__b--cur ns-hex__b--cur-hex' : ''} ${k && k % 8 === 0 ? 'ns-hex__b--gap' : ''}`;
        hex.push(h('span', { class: cls, 'data-i': has ? i : undefined }, has ? hex2(d[i]) : '  '));
        txt.push(h('span', { class: `ns-hex__b ${i >= a && i <= b && st.anchor != null ? 'ns-hex__b--sel' : ''} ${T.c64 ? 'ns-hex__c64' : ''}`, 'data-i': has ? i : undefined }, has ? T.char(d[i]) : ' '));
      }
      rows.push(h('div', { class: 'ns-hex__row', style: { top: `${r * ROW_H}px` } },
        h('span', { class: 'ns-hex__off' }, hex4(addr(off))), h('span', { class: 'ns-hex__hex' }, hex), h('span', { class: 'ns-hex__txt' }, txt)));
    }
    const at = e => { const n = e.target.closest?.('[data-i]'); return n ? Number(n.dataset.i) : null; };
    return h('div', { class: 'ns-hex ns-dis__hex', tabindex: 0, onkeydown: onHexKey, 'data-i18n': 'off',
      ref: n => { if (n && hexEl !== n) { hexEl = n; n.scrollTop = st.scrollHex; attach(n); } },
      onscroll: e => { st.scrollHex = e.target.scrollTop; update(); },
      onpointerdown: e => {
        const i = at(e);
        if (i == null || e.button !== 0) return;
        e.preventDefault();
        hexEl?.focus({ preventScroll: true });
        st.focus = 'hex';
        dragging = true;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        moveTo(i, { extend: e.shiftKey, reveal: 'dis' });
      },
      onpointermove: e => {
        if (!dragging) return;
        const n = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.ns-dis__hex [data-i]');
        if (!n) return;
        const i = Number(n.dataset.i);
        if (i !== st.cursor) { st.anchor ??= st.cursor; st.cursor = i; update(); }
      },
      onpointerup: () => { if (dragging) { dragging = false; revealDis(); update(); } },
      onpointercancel: () => { dragging = false; } },
    h('div', { class: 'ns-hex__space', style: { height: `${total * ROW_H}px` } }, rows));
  }

  // --- the side panel ------------------------------------------------------------------------------------------

  const row = (k, v) => h('div', { class: 'ns-insp__row' }, h('span', { class: 'ns-insp__k' }, k), h('span', { class: 'ns-insp__v', 'data-i18n': 'off' }, v));

  function selectionSection() {
    const [a, b] = sel(), types = st.result.types;
    const kinds = [...new Set(types.slice(a, b + 1))];
    return section('Selection', h('div', { class: 'ns-insp' },
      row('Range', `$${hex4(addr(a))}–$${hex4(addr(b))}`),
      row('Bytes', String(b - a + 1)),
      row('Type', kinds.map(typeName).join(', ')),
      h('div', { class: 'ns-dis__marks' }, TYPES.map(t => h('button', { class: `ns-dis__mark ns-type--${t}`, type: 'button', 'data-tip': `Mark as ${typeName(t).toLowerCase()}`, onclick: () => mark(t) }, typeName(t))),
        h('button', { class: 'ns-dis__mark', type: 'button', 'data-tip': 'Remove the marks: auto mode decides', onclick: () => mark('none') }, 'Unmark')),
      h('div', { class: 'section__hint', 'data-i18n': 'off' }, 'Drag over the bytes to select · C code · D bytes · W words · T text · P PETSCII · S screen codes · H chars · R sprites · M bitmap · I tiles · U unmark')));
  }

  function analysisSection() {
    const r = st.result, code = r.types.filter(t => t === 'code').length;
    return section('Analysis', h('div', { class: 'ns-insp' },
      checkbox('Auto: trace the code from its entry points', st.cfg.auto, on => change(c => { c.auto = on; })),
      h('div', { class: 'ns-insp__base' },
        select({ label: 'Machine', dense: true, value: machine(), options: MACHINES.map(m => ({ value: m.id, label: `${m.name} (${m.cpu})` })),
          onchange: v => change(c => { c.machine = v === (st.layout?.machine || readSettings().machine) ? null : v; }) })),
      h('div', { class: 'ns-insp__base' },
        field({ label: 'Load address', dense: true, mono: true, value: '$' + hex4(st.cfg.base), disabled: !!st.layout,
          support: st.layout ? (st.layout.note ?? 'from the file') : null,
          onchange: (v, f) => { const a = parseNum(v); if (a == null) return f.setError('an address like $c000'); change(c => { c.base = a; }); } })),
      h('div', { class: 'ns-insp__base' },
        field({ label: 'More entry points', dense: true, mono: true, value: st.cfg.entries.map(a => '$' + hex4(a)).join(', '), placeholder: 'none',
          onchange: (v, f) => {
            const list = v.split(/[\s,]+/).filter(Boolean).map(parseNum);
            if (list.some(x => x == null)) return f.setError('addresses like $c000, $c100');
            change(c => { c.entries = list; });
          } })),
      r.basic && row('BASIC', `${r.basic.lines.length} line${r.basic.lines.length === 1 ? '' : 's'} to $${hex4(addr(r.basic.end - 1))}${r.basic.sys.length ? ` · SYS ${r.basic.sys.map(a => `${a} ($${hex4(a)})`).join(', ')}` : ''}`),
      row('Entries', r.entries.map(a => '$' + hex4(a)).join(', ') || '-'),
      row('Code', `${code} bytes`),
      row('Data', `${r.types.length - code} bytes`),
      row('Labels', String(r.labels.size))));
  }

  function regionsSection() {
    const regs = st.cfg.regions;
    return section(`Marks (${regs.length})`, regs.length
      ? h('div', { class: 'ns-outline' }, regs.map(r => h('div', { class: 'ns-dis__region' },
        h('button', { class: `ns-outline__item ns-dis__region-pick`, type: 'button', onclick: () => { st.anchor = r.start; st.cursor = r.end; revealHex(); revealDis(); update(); } },
          h('span', { class: `ns-dis__swatch ns-type--${r.type}` }), h('span', { 'data-i18n': 'off' }, `$${hex4(addr(r.start))}–$${hex4(addr(r.end))}`), h('span', { class: 'ns-insp__k' }, typeName(r.type))),
        iconButton('close', 'Remove the mark', () => mark('none', [r.start, r.end])))))
      : h('div', { class: 'section__hint' }, st.cfg.auto ? 'Nothing marked: auto mode decides what is code and what is data.' : 'Nothing marked: every byte is code.'));
  }

  // the bytes of the preview: the selection, else from the cursor on
  function previewRange() {
    const P = PREVIEW[st.preview.mode];
    if (st.anchor != null) { const [a, b] = sel(); return [a, b]; }
    return [st.cursor, Math.min(st.data.length, st.cursor + P.size * P.many) - 1];
  }

  function previewSection() {
    const p = st.preview, P = PREVIEW[p.mode];
    const [a, b] = previewRange(), bytes = st.data.subarray(a, b + 1);
    const count = Math.ceil(bytes.length / P.size);
    const set = change => { Object.assign(st.preview, change); persist(); update(); };
    const colorSelect = (k, label) => select({ label, dense: true, value: String(p.colors[k]), cls: 'ns-dis__color',
      options: COLOR_NAMES.map((n, c) => ({ value: String(c), label: `${c} ${n}` })), onchange: v => { const colors = [...p.colors]; colors[k] = Number(v); set({ colors }); } });
    return section('Preview', h('div', { class: 'ns-dis__preview' },
      segmented(Object.entries(PREVIEW).map(([k, v]) => ({ value: k, label: v.name })), p.mode, v => set({ mode: v }), [], 'md-segmented--fill'),
      checkbox('Draw the graphics in the disassembly too', p.inline, on => set({ inline: on }), { tip: 'Lines of chars, sprites, a bitmap or tiles show their pixels in these colors' }),
      h('div', { class: 'ns-dis__preview-opts' },
        !P.pens && checkbox('Multicolor', p.mc, on => set({ mc: on })),
        segmented([1, 2, 3, 4].map(z => ({ value: String(z), label: `${z}×` })), String(p.zoom), v => set({ zoom: Number(v) }))),
      h('div', { class: 'ns-dis__colors' },
        colorSelect(0, P.pens ? 'Pen 0' : 'Background'), (p.mc || P.pens) && colorSelect(1, P.pens ? 'Pen 1' : 'Bits 01'),
        (p.mc || P.pens) && colorSelect(2, P.pens ? 'Pen 2' : 'Bits 10'), colorSelect(3, P.pens ? 'Pen 3' : p.mc ? 'Bits 11' : 'Pixels')),
      h('div', { class: 'ns-dis__canvas' }, h('canvas', { ref: cv => { if (cv) drawPreview(cv, bytes, p); } })),
      h('div', { class: 'section__hint', 'data-i18n': 'off' },
        `${count} ${{ chars: 'char', sprites: 'sprite', bitmap: 'bitmap' }[p.mode] ?? 'tile'}${count === 1 ? '' : 's'} from $${hex4(addr(a))} (${bytes.length} bytes) · ${st.anchor != null ? 'the selection' : 'from the cursor on'}${P.pens === 16 ? ' · pens 4-15: the C64 colors' : ''}`),
      button(`Mark as ${typeName(P.type ?? p.mode).toLowerCase()}`, { icon: 'data_object', variant: 'tonal', disabled: !bytes.length,
        onclick: () => mark(P.type ?? p.mode, [a, b]) })));
  }

  // the register of the machine the line at the cursor names: what it is, the value stored, its bits
  function registerSection() {
    const l = lines()[lineIndex(st.cursor)];
    if (!l?.sym) return null;
    const s = l.sym, bits = describeBits(machine(), s.name);
    return section('Register', h('div', { class: 'ns-insp' },
      row('Name', s.offset ? `${s.name} + ${s.offset}` : s.name),
      row('Address', `$${hex4(s.addr)}`),
      h('div', { class: 'ns-dis__desc' }, s.desc),
      l.value != null && row('Value', `$${hex2(l.value & 0xff)} · %${(l.value & 0xff).toString(2).padStart(8, '0')}`),
      l.value != null && bits.length ? h('div', { class: 'ns-dis__desc' }, decodeBits(machine(), s.name, l.value)) : null,
      bits.length ? h('table', { class: 'ns-dis__bits' }, bits.map(b => h('tr', {}, h('td', {}, b.where), h('td', {}, b.what)))) : null));
  }

  function inspector() {
    if (!st.file) return h('div', { class: 'section__hint' }, 'Choose a program in the bar.');
    return [selectionSection(), registerSection(), analysisSection(), regionsSection(), previewSection(),
      section('Keys', h('div', { class: 'section__hint', 'data-i18n': 'off' },
        'Disassembly: arrows · Enter or double click follows a jump · Backspace comes back · Ctrl+G goes to · F2 renames a label · Bytes: drag or Shift+arrows select · Ctrl+Z undoes a mark'))];
  }

  function bodyView() {
    version.value;    // eslint-disable-line no-unused-expressions
    if (!isOpen()) return null;
    return h('div', { class: 'screen-body' },
      h('div', { class: 'screen-main' },
        st.file ? h('div', { class: 'ns-dis', style: { '--ns-dis-hex': st.width } }, disView(), hexView())
          : h('div', { class: 'empty-state' }, icon('code'), h('div', { class: 'md-title-medium' }, 'No program open'),
            h('div', { class: 'md-body-medium' }, 'A program of the project or of the last build: its code and its data, side by side with its bytes. Or drop a file from outside here: a .prg, .nes, .sfc, .a26 or any binary.'),
            h('div', { class: 'start-screen__actions' }, button('Open a file from the disk', { icon: 'upload_file', variant: 'filled', onclick: openDisk })))),
      sidePanel('Disassembler', inspector()));
  }

  async function openDisk() { const p = await pickFile(); if (p) open(p); }
  async function addExternalFile() { const p = await addToProject(st.file); if (p) open(p); }

  function render() {
    if (!views) dropTarget(el, paths => open(paths[0]));
    views ??= [mount(bar, barView), mount(el, bodyView)];
    if (st.file && !st.result) analyze();
    update();
  }

  return {
    render, open,
    current: () => st.file,
    refreshBuild: () => { if (st.file?.startsWith('build:')) { const keep = st.cursor; open(st.file); moveTo(keep); } else update(); },
    reset: () => { st.file = null; st.data = new Uint8Array(0); st.result = null; update(); },
    exportFormats: () => (st.result ? [{ label: `${st.file.replace(/^build:/, '').split('/').pop().replace(/\.[^.]*$/, '')}.asm (disassembly)`, icon: 'code',
      name: `${st.file.replace(/^build:/, '').split('/').pop().replace(/\.[^.]*$/, '')}.asm`, type: 'text/plain', description: 'ACME source', bytes: () => new TextEncoder().encode(source()) }] : []),
    findNext: (text, dir) => {
      const q = text.trim().toLowerCase(), L = lines();
      if (!q || !L.length) return false;
      const from = lineIndex(st.cursor);
      for (let s = 1; s <= L.length; s++) {
        const k = (from + dir * s + L.length * 2) % L.length;
        if (`${L[k].label ?? ''} ${L[k].text} ${hex4(L[k].addr)}`.toLowerCase().includes(q)) { selectLine(k, 'both'); return true; }
      }
      snackbar(`'${text.trim()}' is not in the disassembly`, { error: true });
      return false;
    },
  };
}

// --- the preview -----------------------------------------------------------------------------------------------

// the graphics in the lines of the disassembly: how wide their column is, the width of a pixel of a row
const GFX = { chars: { width: 84, px: 10 }, sprites: { width: 148, px: 6 }, bitmap: { width: 20 }, tiles: { width: 20 } };

// a pixel row of chars or sprites: bytes side by side, hires or multicolor
function drawRow(cv, bytes, { mc, colors }, px) {
  const W = bytes.length * 8;
  cv.width = W; cv.height = 1;
  cv.style.width = `${W * px}px`;
  cv.style.height = '20px';                                // the whole line: the rows of a char touch
  const ctx = cv.getContext('2d'), img = ctx.createImageData(W, 1);
  const pens = mc ? colors : [colors[0], colors[3]];
  for (let x = 0; x < W; x++) {
    const v = bytes[x >> 3], xb = x & 7;
    const [r, g, b] = RGB[pens[mc ? (v >> (6 - (xb & 6))) & 3 : (v >> (7 - xb)) & 1]];
    img.data.set([r, g, b, 255], x * 4);
  }
  ctx.putImageData(img, 0, 0);
}

const RGB = PALETTE.map(c => [1, 3, 5].map(k => parseInt(c.slice(k, k + 2), 16)));

// the bytes as chars, sprites or a bitmap of the C64: hires or multicolor, with a gap between the things
export function drawPreview(cv, bytes, { mode, mc, colors, zoom }) {
  const P = PREVIEW[mode];
  const count = Math.max(1, Math.ceil(bytes.length / P.size));
  const gap = mode === 'bitmap' ? 0 : 1;
  const cols = Math.min(P.cols, count);
  const rowsOf = mode === 'bitmap' ? 1 : Math.ceil(count / cols);
  const bh = mode === 'bitmap' ? Math.max(8, Math.ceil(bytes.length / 320) * 8) : P.h;
  const W = cols * (P.w + gap) - gap, H = rowsOf * (bh + gap) - gap;
  cv.width = W; cv.height = H;
  cv.style.width = `${W * zoom}px`;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(W, H);
  const px = img.data;
  const pens = P.pens ? [colors[0], colors[1], colors[2], colors[3], ...[4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]] : mc ? [colors[0], colors[1], colors[2], colors[3]] : [colors[0], colors[3]];
  for (let n = 0; n < count; n++) {
    const ox = (n % cols) * (P.w + gap), oy = Math.floor(n / cols) * (bh + gap);
    for (let y = 0; y < bh; y++) for (let x = 0; x < P.w; x++) {
      let at;
      if (P.pens) at = n * P.size;
      else if (mode === 'chars') at = n * 8 + y;
      else if (mode === 'sprites') at = n * 64 + y * 3 + (x >> 3);
      else at = ((y >> 3) * 40 + (x >> 3)) * 8 + (y & 7);
      if (at >= bytes.length) continue;
      const v = bytes[at], xb = x & 7;
      let pen;
      if (P.pens) {
        const bit = (o) => ((bytes[o] ?? 0) >> (7 - xb)) & 1;
        const t = n * P.size;
        if (mode === 'nes') pen = bit(t + y) | bit(t + 8 + y) << 1;                     // plane 0, then plane 1
        else pen = bit(t + y * 2) | bit(t + y * 2 + 1) << 1                             // planes 0 and 1 a row
          | (mode === 'snes4' ? bit(t + 16 + y * 2) << 2 | bit(t + 16 + y * 2 + 1) << 3 : 0);
      } else pen = mc ? (v >> (6 - (xb & 6))) & 3 : (v >> (7 - xb)) & 1;
      const [r, g, b] = RGB[pens[pen]];
      const o = ((oy + y) * W + ox + x) * 4;
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
