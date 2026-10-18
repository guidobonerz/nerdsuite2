// hexview.js - the Hex view: any file of the project, or of the last build, as bytes - hex and
// text side by side (ASCII, PETSCII, screen codes, ATASCII). A binary file can be edited: typed
// over in hex or as text, bytes inserted, deleted and filled, a range copied as hex or as ACME
// source (!byte lines). The side panel reads the bytes at the cursor as numbers and as 6502 / Z80
// code. A .prg shows the addresses of its load address. A file from outside the project - dropped on
// the view or opened from the disk (extfiles.js) - is shown read only, and can be added to the project.
//
// Only the rows in view are made (the files may be a megabyte); a row is 8, 16 or 32 bytes.

import { h, mount, signal, iconButton, select, field, promptDialog, snackbar, sidePanel, section, button, icon, confirmRemove } from './pui.js';
import { allFiles, hasFile, readBinary, writeBinary, BINARY_EXT, buildFiles, hasBuild, isOpen } from './project.js';
import { disassemble, hex2, hex4, readSettings, machineOf } from './nsbuild.js';
import { petsciiChar } from './petscii.js';
import { symbolsFor } from './memmap.js';
import { isExternal, externalFiles, readExternal, fileLabel, pickFile, dropTarget, addToProject } from './extfiles.js';

const ROW_H = 20;
const KEY = 'nerdsuite.hex';
const extOf = p => (/\.[^./]*$/.exec(p)?.[0] ?? '').toLowerCase();
const editable = p => !p.startsWith('build:') && !isExternal(p) && BINARY_EXT.includes(extOf(p));

// a byte as a character of the text column; css: the class that draws it (the C64 font)
export const TEXTS = {
  ascii: { name: 'ASCII', char: b => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.') },
  petscii: { name: 'PETSCII', c64: true, char: b => {
    const sc = b >= 0x20 && b < 0x40 ? b : b >= 0x40 && b < 0x60 ? b - 0x40 : b >= 0x60 && b < 0x80 ? b - 0x20
      : b >= 0xa0 && b < 0xc0 ? b - 0x40 : b >= 0xc0 && b < 0xff ? b - 0x80 : b === 0xff ? 0x5e : null;
    return sc == null ? '.' : petsciiChar(sc, 'upper');
  } },
  screen: { name: 'Screen codes', c64: true, char: b => petsciiChar(b, 'upper') },
  atascii: { name: 'ATASCII', char: b => { const c = b & 0x7f; return c >= 0x20 && c < 0x7d ? String.fromCharCode(c) : '.'; } },
};
// what a typed character writes in the text column
const fromChar = {
  ascii: c => c.charCodeAt(0) & 0xff,
  petscii: c => { const k = c.charCodeAt(0); return k >= 97 && k <= 122 ? k - 32 : k >= 65 && k <= 90 ? k + 0x80 : k & 0xff; },
  screen: c => { const k = c.charCodeAt(0); return k >= 97 && k <= 122 ? k - 96 : k >= 64 && k <= 95 ? k - 64 : k & 0x3f; },
  atascii: c => c.charCodeAt(0) & 0x7f,
};

export function createHexView(el, bar, hooks = {}) {
  const st = {
    file: null, data: new Uint8Array(0), saved: null,
    cursor: 0, anchor: null, nibble: 0, column: 'hex',
    width: 16, text: 'petscii', base: null,      // base: the address of byte 0 (a .prg: its load address)
    undo: [], redo: [],
    scroll: 0, find: '',
  };
  try { Object.assign(st, JSON.parse(localStorage.getItem(KEY) ?? '{}')); } catch { /* none */ }
  st.data = new Uint8Array(0); st.undo = []; st.redo = []; st.cursor = 0; st.anchor = null;
  const version = signal(0);
  const update = () => { version.value++; };
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify({ width: st.width, text: st.text })); } catch { /* none */ } };
  let views = null, scroller = null;
  // the rows in view need the height of the grid: drawn again when the grid is new or changes its size
  const sized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => update());

  const dirty = () => !!st.file && editable(st.file) && st.saved !== null && !same(st.data, st.saved);
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const sel = () => (st.anchor == null ? [st.cursor, st.cursor] : [Math.min(st.anchor, st.cursor), Math.max(st.anchor, st.cursor)]);
  const prgFile = p => /\.prg$/i.test(p);
  // the offset of the data in the file that counts as address base (a .prg: after its load address)
  const addrOf = off => (st.base == null ? off : st.base + off - (prgFile(st.file) ? 2 : 0));

  // --- files ------------------------------------------------------------------------------------

  function files() {
    const list = isOpen() ? allFiles().filter(p => !p.startsWith('reference/')) : [];
    const built = hasBuild() ? [...buildFiles().keys()].map(n => `build:${n}`) : [];
    return [...list, ...built, ...externalFiles()];
  }

  async function open(path) {
    if (dirty() && !(await confirmRemove({ what: `the changes of ${st.file}`, verb: 'remove', undo: false }))) return;
    let data = null;
    if (path?.startsWith('build:')) data = buildFiles().get(path.slice(6)) ?? null;
    else if (isExternal(path)) data = readExternal(path);
    else if (path && hasFile(path)) data = readBinary(path);
    st.file = data ? path : null;
    st.data = data ? new Uint8Array(data) : new Uint8Array(0);
    st.saved = data ? new Uint8Array(data) : null;
    st.cursor = 0; st.anchor = null; st.nibble = 0; st.undo = []; st.redo = [];
    st.base = st.file && prgFile(st.file) && st.data.length >= 2 ? st.data[0] | st.data[1] << 8 : null;
    if (scroller) scroller.scrollTop = 0;
    update();
    hooks.onRoute?.();
    hooks.onDirty?.();
  }

  async function newFile() {
    const v = await promptDialog({ title: 'New binary file', ok: 'Create', fields: [
      { name: 'path', label: 'Path', value: 'data/table.bin', mono: true, validate: p => (!/^[\w./-]+\.(bin|raw|dat|prg|map|col)$/i.test(p) ? 'a path ending in .bin .raw .dat .prg .map or .col' : hasFile(p) ? 'there is such a file' : null) },
      { name: 'size', label: 'Size in bytes', value: '256', mono: true, validate: t => (/^\d+$/.test(t) && Number(t) > 0 && Number(t) <= 65536 ? null : '1 to 65536') },
      { name: 'fill', label: 'Filled with (hex)', value: '00', mono: true, validate: t => (/^[0-9a-f]{1,2}$/i.test(t) ? null : 'a hex byte') },
    ] });
    if (!v) return;
    writeBinary(v.path, new Uint8Array(Number(v.size)).fill(parseInt(v.fill, 16)));
    await open(v.path);
    snackbar(`${v.path} created`);
  }

  function saveChanges() {
    if (!dirty()) return true;
    writeBinary(st.file, st.data);
    st.saved = new Uint8Array(st.data);
    update();
    hooks.onDirty?.();
    return true;
  }

  // --- editing ----------------------------------------------------------------------------------

  function change(fn) {
    if (!st.file || !editable(st.file)) { snackbar('Only the binary files of the project can be changed (not sources or the build)', { error: true }); return false; }
    st.undo.push(st.data);
    if (st.undo.length > 200) st.undo.shift();
    st.redo = [];
    st.data = fn(new Uint8Array(st.data));
    st.cursor = Math.min(st.cursor, Math.max(0, st.data.length - 1));
    update();
    hooks.onDirty?.();
    return true;
  }
  const undo = () => { if (st.undo.length) { st.redo.push(st.data); st.data = st.undo.pop(); update(); hooks.onDirty?.(); } };
  const redo = () => { if (st.redo.length) { st.undo.push(st.data); st.data = st.redo.pop(); update(); hooks.onDirty?.(); } };

  function setByte(at, value, coalesce = false) {
    if (at >= st.data.length) {
      return change(d => { const out = new Uint8Array(at + 1); out.set(d); out[at] = value; return out; });
    }
    if (coalesce && st.undo.length) { st.data[at] = value; update(); hooks.onDirty?.(); return true; }   // the second nibble: one step
    return change(d => { d[at] = value; return d; });
  }

  function insert(count, value = 0) {
    const at = st.cursor;
    change(d => { const out = new Uint8Array(d.length + count); out.set(d.subarray(0, at)); out.fill(value, at, at + count); out.set(d.subarray(at), at + count); return out; });
  }
  function remove() {
    const [a, b] = sel();
    change(d => { const out = new Uint8Array(d.length - (b - a + 1)); out.set(d.subarray(0, a)); out.set(d.subarray(b + 1), a); return out; });
    st.anchor = null;
    st.cursor = Math.min(a, Math.max(0, st.data.length - 1));
    update();
  }
  async function fill() {
    const [a, b] = sel();
    const v = await promptDialog({ title: `Fill $${hex4(a)}-$${hex4(b)}`, ok: 'Fill', fields: [
      { name: 'bytes', label: 'Bytes (hex, repeated)', value: '00', mono: true, validate: t => (/^([0-9a-f]{1,2}\s*)+$/i.test(t) ? null : 'hex bytes like 00 or a9 01') }] });
    if (!v) return;
    const pat = v.bytes.trim().split(/\s+/).map(x => parseInt(x, 16));
    change(d => { for (let k = a; k <= b; k++) d[k] = pat[(k - a) % pat.length]; return d; });
  }

  // --- moving -----------------------------------------------------------------------------------

  function moveTo(at, extend = false) {
    const max = Math.max(0, st.data.length - (editable(st.file ?? '') ? 0 : 1));
    at = Math.max(0, Math.min(at, max));
    if (extend) st.anchor ??= st.cursor; else st.anchor = null;
    st.cursor = at;
    st.nibble = 0;
    reveal();
    update();
  }
  function reveal() {
    if (!scroller) return;
    const y = Math.floor(st.cursor / st.width) * ROW_H;
    if (y < scroller.scrollTop) scroller.scrollTop = y;
    else if (y + ROW_H > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = y + ROW_H - scroller.clientHeight;
  }

  async function gotoOffset() {
    const v = await promptDialog({ title: 'Go to', ok: 'Go', fields: [
      { name: 'at', label: st.base != null ? 'Address ($c000) or offset (+12)' : 'Offset ($10 or 16)', value: '', mono: true }] });
    if (!v) return;
    const t = v.at.trim();
    const num = s => (/^\$|^0x/i.test(s) ? parseInt(s.replace(/^\$|^0x/i, ''), 16) : Number(s));
    let at = t.startsWith('+') ? num(t.slice(1)) : num(t);
    if (!t.startsWith('+') && st.base != null) at = at - st.base + (prgFile(st.file) ? 2 : 0);
    if (!Number.isFinite(at)) return snackbar(`'${t}' is no offset`, { error: true });
    moveTo(at);
  }

  // find hex bytes ('a9 00') or "text"
  function find(text, dir = 1) {
    const t = text.trim();
    if (!t) return;
    let pat;
    if (/^".*"?$/.test(t)) pat = [...t.replace(/^"|"$/g, '')].map(c => fromChar[st.text](c));
    else if (/^([0-9a-f]{2}\s*)+$/i.test(t)) pat = t.split(/\s+/).flatMap(x => x.match(/../g)).map(x => parseInt(x, 16));
    else pat = [...t].map(c => fromChar.ascii(c));
    const d = st.data, n = pat.length;
    const hit = k => { for (let i = 0; i < n; i++) if (d[k + i] !== pat[i]) return false; return true; };
    for (let step = 1; step <= d.length; step++) {
      const k = (st.cursor + dir * step + d.length * 2) % d.length;
      if (k + n <= d.length && hit(k)) { st.anchor = k; st.cursor = k + n - 1; reveal(); update(); return true; }
    }
    snackbar(`'${t}' is not in the file`, { error: true });
    return false;
  }

  // --- the clipboard -------------------------------------------------------------------------------

  function selection() { const [a, b] = sel(); return st.data.subarray(a, b + 1); }
  async function copyHex() { await navigator.clipboard.writeText([...selection()].map(hex2).join(' ')); snackbar('Copied as hex'); }
  async function copyAcme() {
    const bytes = [...selection()], [a] = sel();
    const lines = [];
    for (let k = 0; k < bytes.length; k += 16) lines.push(`        !byte ${bytes.slice(k, k + 16).map(b => '$' + hex2(b)).join(', ')}`);
    const label = (st.file ?? 'data').split('/').pop().replace(/\.[^.]*$/, '').replace(/\W/g, '_');
    await navigator.clipboard.writeText(`${label}:                ; ${bytes.length} bytes of ${st.file} from ${st.base != null ? '$' + hex4(addrOf(a)) : 'offset ' + a}\n${lines.join('\n')}\n`);
    snackbar('Copied as ACME source (!byte lines)');
  }
  async function paste() {
    const t = (await navigator.clipboard.readText()).trim();
    if (!/^([0-9a-f]{2}[\s,]*)+$/i.test(t)) return snackbar('The clipboard holds no hex bytes', { error: true });
    const bytes = t.split(/[\s,]+/).filter(Boolean).flatMap(x => x.match(/../g)).map(x => parseInt(x, 16));
    const at = st.cursor;
    change(d => { const out = d.length < at + bytes.length ? (() => { const o = new Uint8Array(at + bytes.length); o.set(d); return o; })() : d; out.set(bytes, at); return out; });
    moveTo(at + bytes.length - 1);
  }

  // --- keys ----------------------------------------------------------------------------------------

  function onKey(e) {
    const mod = e.ctrlKey || e.metaKey;
    const w = st.width, rows = Math.max(1, Math.floor((scroller?.clientHeight ?? 400) / ROW_H) - 1);
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -w, ArrowDown: w, PageUp: -w * rows, PageDown: w * rows };
    if (e.key in moves) { e.preventDefault(); moveTo(st.cursor + moves[e.key], e.shiftKey); return; }
    if (e.key === 'Home') { e.preventDefault(); moveTo(mod ? 0 : st.cursor - st.cursor % w, e.shiftKey); return; }
    if (e.key === 'End') { e.preventDefault(); moveTo(mod ? st.data.length - 1 : st.cursor - st.cursor % w + w - 1, e.shiftKey); return; }
    if (e.key === 'Tab') { e.preventDefault(); st.column = st.column === 'hex' ? 'text' : 'hex'; st.nibble = 0; update(); return; }
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); if (e.shiftKey) copyAcme(); else copyHex(); return; }
    if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); paste(); return; }
    if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); st.anchor = 0; st.cursor = Math.max(0, st.data.length - 1); update(); return; }
    if (mod && e.key.toLowerCase() === 'g') { e.preventDefault(); gotoOffset(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); if (st.data.length) remove(); return; }
    if (e.key === 'Insert') { e.preventDefault(); insert(1); return; }
    if (e.key === 'Escape') { st.anchor = null; update(); return; }
    if (mod || e.altKey || e.key.length !== 1) return;
    if (st.column === 'hex') {
      if (!/^[0-9a-f]$/i.test(e.key)) return;
      e.preventDefault();
      const v = parseInt(e.key, 16), old = st.data[st.cursor] ?? 0;
      const next = st.nibble === 0 ? (v << 4) | (old & 0x0f) : (old & 0xf0) | v;
      if (!setByte(st.cursor, next, st.nibble === 1)) return;
      if (st.nibble === 0) { st.nibble = 1; update(); } else moveTo(st.cursor + 1);
    } else {
      e.preventDefault();
      if (setByte(st.cursor, fromChar[st.text](e.key))) moveTo(st.cursor + 1);
    }
  }

  // --- views ---------------------------------------------------------------------------------------

  function barView() {
    version.value;    // eslint-disable-line no-unused-expressions
    if (!isOpen()) return null;
    const list = files();
    return h('div', { class: 'screen-bar' },
      h('span', { class: 'md-title-medium' }, 'Hex'),
      h('span', { class: 'screen-bar__sep' }),
      select({ label: 'File', hideLabel: true, dense: true, value: st.file ?? '', cls: 'ns-hex__file',
        options: [{ value: '', label: list.length ? 'choose a file…' : 'no files' }, ...list.map(p => ({ value: p, label: fileLabel(p) }))],
        onchange: v => open(v || null) }),
      iconButton('add', 'New binary file', newFile),
      iconButton('upload_file', 'Open a file from the disk (or drop it on the view)', openDisk),
      isExternal(st.file) && iconButton('note_add', 'Add the file to the project', addExternalFile),
      h('span', { class: 'screen-bar__sep' }),
      iconButton('undo', 'Undo (Ctrl+Z)', undo, '', { disabled: !st.undo.length }),
      iconButton('redo', 'Redo (Ctrl+Y)', redo, '', { disabled: !st.redo.length }),
      h('span', { class: 'screen-bar__sep' }),
      iconButton('arrow_forward', 'Go to an offset or address (Ctrl+G)', gotoOffset, '', { disabled: !st.file }),
      iconButton('add_box', 'Insert a byte at the cursor (Ins)', () => insert(1), '', { disabled: !st.file || !editable(st.file) }),
      iconButton('delete', 'Delete the selected bytes (Del)', remove, '', { disabled: !st.file || !editable(st.file) || !st.data.length }),
      iconButton('format_color_fill', 'Fill the selection', fill, '', { disabled: !st.file || !editable(st.file) }),
      iconButton('content_copy', 'Copy as hex (Ctrl+C)', copyHex, '', { disabled: !st.data.length }),
      iconButton('code', 'Copy as ACME source: !byte lines (Ctrl+Shift+C)', copyAcme, '', { disabled: !st.data.length }),
      hooks.disassemble && iconButton('memory', 'Disassemble the file', () => hooks.disassemble(st.file), '', { disabled: !st.data.length }),
      h('span', { class: 'screen-bar__sep' }),
      select({ label: 'Text', hideLabel: true, dense: true, value: st.text, cls: 'ns-bar__select',
        options: Object.entries(TEXTS).map(([k, v]) => ({ value: k, label: v.name })), onchange: v => { st.text = v; persist(); update(); } }),
      select({ label: 'Row', hideLabel: true, dense: true, value: String(st.width), cls: 'ns-hex__width',
        options: [8, 16, 32].map(n => ({ value: String(n), label: `${n} bytes` })), onchange: v => { st.width = Number(v); persist(); update(); } }),
      h('div', { class: 'app-bar__spacer' }),
      st.file && h('span', { class: 'md-body-small ns-caret', 'data-i18n': 'off' },
        `${st.column === 'hex' ? 'HEX' : 'TEXT'} · ${dirty() ? 'changed · ' : ''}${st.data.length} bytes${editable(st.file) ? '' : ' · read only'}`));
  }

  // the rows in view: a spacer as high as all of them, the visible ones placed in it
  function gridView() {
    const d = st.data, w = st.width;
    const total = Math.ceil(Math.max(d.length, 1) / w);
    const height = scroller?.clientHeight ?? 600;
    const first = Math.max(0, Math.floor(st.scroll / ROW_H) - 2), last = Math.min(total, first + Math.ceil(height / ROW_H) + 5);
    const [a, b] = sel();
    const T = TEXTS[st.text];
    const rows = [];
    for (let r = first; r < last; r++) {
      const off = r * w;
      const hex = [], txt = [];
      for (let k = 0; k < w; k++) {
        const i = off + k, has = i < d.length;
        const cls = `ns-hex__b ${i >= a && i <= b && st.anchor != null ? 'ns-hex__b--sel' : ''} ${i === st.cursor ? `ns-hex__b--cur ns-hex__b--cur-${st.column}` : ''} ${k && k % 8 === 0 ? 'ns-hex__b--gap' : ''}`;
        hex.push(h('span', { class: cls, 'data-i': i, onpointerdown: e => { st.column = 'hex'; click(e, i); } }, has ? hex2(d[i]) : i === d.length && editable(st.file ?? '') ? '__' : '  '));
        txt.push(h('span', { class: `${cls} ${T.c64 ? 'ns-hex__c64' : ''}`, 'data-i': i, onpointerdown: e => { st.column = 'text'; click(e, i); } }, has ? T.char(d[i]) : ' '));
      }
      rows.push(h('div', { class: 'ns-hex__row', style: { top: `${r * ROW_H}px` } },
        h('span', { class: 'ns-hex__off' }, st.base != null ? hex4(addrOf(off) & 0xffff) : off.toString(16).padStart(6, '0')),
        h('span', { class: 'ns-hex__hex' }, hex), h('span', { class: 'ns-hex__txt' }, txt)));
    }
    return h('div', { class: 'ns-hex', tabindex: 0, onkeydown: onKey, 'data-i18n': 'off',
      ref: n => { if (n && scroller !== n) { scroller = n; n.scrollTop = st.scroll; sized?.observe(n); requestAnimationFrame(update); } },
      onscroll: e => { st.scroll = e.target.scrollTop; update(); } },
    h('div', { class: 'ns-hex__space', style: { height: `${total * ROW_H}px` } }, rows));
  }
  function click(e, i) {
    e.preventDefault();
    scroller?.focus({ preventScroll: true });
    moveTo(i, e.shiftKey);
  }

  // the bytes at the cursor as numbers, and as code
  function inspector() {
    const d = st.data, c = st.cursor;
    if (!d.length) return h('div', { class: 'section__hint' }, 'Choose a file in the bar, or make a new one.');
    const b = d[c] ?? 0, w = (d[c] ?? 0) | (d[c + 1] ?? 0) << 8, wb = (d[c] ?? 0) << 8 | (d[c + 1] ?? 0);
    const [a, z] = sel();
    const row = (k, v) => h('div', { class: 'ns-insp__row' }, h('span', { class: 'ns-insp__k' }, k), h('span', { class: 'ns-insp__v', 'data-i18n': 'off' }, v));
    const cpu = (() => {
      const s = readSettings(), m = machineOf(s.machine), own = m.cpus.includes(s.cpu) ? s.cpu : m.cpu;
      return prgFile(st.file ?? '') && machineOf(s.machine).family !== 'commodore' ? '6510' : own;    // a .prg: a Commodore's
    })();
    let code = [];
    try { code = disassemble(d.subarray(c, c + 24), addrOf(c) & 0xffff, cpu).slice(0, 6); } catch { /* no code */ }
    return [
      section('Cursor', h('div', { class: 'ns-insp' },
        row('Offset', `${c} · $${c.toString(16)}`),
        st.base != null && row('Address', `$${hex4(addrOf(c) & 0xffff)}`),
        st.base != null && (() => { const s = symbolsFor(readSettings().machine).at(addrOf(c) & 0xffff); return s && row('Name', s.offset ? `${s.name}+${s.offset}` : s.name); })(),
        st.anchor != null && row('Selection', `${z - a + 1} bytes · $${(st.base != null ? addrOf(a) : a).toString(16)}–$${(st.base != null ? addrOf(z) : z).toString(16)}`),
        row('Byte', `$${hex2(b)} · ${b} · ${b > 127 ? b - 256 : b}`),
        row('Bits', b.toString(2).padStart(8, '0')),
        row('Word LE', `$${hex4(w)} · ${w}`),
        row('Word BE', `$${hex4(wb)} · ${wb}`))),
      section(`Code (${cpu})`, h('div', { class: 'ns-insp ns-insp--code', 'data-i18n': 'off' },
        code.map(x => h('div', {}, h('span', { class: 'ns-insp__k' }, hex4(x.addr)), ' ', x.text)))),
      section('File', h('div', { class: 'ns-insp' },
        row('Size', `${d.length} bytes`),
        prgFile(st.file ?? '') && d.length >= 2 && row('Load address', `$${hex4(d[0] | d[1] << 8)}`),
        h('div', { class: 'ns-insp__base' },
          field({ label: 'Address of the first byte', dense: true, mono: true, value: st.base != null ? '$' + hex4(st.base) : '',
            placeholder: 'none: offsets', onchange: v => { const t = v.trim(); st.base = t ? parseInt(t.replace(/^\$|^0x/i, ''), 16) || 0 : null; update(); } })),
        editable(st.file ?? '') ? button('Save the file', { icon: 'save', variant: 'tonal', disabled: !dirty(), onclick: () => { saveChanges(); snackbar(`${st.file} saved`); } }) : '')),
      section('Keys', h('div', { class: 'section__hint', 'data-i18n': 'off' },
        'Hex digits or text type over · Tab: hex / text · Shift+arrows select · Ins inserts, Del deletes · Ctrl+C copies hex, Ctrl+Shift+C ACME source · Ctrl+V pastes hex · Ctrl+G goes to')),
    ];
  }

  function bodyView() {
    version.value;    // eslint-disable-line no-unused-expressions
    if (!isOpen()) return null;
    return h('div', { class: 'screen-body' },
      h('div', { class: 'screen-main ns-hex-main' },
        st.file ? [h('div', { class: 'ns-hex__find' },
          field({ label: 'Find hex bytes (a9 00) or "text"', dense: true, mono: true, value: st.find, onenter: v => { st.find = v; find(v); }, oninput: v => { st.find = v; } }),
          iconButton('chevron_left', 'Previous', () => find(st.find, -1)), iconButton('chevron_right', 'Next', () => find(st.find, 1))), gridView()]
          : h('div', { class: 'empty-state' }, icon('hashtag'), h('div', { class: 'md-title-medium' }, 'No file open'),
            h('div', { class: 'md-body-medium' }, 'Any file of the project and of the last build: charsets, screens, sprites, programs, data. Or drop a file from outside here.'),
            h('div', { class: 'start-screen__actions' }, button('New binary file', { icon: 'add', variant: 'filled', onclick: newFile }),
              button('Open a file from the disk', { icon: 'upload_file', variant: 'outlined', onclick: openDisk })))),
      sidePanel('Hex', inspector()));
  }

  async function openDisk() { const p = await pickFile(); if (p) open(p); }
  async function addExternalFile() { const p = await addToProject(st.file); if (p) open(p); }

  function render() {
    if (!views) dropTarget(el, paths => open(paths[0]));
    views ??= [mount(bar, barView), mount(el, bodyView)];
    update();
  }

  return {
    render, open, newFile, saveChanges,
    isDirty: dirty,
    current: () => st.file,
    select: path => open(path),
    refreshBuild: () => { if (st.file?.startsWith('build:')) open(st.file); else update(); },
    reset: () => { st.file = null; st.data = new Uint8Array(0); st.saved = null; update(); },
    exportFormats: () => (st.file ? [{ label: `${st.file.split('/').pop()} (as shown)`, icon: 'download', name: st.file.replace(/^build:/, '').split('/').pop(), description: 'File', bytes: () => st.data }] : []),
    findNext: (text, dir) => { st.find = text; return find(text, dir); },
  };
}
