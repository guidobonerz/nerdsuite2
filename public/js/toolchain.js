// toolchain.js - the toolchain of a project: what Build, Run and Debug do with the main program.
//   compiler   as the project sets it (ACME or KickAssembler, the tokenizer of a BASIC program), ACME,
//              KickAssembler, or a command of the server (64tass, cc65, oscar64 ...)
//   packer     none, Exomizer, pucrunch, Dali, or a command: the built program is packed
//   emulator   VICE or the emulator of the platform, one chosen, or a command
// The toolchains are set up in the Settings (settings.js) and kept on the server (backend/settings_api.go,
// backend/toolchain runs their commands); nerdsuite.json names the one of the project ("toolchain").
// Without one: the compiler of the project, no packer, the emulator of the platform.

import { signal } from './pui.js';
import { buildProgram, readSettings, isBasic, assemblerOf } from './nsbuild.js';
import { allFiles, readBinary, toBase64, fromBase64 } from './project.js';
import { platformOf } from './platforms.js';

export const COMPILERS = [
  { id: 'project', name: 'As the project sets it' },
  { id: 'acme', name: 'ACME' },
  { id: 'kickass', name: 'KickAssembler' },
  { id: 'command', name: 'A command…' },
];
export const PACKERS = [
  { id: 'none', name: 'None' },
  { id: 'exomizer', name: 'Exomizer', machines: ['c64', 'c128', 'vic20', 'plus4', 'c16', 'atari8'] },
  { id: 'pucrunch', name: 'pucrunch', machines: ['c64', 'c128', 'vic20', 'plus4', 'c16'] },
  { id: 'dali', name: 'Dali', machines: ['c64'] },
  { id: 'command', name: 'A command…' },
];
// the emulators of backend/emu and the platform they run (VICE: the Commodore machines)
export const EMULATORS = [
  { id: 'auto', name: 'The one of the machine' },
  { id: 'vice', name: 'VICE', platforms: ['vice'] },
  { id: 'altirra', name: 'Altirra', platforms: ['atari'] }, { id: 'atari800', name: 'Atari800', platforms: ['atari'] },
  { id: 'stella', name: 'Stella', platforms: ['vcs'] },
  { id: 'winape', name: 'WinAPE', platforms: ['cpc'] }, { id: 'caprice', name: 'Caprice', platforms: ['cpc'] },
  { id: 'mesen', name: 'Mesen', platforms: ['nes', 'snes'] }, { id: 'fceux', name: 'FCEUX', platforms: ['nes'] },
  { id: 'nestopia', name: 'Nestopia', platforms: ['nes'] }, { id: 'bsnes', name: 'bsnes', platforms: ['snes'] },
  { id: 'snes9x', name: 'Snes9x', platforms: ['snes'] },
  { id: 'eightyone', name: 'EightyOne', platforms: ['zx81'] }, { id: 'zesarux', name: 'ZEsarUX', platforms: ['zx81'] },
  { id: 'trs80gp', name: 'trs80gp', platforms: ['trs80'] },
  { id: 'beebem', name: 'BeebEm', platforms: ['bbc'] }, { id: 'b2', name: 'b2', platforms: ['bbc'] },
  { id: 'xemu', name: 'Xemu', platforms: ['mega65'] },
  { id: 'winuae', name: 'WinUAE', platforms: ['amiga'] }, { id: 'fsuae', name: 'FS-UAE', platforms: ['amiga'] },
  { id: 'mame', name: 'MAME', platforms: ['cpc', 'vcs', 'nes', 'snes', 'trs80', 'bbc'] },
  { id: 'ultimate', name: 'Ultimate 64 (a real C64)', platforms: ['vice'] },
  { id: 'command', name: 'A command…' },
];
// the platform of the launcher a machine runs on ('vice' for the Commodore machines)
const launcherOf = p => (p.emulator.kind === 'vice' ? 'vice' : p.emulator.platform);
export const emulatorRuns = (id, p) => ['auto', 'command'].includes(id) || !!EMULATORS.find(e => e.id === id)?.platforms?.includes(launcherOf(p));

export const toolchains = signal(null);       // the list of the server, null: not asked yet
// the Ultimate 64 of the settings: { host } ('' none) - Run on the Ultimate (backend/ultimate)
export const ultimate = signal({ host: '' });
let asking = null;
export function loadToolchains({ again = false } = {}) {
  if (again || !asking) {
    asking = fetch('api/settings/tools').then(r => r.json()).then(j => { ultimate.value = { host: j.ultimate?.host || j.ultimate?.env || '' }; return (toolchains.value = j.toolchains ?? []); })
      .catch(() => (toolchains.value = []));
  }
  return asking;
}
// the answer of the server after the Settings saved: the toolchains and the Ultimate
export const setServerSettings = j => {
  toolchains.value = j.toolchains ?? [];
  ultimate.value = { host: j.ultimate?.host || j.ultimate?.env || '' };
  asking = Promise.resolve(toolchains.value);
};
// the machines the Ultimate 64 runs programs of
export const ultimateRuns = p => p.id === 'c64';
export const runOnUltimate = r => post('api/ultimate/run', { name: r.name, data: toBase64(r.runPrg ?? r.prg) });

// the toolchain of the project, or null (also while the list is not known yet: sync)
export const projectToolchain = (settings = readSettings()) => (settings.toolchain && toolchains.value?.find(t => t.id === settings.toolchain)) || null;
export async function currentToolchain(settings = readSettings()) {
  if (!settings.toolchain) return null;
  await loadToolchains();
  return projectToolchain(settings);
}

const nameOf = (list, id) => list.find(x => x.id === id)?.name ?? id;
const commandName = c => String(c ?? '').trim().split(/\s+/)[0]?.split(/[\\/]/).pop().replace(/\.exe$/i, '') || 'a command';
// the steps of a toolchain for a machine as names: ['ACME', 'Exomizer', 'VICE']
export function chainSteps(tc, p, main) {
  const compiler = !tc || tc.compiler.kind === 'project'
    ? (main && isBasic(main) ? 'BASIC' : main && assemblerOf(main) === 'kickass' ? 'KickAssembler' : 'ACME')
    : tc.compiler.kind === 'command' ? commandName(tc.compiler.command) : nameOf(COMPILERS, tc.compiler.kind);
  const packer = !tc || tc.packer.kind === 'none' ? null : tc.packer.kind === 'command' ? commandName(tc.packer.command) : nameOf(PACKERS, tc.packer.kind);
  const kind = tc?.emulator.kind ?? 'auto';
  const emulator = kind === 'command' ? commandName(tc.emulator.command)
    : kind !== 'auto' && emulatorRuns(kind, p) ? nameOf(EMULATORS, kind) : p.emulator.kind === 'vice' ? 'VICE' : `${p.short} emulator`;
  return [compiler, packer, emulator].filter(Boolean);
}
export const chainLabel = (tc, p, main) => chainSteps(tc, p, main).join(' › ');

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${res.status} ${res.statusText}`);
  return json;
}

const baseName = p => p.split('/').pop().replace(/\.[^.]*$/, '');
const fail = (main, msg, extra = {}) => ({ ok: false, main, errors: [{ file: main, line: null, msg, severity: 'error' }], symbols: [], lines: [], ...extra });

// the compiler command of the server: the files of the project go there, the program comes back
async function compileCommand(tc, main, platform, over) {
  const enc = new TextEncoder();
  const files = {};
  for (const p of allFiles()) if (!p.startsWith('reference/')) files[p] = toBase64(over.has(p) ? enc.encode(over.get(p)) : readBinary(p));
  for (const [p, t] of over) files[p] ??= toBase64(enc.encode(t));
  let r;
  try {
    r = await post('api/toolchain/compile', { toolchain: tc.id, main, files, platform: platform.id, ext: platform.ext });
  } catch (e) {
    return fail(main, `${commandName(tc.compiler.command)}: ${e.message}`);
  }
  const out = r.output ? fromBase64(r.output) : null;
  const cbm = platform.format === 'cbm';
  const start = out && cbm && out.length > 2 ? out[0] | out[1] << 8 : platform.start;
  return {
    ok: !!r.ok && !!out, kind: 'asm', compiler: 'command', main, name: baseName(r.outputName ?? main), platform: platform.id,
    file: out && { name: r.outputName, bytes: out, format: platform.format }, prg: cbm ? out : null,
    start, end: out ? start + out.length - (cbm ? 3 : 1) : null, exec: start, errors: r.errors ?? [], symbols: [], lines: [], log: r.log, command: r.command,
  };
}

// where the packed program starts: a BASIC program as one, a SYS line as its address, else the start
function entryOf(r, platform) {
  if (r.kind === 'basic') return 'basic';
  if (platform.basicStart != null && r.start === platform.basicStart) return 'sys';
  return r.exec ?? r.start;
}

// build the main program with a toolchain (null: the one of the project's settings): compile, then pack.
// The build keeps the unpacked program for the debugger and the views (prg, start, lines), the packed
// one is its file (download, the emulators) and runPrg (VICE)
export async function buildWith(tc, main, { over = new Map(), settings = readSettings() } = {}) {
  const platform = platformOf(settings.machine);
  if (tc?.machine && tc.machine !== platform.id) {
    return fail(main, `the toolchain ${tc.name} is for the ${platformOf(tc.machine).name}, the project for the ${platform.name}: choose another one in the project settings`);
  }
  const kind = tc?.compiler.kind ?? 'project';
  let r;
  if (kind === 'command') {
    if (!main) return fail(main, 'no program to build: open a source or set the main program');
    r = await compileCommand(tc, main, platform, over);
  } else {
    // ACME or KickAssembler for every source, the tokenizer for BASIC
    r = await buildProgram(main, { over, settings: kind === 'project' ? settings : { ...settings, assembler: kind, assemblers: {} } });
  }
  r.toolchain = tc;
  r.steps = chainSteps(tc, platform, main);
  if (!r.ok || !r.file || !tc || tc.packer.kind === 'none') return r;

  const packer = tc.packer.kind === 'command' ? commandName(tc.packer.command) : nameOf(PACKERS, tc.packer.kind);
  try {
    const p = await post('api/toolchain/pack', { toolchain: tc.id, platform: platform.id, name: r.name, data: toBase64(r.file.bytes), entry: entryOf(r, platform) });
    if (!p.ok) return { ...r, ok: false, errors: [...r.errors, { file: null, line: null, msg: `${packer}: ${p.error}`, severity: 'error' }], packLog: p.log };
    const bytes = fromBase64(p.output);
    return { ...r, unpacked: r.file, file: { ...r.file, bytes }, runPrg: r.file.format === 'cbm' ? bytes : null, packed: { packer, before: p.before, after: p.after, command: p.command } };
  } catch (e) {
    return { ...r, ok: false, errors: [...r.errors, { file: null, line: null, msg: `${packer}: ${e.message}`, severity: 'error' }] };
  }
}

// run a build with the emulator command of its toolchain -> { ok, command }
export const runCommand = (r, platform) => post('api/toolchain/run', { toolchain: r.toolchain.id, platform: platform.id, name: r.name, data: toBase64(r.file.bytes), ext: r.file.name.split('.').pop() });
