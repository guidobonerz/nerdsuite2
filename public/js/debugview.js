// debugview.js - the Debugger view: the program in VICE through its binary remote monitor
// (vice.js, backend/vice). What the monitor of VICE offers, in panels:
//   - run, pause, step into, step over, step out (until RTS), reset, load and run the build
//   - the registers and the flags (editable), the stack
//   - the disassembly around the PC with the labels and the source lines of the build
//   - breakpoints (exec), watchpoints (load / store of an address or range), with a condition,
//     temporary, enabled or not, and the hits VICE counts
//   - the memory as hex and PETSCII, in every bank VICE has, editable
//   - watches: labels or addresses as bytes, words or text, read whenever the CPU stops
//   - the screen of the emulator, the log
// The breakpoints of the sources (the gutter of the code view) are checkpoints at the addresses
// of their lines; the ones made here are checkpoints of an address.

import { h, mount, signal, icon, iconButton, button, select, field, promptDialog, snackbar, sidePanel, section, checkbox } from './pui.js';
import * as vice from './vice.js';
import { hasFile, readText } from './project.js';
import { disassemble, parseAddress, hex2, hex4, MACHINES, machineOf, readSettings, writeSettings, isCodeLine } from './nsbuild.js';

const REGS = ['pc', 'a', 'x', 'y', 'sp'];
const FLAGS = [['N', 0x80], ['V', 0x40], ['-', 0x20], ['B', 0x10], ['D', 0x08], ['I', 0x04], ['Z', 0x02], ['C', 0x01]];
const KEY = 'nerdsuite.debug';
const MEM_ROWS = 16;
const DIS_LINES = 28;

// PETSCII bytes as the characters of the C64 font (C64 Pro Mono maps the screen codes to E0xx / EExx)
const petsciiChar = b => {
  if (b >= 0x20 && b < 0x7f) return String.fromCharCode(b >= 0x41 && b <= 0x5a ? b + 0x20 : b >= 0x61 && b <= 0x7a ? b - 0x20 : b);
  return '.';
};

export function createDebugView(el, bar, hooks = {}) {
  const st = {
    memStart: 0x0801, memBank: 0, mem: null, memText: '$0801',
    disStart: null, dis: [], follow: true, disText: '',
    checkpoints: [], banks: [],
    watches: [], watchValues: new Map(),
    screen: null, liveScreen: false,
    registers: null, stack: null, basicLine: null,
    busy: false,
  };
  try { Object.assign(st, JSON.parse(localStorage.getItem(KEY) ?? '{}')); } catch { /* none */ }
  st.mem = null; st.dis = []; st.checkpoints = []; st.registers = null; st.screen = null;
  const version = signal(0);
  const update = () => { version.value++; };
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify({ memStart: st.memStart, memBank: st.memBank, memText: st.memText, watches: st.watches, liveScreen: st.liveScreen, follow: st.follow })); } catch { /* none */ } };
  let views = null, shown = false, screenTimer = 0;
  const screenCanvas = document.createElement('canvas');
  screenCanvas.className = 'ns-screen';

  const machine = () => readSettings().machine;
  const cpu = () => readSettings().cpu || machineOf(machine()).cpu || '6502';
  const info = () => vice.debug();
  const running = () => vice.status.value.running;
  const isStopped = () => !!vice.stopped.value;

  // a call to VICE with its error as a message
  async function act(fn, what) {
    try { return await fn(); } catch (e) { snackbar(`${what}: ${e.message}`, { error: true }); vice.addLog(`${what}: ${e.message}`, 'error'); return null; }
  }

  // --- reading the state ---------------------------------------------------------------------

  async function refresh() {
    if (!running()) { update(); return; }
    await act(async () => {
      if (isStopped()) {
        st.registers = vice.stopped.value.registers ?? await vice.vice.get('registers');
        const sp = st.registers.sp ?? 0xff;
        const stack = await vice.readMemory(0x100 + ((sp + 1) & 0xff), 0x1ff);
        st.stack = { sp, bytes: stack.slice(0, 16) };
        await disassembly();
        await readWatches();
        // the BASIC line the interpreter is at (C64, C128, VIC-20: CURLIN $39/$3A)
        const curlin = await vice.readMemory(0x39, 0x3a);
        st.basicLine = curlin[1] !== 0xff && ['c64', 'vic20', 'c128'].includes(machine()) ? curlin[0] | curlin[1] << 8 : null;
      }
      await readMemoryView();
      await readCheckpoints();
      if (isStopped() || st.liveScreen) await readScreen();
    }, 'refresh');
    update();
  }

  async function readCheckpoints() {
    st.checkpoints = (await vice.vice.get('checkpoints').catch(() => [])) ?? [];
    if (!st.banks.length) st.banks = await vice.vice.get('banks').catch(() => []) ?? [];
  }

  async function readMemoryView() {
    const start = st.memStart & 0xfff0, end = Math.min(0xffff, start + MEM_ROWS * 16 - 1);
    st.mem = { start, bytes: await vice.readMemory(start, end, st.memBank) };
  }

  // the disassembly from a little before the PC: the start of a source line of the build, else the PC
  async function disassembly() {
    const pc = st.registers?.pc ?? 0;
    let start = pc;
    if (st.follow || st.disStart == null) {
      // the starts of the source lines that are instructions - not data (!byte, !text ...)
      const starts = [...new Set((vice.lastBuild.value?.lines ?? []).filter(l => !l.macro && isCode(l)).map(l => l.addr))].sort((a, b) => a - b);
      const before = starts.filter(a => a < pc && a >= pc - 24);
      start = before.length ? before[Math.max(0, before.length - 6)] : pc;
      st.disStart = start;
    } else start = st.disStart;
    const bytes = await vice.readMemory(start, Math.min(0xffff, start + DIS_LINES * 3 + 2));
    st.dis = disassemble(bytes, start, cpu()).slice(0, DIS_LINES);
  }

  // whether the source line of a build line holds an instruction (a pseudo op makes data)
  const sourceLines = new Map();
  function isCode(l) {
    if (!sourceLines.has(l.file)) sourceLines.set(l.file, hasFile(l.file) ? readText(l.file).split('\n') : []);
    return isCodeLine(sourceLines.get(l.file)[l.line - 1]);
  }
  vice.onEvent(type => { if (type === 'stopped') sourceLines.clear(); });

  async function readWatches() {
    st.watchValues = new Map();
    for (const w of st.watches) {
      const addr = parseAddress(w.expr, info());
      if (addr == null) { st.watchValues.set(w.expr, 'unknown'); continue; }
      const n = w.type === 'word' ? 2 : w.type === 'text' ? 16 : w.type === 'bytes' ? 8 : 1;
      const b = await vice.readMemory(addr, Math.min(0xffff, addr + n - 1));
      st.watchValues.set(w.expr, w.type === 'word' ? `$${hex4(b[0] | b[1] << 8)}  ${b[0] | b[1] << 8}`
        : w.type === 'text' ? `"${[...b].map(petsciiChar).join('')}"`
          : w.type === 'bytes' ? [...b].map(hex2).join(' ')
            : `$${hex2(b[0])}  ${b[0]}  %${b[0].toString(2).padStart(8, '0')}`);
    }
  }

  async function readScreen() {
    const d = await vice.vice.get('display').catch(() => null);
    if (!d?.rgba) return;
    const bytes = Uint8ClampedArray.from(atob(d.rgba), c => c.charCodeAt(0));
    if (bytes.length !== d.width * d.height * 4) return;
    screenCanvas.width = d.width; screenCanvas.height = d.height;
    screenCanvas.getContext('2d').putImageData(new ImageData(bytes, d.width, d.height), 0, 0);
    st.screen = d;
  }

  function liveScreen(on) {
    st.liveScreen = on;
    persist();
    clearInterval(screenTimer);
    if (on) screenTimer = setInterval(() => { if (shown && running() && !isStopped()) readScreen().then(update); }, 1000);
    update();
  }

  // --- control ----------------------------------------------------------------------------------

  async function start() {
    const p = machineOf(machine());
    if (p.emulator.kind !== 'vice') return snackbar(`${p.name} programs run in their emulator (Run, F5): the debugger works with VICE and the Commodore machines`, { error: true, timeout: 8000 });
    await act(() => vice.ensureRunning(p), 'start VICE');
    await refresh();
  }
  const stop = () => act(() => vice.vice.post('stop'), 'stop VICE').then(refresh);
  const cont = () => act(() => vice.vice.post('continue'), 'continue');
  const pause = () => act(async () => { const r = await vice.vice.post('pause'); vice.stopped.value = r; await refresh(); }, 'pause');
  const stepped = r => { if (r) { vice.stopped.value = r; vice.here.value = (() => { const at = info().lineOf(r.pc); return at ? { file: at.file, line: at.line } : null; })(); } return refresh(); };
  const stepInto = () => act(() => vice.vice.post('step', { count: 1, over: false }), 'step').then(stepped);
  const stepOver = () => act(() => vice.vice.post('step', { count: 1, over: true }), 'step over').then(stepped);
  const stepOut = () => act(() => vice.vice.post('return'), 'step out').then(stepped);
  const reset = () => act(() => vice.vice.post('reset', { hard: false }), 'reset').then(refresh);

  async function setRegister(name, text) {
    const v = parseAddress(text, info());
    if (v == null) return snackbar(`'${text}' is no value`, { error: true });
    await act(async () => { st.registers = await vice.vice.post('registers', { [name]: v }); }, 'registers');
    if (name === 'pc') await disassembly();
    update();
  }
  const toggleFlag = bit => setRegister('fl', String((st.registers?.fl ?? 0) ^ bit));

  // --- checkpoints ------------------------------------------------------------------------------

  async function addCheckpoint(preset = {}) {
    const v = await promptDialog({
      title: 'New breakpoint or watchpoint', ok: 'Add',
      fields: [
        { name: 'kind', label: 'Stop when', value: preset.kind ?? 'exec', radios: [
          { value: 'exec', label: 'the CPU executes it (breakpoint)' }, { value: 'store', label: 'it is written (watchpoint)' },
          { value: 'load', label: 'it is read (watchpoint)' }, { value: 'access', label: 'it is read or written' }] },
        { name: 'start', label: 'Address or label', value: preset.start ?? '', mono: true, row: 'a', validate: t => (parseAddress(t, info()) == null ? 'an address ($c000) or a label of the build' : null) },
        { name: 'end', label: 'To (optional)', value: '', mono: true, row: 'a', validate: t => (t && parseAddress(t, info()) == null ? 'an address or a label' : null) },
        { name: 'condition', label: 'Condition (optional)', value: '', mono: true, placeholder: 'A == $10 && X > 3' },
        { name: 'temporary', label: 'Once', value: 'no', radios: [{ value: 'no', label: 'every time' }, { value: 'yes', label: 'once (temporary)' }] },
      ],
    });
    if (!v) return;
    const s = parseAddress(v.start, info()), e = v.end ? parseAddress(v.end, info()) : s;
    await act(() => vice.vice.post('checkpoints', {
      start: s, end: Math.max(s, e), stop: true, enabled: true,
      exec: v.kind === 'exec', load: v.kind === 'load' || v.kind === 'access', store: v.kind === 'store' || v.kind === 'access',
      temporary: v.temporary === 'yes', ...(v.condition ? { condition: v.condition } : {}),
    }), 'checkpoint');
    await readCheckpoints();
    update();
  }
  async function toggleAddressBreakpoint(addr) {
    const cp = st.checkpoints.find(c => c.exec && c.start === addr && c.end === addr);
    if (cp) await act(() => vice.vice.del(`checkpoints/${cp.id}`), 'checkpoint');
    else await act(() => vice.vice.post('checkpoints', { start: addr, end: addr, stop: true, enabled: true, exec: true }), 'checkpoint');
    await readCheckpoints();
    update();
  }

  // --- memory -----------------------------------------------------------------------------------

  async function gotoMemory(text) {
    const a = parseAddress(text, info());
    if (a == null) return snackbar(`'${text}' is no address or label`, { error: true });
    st.memStart = a; st.memText = text; persist();
    if (running()) await act(readMemoryView, 'memory');
    update();
  }
  async function editByte(addr, old) {
    const v = await promptDialog({ title: `$${hex4(addr)}`, ok: 'Write',
      fields: [{ name: 'value', label: 'Bytes (hex, separated by spaces) or "text"', value: hex2(old), mono: true,
        validate: t => (/^"[^"]*"?$/.test(t) || /^([0-9a-f]{1,2}\s*)+$/i.test(t) ? null : 'hex bytes like a9 01, or "text"') }] });
    if (!v) return;
    const bytes = v.value.startsWith('"') ? new TextEncoder().encode(v.value.replace(/^"|"$/g, '').toUpperCase())
      : Uint8Array.from(v.value.trim().split(/\s+/).map(x => parseInt(x, 16)));
    await act(() => vice.writeMemory(addr, bytes, st.memBank), 'memory');
    await refresh();
  }

  // --- the views -----------------------------------------------------------------------------------

  function barView() {
    version.value; vice.status.value; vice.stopped.value;    // eslint-disable-line no-unused-expressions
    const s = vice.status.value, stoppedAt = vice.stopped.value;
    const label = stoppedAt?.pc != null ? info().label(stoppedAt.pc) : null;
    return h('div', { class: 'screen-bar' },
      h('span', { class: 'md-title-medium' }, 'Debugger'),
      h('span', { class: 'screen-bar__sep' }),
      select({ label: 'Machine', hideLabel: true, dense: true, value: machine(), cls: 'ns-bar__select',
        options: MACHINES.filter(m => m.emulator.kind === 'vice' || m.id === machine()).map(m => ({ value: m.id, label: m.name })), onchange: v => { writeSettings({ machine: v }); update(); } }),
      s.running ? iconButton('power', 'Stop VICE', stop, 'md-icon-button--selected') : iconButton('power', 'Start VICE', start, '', { disabled: !s.available }),
      h('span', { class: 'screen-bar__sep' }),
      iconButton('hammer', 'Build, load and run the main program with its breakpoints (F6)', () => hooks.debug?.()),
      stoppedAt ? iconButton('play', 'Continue (F5 / F8)', cont, '', { disabled: !s.running }) : iconButton('pause', 'Pause (F8)', pause, '', { disabled: !s.running }),
      iconButton('step_into', 'Step into (F11)', stepInto, '', { disabled: !stoppedAt }),
      iconButton('step_over', 'Step over (F10)', stepOver, '', { disabled: !stoppedAt }),
      iconButton('step_out', 'Step out: run until RTS (Shift+F11)', stepOut, '', { disabled: !stoppedAt }),
      iconButton('restart_alt', 'Reset the machine', reset, '', { disabled: !s.running }),
      iconButton('refresh', 'Read the state again', refresh, '', { disabled: !s.running }),
      h('span', { class: 'screen-bar__sep' }),
      h('span', { class: `md-body-medium ns-state ${stoppedAt ? 'ns-state--stopped' : s.running ? 'ns-state--running' : ''}`, 'data-i18n': 'off' },
        !s.available ? 'VICE not found - set VICE to its folder and restart the server'
          : !s.running ? 'VICE is not running'
            : stoppedAt ? `Stopped at $${hex4(stoppedAt.pc ?? 0)}${label ? ` (${label})` : ''}${vice.here.value ? ` · ${vice.here.value.file}:${vice.here.value.line}` : ''}${st.basicLine != null ? ` · BASIC line ${st.basicLine}` : ''}`
              : `Running · ${machineOf(s.machine ?? machine()).name}`),
      h('div', { class: 'app-bar__spacer' }));
  }

  function registersView() {
    const r = st.registers;
    if (!r) return h('div', { class: 'section__hint' }, running() ? 'Pause the CPU to see its registers.' : 'Start VICE first.');
    const fl = r.fl ?? 0;
    return h('div', { class: 'ns-regs' },
      h('div', { class: 'ns-regs__row' }, REGS.map(n => h('label', { class: 'ns-reg' }, h('span', { class: 'ns-reg__name' }, n.toUpperCase()),
        h('input', { class: 'ns-reg__value', value: n === 'pc' ? hex4(r[n] ?? 0) : hex2(r[n] ?? 0), spellcheck: false, 'data-i18n': 'off',
          onchange: e => setRegister(n, '$' + e.target.value) })))),
      h('div', { class: 'ns-flags' }, FLAGS.map(([f, bit]) => h('button', { type: 'button', class: `ns-flag ${fl & bit ? 'ns-flag--on' : ''}`, title: `${f}: click to toggle`, onclick: () => toggleFlag(bit) }, f))),
      // other registers VICE reports (the 6510 port, raster line, cycles ...)
      h('div', { class: 'ns-regs__more', 'data-i18n': 'off' }, Object.entries(r).filter(([k]) => !REGS.includes(k) && k !== 'fl').map(([k, v]) => h('span', {}, `${k} ${typeof v === 'number' ? (v > 0xff ? hex4(v) : hex2(v)) : v}`))),
      st.stack && h('div', { class: 'ns-stack', 'data-i18n': 'off' }, h('span', { class: 'ns-reg__name' }, 'Stack'),
        [...st.stack.bytes].map((b, k) => h('span', { title: `$01${hex2((st.stack.sp + 1 + k) & 0xff)}` }, hex2(b)))));
  }

  function disView() {
    if (!st.dis.length) return h('div', { class: 'section__hint' }, 'The disassembly shows while the CPU is stopped.');
    const pc = st.registers?.pc;
    const cps = new Set(st.checkpoints.filter(c => c.exec).map(c => c.start));
    let lastFile = null;
    return h('div', { class: 'ns-dis', 'data-i18n': 'off' }, st.dis.map(d => {
      const label = info().label(d.addr);
      const src = info().lineOf(d.addr);
      const srcText = src && (src.file !== lastFile ? `${src.file}:${src.line}` : `:${src.line}`);
      if (src) lastFile = src.file;
      return h('div', { class: `ns-dis__row ${d.addr === pc ? 'ns-dis__row--pc' : ''}` },
        h('button', { type: 'button', class: `ns-dis__bp ${cps.has(d.addr) ? 'ns-dis__bp--on' : ''}`, title: 'Breakpoint on or off', onclick: () => toggleAddressBreakpoint(d.addr) }),
        h('span', { class: 'ns-dis__addr' }, hex4(d.addr)),
        h('span', { class: 'ns-dis__bytes' }, d.bytes.map(hex2).join(' ')),
        h('span', { class: 'ns-dis__label' }, label ? `${label}:` : ''),
        h('span', { class: 'ns-dis__text' }, labelled(d.text)),
        srcText ? h('button', { type: 'button', class: 'ns-dis__src', onclick: () => hooks.showSource?.(src.file, src.line) }, srcText) : h('span'));
    }));
  }
  // an operand address with its label: lda $d020 -> lda $d020 (border)
  const labelled = text => text.replace(/\$([0-9a-f]{4})\b/i, (m, a) => { const l = info().label(parseInt(a, 16)); return l ? `${m} ‹${l}›` : m; });

  function memView() {
    const m = st.mem;
    return h('div', { class: 'ns-mem-wrap' },
      h('div', { class: 'ns-mem__bar' },
        field({ label: 'Address', hideLabel: true, dense: true, mono: true, value: st.memText, placeholder: '$0801 or a label',
          onchange: v => gotoMemory(v) }),
        iconButton('chevron_left', 'Back a page', () => gotoMemory('$' + hex4((st.memStart - MEM_ROWS * 16) & 0xffff))),
        iconButton('chevron_right', 'On a page', () => gotoMemory('$' + hex4((st.memStart + MEM_ROWS * 16) & 0xffff))),
        st.banks.length ? select({ label: 'Bank', hideLabel: true, dense: true, value: String(st.memBank), cls: 'ns-bar__select',
          options: st.banks.map(b => ({ value: String(b.id), label: b.name })), onchange: v => { st.memBank = Number(v); persist(); refresh(); } }) : ''),
      !m ? h('div', { class: 'section__hint' }, running() ? 'Reading…' : 'The memory shows while VICE runs.')
        : h('div', { class: 'ns-mem', 'data-i18n': 'off' }, Array.from({ length: Math.ceil(m.bytes.length / 16) }, (_, row) => {
          const base = m.start + row * 16, line = m.bytes.slice(row * 16, row * 16 + 16);
          return h('div', { class: 'ns-mem__row' },
            h('span', { class: 'ns-mem__addr' }, hex4(base)),
            h('span', { class: 'ns-mem__hex' }, [...line].map((b, k) => h('span', { class: `ns-mem__byte ${info().label(base + k) ? 'ns-mem__byte--label' : ''}`,
              title: `$${hex4(base + k)}${info().label(base + k) ? ' ' + info().label(base + k) : ''}: ${b}`, ondblclick: () => editByte(base + k, b) }, hex2(b)))),
            h('span', { class: 'ns-mem__chars' }, [...line].map(petsciiChar).join('')));
        })));
  }

  function checkpointsView() {
    const own = st.checkpoints.filter(c => !vice.isSourceCheckpoint(c.id));
    const src = vice.allBreakpoints();
    const kind = c => (c.exec ? 'exec' : c.load && c.store ? 'r/w' : c.store ? 'write' : 'read');
    return h('div', { class: 'ns-cps' },
      src.map(b => h('div', { class: 'ns-cp' },
        h('input', { type: 'checkbox', checked: b.enabled, title: 'enabled', onchange: e => vice.updateBreakpoint(b.file, b.line, { enabled: e.target.checked }).then(refresh) }),
        h('button', { type: 'button', class: 'ns-cp__what', onclick: () => hooks.showSource?.(b.file, b.line) }, `${b.file}:${b.line}`),
        h('input', { class: 'ns-cp__cond', value: b.condition ?? '', placeholder: 'condition', spellcheck: false, 'data-i18n': 'off',
          onchange: e => vice.updateBreakpoint(b.file, b.line, { condition: e.target.value.trim() }) }),
        iconButton('delete', 'Remove', () => vice.removeBreakpoint(b.file, b.line).then(refresh)))),
      own.map(c => h('div', { class: 'ns-cp' },
        h('input', { type: 'checkbox', checked: c.enabled, title: 'enabled', onchange: e => act(() => vice.vice.post(`checkpoints/${c.id}`, { enabled: e.target.checked }), 'checkpoint').then(refresh) }),
        h('span', { class: 'ns-cp__what', 'data-i18n': 'off' }, `${kind(c)} $${hex4(c.start)}${c.end !== c.start ? '-$' + hex4(c.end) : ''}${info().label(c.start) ? ' ' + info().label(c.start) : ''}`),
        h('span', { class: 'ns-cp__hits', title: 'hits' }, `${c.hits ?? 0}×${c.temporary ? ' once' : ''}${c.condition ? ' if ' + c.condition : ''}`),
        iconButton('delete', 'Remove', () => act(() => vice.vice.del(`checkpoints/${c.id}`), 'checkpoint').then(refresh)))),
      !src.length && !own.length ? h('div', { class: 'section__hint' }, 'Click a line number of an assembler source, or add a breakpoint or watchpoint here.') : '');
  }

  function watchesView() {
    return h('div', { class: 'ns-watches' },
      st.watches.map((w, k) => h('div', { class: 'ns-watch', 'data-i18n': 'off' },
        h('span', { class: 'ns-watch__expr' }, w.expr),
        h('span', { class: 'ns-watch__type' }, w.type),
        h('span', { class: 'ns-watch__value' }, st.watchValues.get(w.expr) ?? '–'),
        iconButton('delete', 'Remove', () => { st.watches.splice(k, 1); persist(); update(); }))),
      !st.watches.length ? h('div', { class: 'section__hint' }, 'Labels or addresses, read whenever the CPU stops.') : '');
  }
  async function addWatch() {
    const v = await promptDialog({ title: 'New watch', ok: 'Add', fields: [
      { name: 'expr', label: 'Address or label', value: '', mono: true, validate: t => (!t ? 'required' : null) },
      { name: 'type', label: 'Show as', value: 'byte', options: [{ value: 'byte', label: 'byte' }, { value: 'word', label: 'word (little endian)' }, { value: 'bytes', label: '8 bytes' }, { value: 'text', label: 'text (16 chars)' }] }] });
    if (!v) return;
    st.watches.push(v); persist();
    if (isStopped()) await readWatches();
    update();
  }

  function logView() {
    const list = vice.log.value.slice(-60);
    return h('div', { class: 'ns-log', 'data-i18n': 'off' }, list.map(l => h('div', { class: `ns-log__line ns-log__line--${l.kind}` },
      h('span', { class: 'ns-log__time' }, l.time.toLocaleTimeString()), l.text)));
  }

  function bodyView() {
    version.value; vice.status.value; vice.stopped.value; vice.log.value; vice.bpVersion.value;    // eslint-disable-line no-unused-expressions
    return h('div', { class: 'screen-body' },
      h('div', { class: 'screen-main ns-debug-main' },
        h('div', { class: 'ns-panel ns-panel--dis' }, h('div', { class: 'ns-panel__head' }, icon('cpu'), 'Disassembly',
          h('div', { class: 'app-bar__spacer' }),
          checkbox('Follow the PC', st.follow, v => { st.follow = v; persist(); if (v && isStopped()) refresh(); })), disView()),
        h('div', { class: 'ns-panel ns-panel--mem' }, h('div', { class: 'ns-panel__head' }, icon('memory'), 'Memory', h('div', { class: 'app-bar__spacer' }),
          h('span', { class: 'md-body-small' }, 'Double click a byte to change it')), memView())),
      sidePanel('Debugger', [
        section('Registers', registersView()),
        section('Breakpoints and watchpoints', checkpointsView(), iconButton('add', 'New breakpoint or watchpoint', () => addCheckpoint()), 'debug'),
        section('Watches', watchesView(), iconButton('add', 'New watch', addWatch), 'debug'),
        section('Screen', h('div', { class: 'ns-screen-wrap' }, st.screen ? h('div', { ref: n => { if (n && screenCanvas.parentNode !== n) n.replaceChildren(screenCanvas); } }) : h('div', { class: 'section__hint' }, 'The screen of the emulator shows when the CPU stops.'),
          checkbox('Live while running (every second)', st.liveScreen, liveScreen)), null, 'debug'),
        section('Log', logView(), iconButton('delete_sweep', 'Clear the log', () => { vice.log.value = []; }), 'debug'),
      ]));
  }

  function render() {
    views ??= [mount(bar, barView), mount(el, bodyView)];
    update();
  }

  vice.onEvent(type => {
    if (type === 'stopped') { st.disStart = null; refresh(); }
    if (type === 'resumed' || type === 'exit' || type === 'status') update();
    if (type === 'exit') { st.registers = null; st.dis = []; st.mem = null; }
  });

  function keys(e) {
    if (!running()) return false;
    const stoppedNow = isStopped();
    if (e.key === 'F8' || (e.key === 'F5' && stoppedNow && !e.ctrlKey)) { e.preventDefault(); stoppedNow ? cont() : pause(); return true; }
    if (e.key === 'F10' && stoppedNow) { e.preventDefault(); stepOver(); return true; }
    if (e.key === 'F11' && stoppedNow) { e.preventDefault(); if (e.shiftKey) stepOut(); else stepInto(); return true; }
    return false;
  }

  return {
    render, refresh, keys,
    open() { shown = true; render(); vice.refreshStatus().then(refresh); if (st.liveScreen) liveScreen(true); },
    close() { shown = false; clearInterval(screenTimer); },
  };
}

