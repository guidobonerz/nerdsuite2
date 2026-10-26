// vice.js - the browser side of the debugger: the emulator behind the server - VICE (backend/vice, its
// binary remote monitor) or mimic (backend/mimic, its own debug protocol), both under the same routes
// (api/vice/..., api/mimic/...) - the breakpoints of the sources and where the CPU stopped. Shared by
// the code view (breakpoints in the gutter, the line of the PC) and the debugger view. Which of the two
// debugs a machine: the Settings (Emulator per platform), else mimic when it is found, else VICE.
//
// The breakpoints are lines of the sources ({ file, line, enabled, condition }); while the emulator runs
// they are checkpoints at the addresses the last build put there (nsbuild.js: debugInfo). Other
// checkpoints - an address, a range read or written (a watchpoint) - are made in the debugger view.

import { signal } from '../vendor/signals.js';
import { toBase64, fromBase64 } from './project.js';
import { debugInfo } from './nsbuild.js';

export const status = signal({ available: false, running: false, connected: false, stopped: false, pc: null });
export const stopped = signal(null);          // { pc, registers } while the CPU is stopped, else null
export const here = signal(null);             // { file, line } of the PC while stopped
export const lastBuild = signal(null);        // the build loaded into VICE (or built last)
export const bpVersion = signal(0);           // read it to be drawn again when a breakpoint changes
export const log = signal([]);                // the last messages: [{ time, text, kind }]

let info = debugInfo(null);
export const debug = () => info;

const listeners = new Set();
export const onEvent = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const fire = (type, data) => listeners.forEach(fn => fn(type, data));

export function addLog(text, kind = 'info') {
  log.value = [...log.value.slice(-199), { time: new Date(), text, kind }];
}

// the debugger the calls go to: 'vice' or 'mimic'
const NAMES = { vice: 'VICE', mimic: 'mimic' };
let backend = 'vice';
export const debuggerName = () => NAMES[backend];

async function call(method, path, body) {
  const res = await fetch(`api/${backend}/${path}`, { method, body: body && JSON.stringify(body), headers: body ? { 'Content-Type': 'application/json' } : {} });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${res.status} ${res.statusText}`);
  return json;
}
export const vice = {
  get: path => call('GET', path),
  post: (path, body = {}) => call('POST', path, body),
  del: path => call('DELETE', path),
};

// --- the events of the server -----------------------------------------------------------------

let source = null;
export function connectEvents() {
  if (source || typeof EventSource === 'undefined') return;
  source = new EventSource(`api/${backend}/events`);
  source.addEventListener('status', e => { status.value = JSON.parse(e.data); if (!status.value.running) { stopped.value = null; here.value = null; } fire('status', status.value); });
  source.addEventListener('stopped', e => { const d = JSON.parse(e.data); onStopped(d); });
  source.addEventListener('resumed', e => { stopped.value = null; here.value = null; status.value = { ...status.value, stopped: false }; fire('resumed', JSON.parse(e.data)); });
  source.addEventListener('checkpoint', e => { const d = JSON.parse(e.data); fire('checkpoint', d); });
  source.addEventListener('jam', e => { const d = JSON.parse(e.data); addLog(`CPU JAM at $${(d.pc ?? 0).toString(16).padStart(4, '0')}`, 'error'); fire('jam', d); });
  source.addEventListener('exit', e => { stopped.value = null; here.value = null; status.value = { ...status.value, running: false, connected: false }; cpIds.clear(); addLog(`${debuggerName()} has ended`); fire('exit', JSON.parse(e.data)); });
  source.addEventListener('log', e => addLog(JSON.parse(e.data).text));
  source.onerror = () => { /* the browser reconnects by itself */ };
}

function onStopped(d) {
  stopped.value = d;
  status.value = { ...status.value, stopped: true, pc: d.pc };
  const at = d.pc != null ? info.lineOf(d.pc) : null;
  here.value = at ? { file: at.file, line: at.line } : null;
  fire('stopped', d);
}

export async function refreshStatus() {
  try { status.value = await vice.get('status'); } catch { status.value = { available: false, running: false }; }
  return status.value;
}

// the debugger of a platform: 'vice' or 'mimic' - the calls and the events go there from now on - or 'emu'
// (the launcher runs it, backend/emu; nothing changes here). A Commodore machine (emulator.kind 'vice'): the
// one chosen in the Settings, else mimic when it is found, else VICE. The Atari 8-bit, the 2600, the CPC, the ZX81 and the Amiga: mimic when it
// is chosen or none is - debug: when it is found at all -, else their emulator
export async function chooseDebugger(platform, { debug = false } = {}) {
  const commodore = platform.emulator.kind === 'vice';
  let id = commodore ? 'vice' : 'emu';
  try {
    const t = await (await fetch('api/settings/tools')).json();
    const mimic = !!platform.mimic && !!t.tools?.find(x => x.key === 'MIMIC')?.available;
    const pref = t.platforms?.find(x => x.id === (commodore ? platform.id : platform.emulator.platform))?.preferred;
    if (commodore) id = pref || (mimic ? 'mimic' : 'vice');
    else if (mimic && (!pref || pref === 'mimic' || debug)) id = 'mimic';
  } catch { /* the server does not answer: VICE, or the launcher */ }
  if (!NAMES[id]) return id;
  if (id === backend) return backend;
  backend = id;
  stopped.value = null; here.value = null;
  cpIds.clear();
  startedFor = null;
  if (source) { source.close(); source = null; connectEvents(); }
  await refreshStatus();
  return backend;
}

// --- breakpoints of the sources -----------------------------------------------------------------

const breakpoints = new Map();               // 'file:line' -> { file, line, enabled, condition }
const cpIds = new Map();                     // 'file:line' -> [checkpoint ids in VICE]
const KEY = 'nerdsuite.breakpoints';

export function loadBreakpoints(project) {
  breakpoints.clear();
  try {
    for (const b of JSON.parse(sessionStorage.getItem(`${KEY}:${project}`) ?? '[]')) breakpoints.set(`${b.file}:${b.line}`, b);
  } catch { /* none */ }
  bpVersion.value++;
}
let projectKey = '';
export const setBreakpointProject = p => { projectKey = p ?? ''; loadBreakpoints(projectKey); };
function saveBreakpoints() {
  try { sessionStorage.setItem(`${KEY}:${projectKey}`, JSON.stringify([...breakpoints.values()])); } catch { /* private mode */ }
  bpVersion.value++;
}

export const allBreakpoints = () => [...breakpoints.values()];
export function breakpointMarks(file) {
  const out = new Map();
  for (const b of breakpoints.values()) if (b.file === file) out.set(b.line, b.enabled ? 'bp' : 'bp-off');
  return out;
}

export async function toggleBreakpoint(file, line) {
  const key = `${file}:${line}`;
  if (breakpoints.has(key)) {
    breakpoints.delete(key);
    await removeCheckpoints(key);
  } else {
    breakpoints.set(key, { file, line, enabled: true, condition: '' });
    await placeCheckpoints(key);
  }
  saveBreakpoints();
}

export async function updateBreakpoint(file, line, change) {
  const key = `${file}:${line}`, b = breakpoints.get(key);
  if (!b) return;
  Object.assign(b, change);
  await removeCheckpoints(key);
  if (b.enabled) await placeCheckpoints(key);
  saveBreakpoints();
}

export async function removeBreakpoint(file, line) {
  const key = `${file}:${line}`;
  breakpoints.delete(key);
  await removeCheckpoints(key);
  saveBreakpoints();
}

async function removeCheckpoints(key) {
  const ids = cpIds.get(key) ?? [];
  cpIds.delete(key);
  if (!status.value.running) return;
  for (const id of ids) await vice.del(`checkpoints/${id}`).catch(() => {});
}

async function placeCheckpoints(key) {
  const b = breakpoints.get(key);
  if (!b?.enabled || !status.value.running) return;
  const addrs = info.addrsOf(b.file, b.line);
  if (!addrs.length) return;
  const ids = [];
  for (const addr of addrs.slice(0, 1)) {           // the first byte of the line: where it starts
    try {
      const cp = await vice.post('checkpoints', { start: addr, end: addr, stop: true, enabled: true, exec: true, load: false, store: false, ...(b.condition ? { condition: b.condition } : {}) });
      ids.push(cp.id);
    } catch (e) { addLog(`breakpoint ${b.file}:${b.line}: ${e.message}`, 'error'); }
  }
  cpIds.set(key, ids);
}

// a new build: the addresses of the lines anew, and the breakpoints placed there
export async function setBuild(build) {
  lastBuild.value = build;
  info = debugInfo(build);
  if (!status.value.running) return;
  for (const key of [...cpIds.keys()]) await removeCheckpoints(key);
  for (const key of breakpoints.keys()) await placeCheckpoints(key);
}

// whether a checkpoint id is one of the breakpoints of the sources
export const isSourceCheckpoint = id => [...cpIds.values()].some(ids => ids.includes(id));

// --- running ------------------------------------------------------------------------------------

// the emulator started (or running) for the machine of a platform (platforms.js: emulator { machine, args }
// for VICE; mimic has a machine of its own for each platform: its id)
let startedFor = null;
export async function ensureRunning(platform) {
  if (await chooseDebugger(platform, { debug: true }) === 'emu') throw new Error(`${platform.name}: the debugger needs mimic`);
  const { machine, model, args = [] } = backend === 'mimic' ? platform.mimic : platform.emulator;
  const s = await refreshStatus();
  if (s.running && s.machine === machine && startedFor === platform.id) return s;
  addLog(`starting ${debuggerName()} (${platform.name})…`);
  status.value = await vice.post('start', { machine, model, args });
  startedFor = platform.id;
  cpIds.clear();
  return status.value;
}

// load a build into the emulator and run it; debug: the breakpoints are placed first. format: the file of
// the build as mimic loads it (xex, atascii-lst, amsdos-bin, cpc-ascii, a26, adf, zx81-p - the names of the launcher), else the .prg
export async function runBuild(build, platform, { debug: withBreakpoints = true, format = null } = {}) {
  await ensureRunning(platform);
  await setBuild(build);
  if (!withBreakpoints) for (const key of [...cpIds.keys()]) await removeCheckpoints(key);
  if (format) {
    status.value = await vice.post('load', { name: build.file.name, data: toBase64(build.file.bytes), format, load: build.start, exec: build.exec });
    addLog(`${build.file.name} loaded and started`);
    return;
  }
  // a packed program (toolchain.js): the packed one runs, the debugger knows the unpacked one
  status.value = await vice.post('load', { name: build.name, prg: toBase64(build.runPrg ?? build.prg), run: true });
  addLog(`${build.name}.prg loaded and started`);
}

export async function readMemory(start, end, bank = 0) {
  const r = await vice.get(`memory?start=${start}&end=${end}&bank=${bank}`);
  return fromBase64(r.data);
}
export async function writeMemory(start, bytes, bank = 0) {
  return vice.post('memory', { start, data: toBase64(bytes), bank });
}
