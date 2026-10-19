// app.js - the shell of nerdsuite, an IDE for programs of 8 bit machines: the project, the views
// (code, the graphics editors of yopaca, the composer, the debugger, the problems), Save, Build,
// Run and Debug, the routes and the keyboard.
//
// The graphics editors of yopaca work on a model of the adventure language: in nerdsuite that model
// is a file of the project only the IDE writes, assets.json - the screens with their charsets,
// colors and layers, the sprites with their frames and animations. The art itself is in the files
// of gfx/ (.scr, .spr, .chr, .til, .kla), which the sources include with !binary.

import { gfxDir, isScreenFile, isDirartFile } from './gfxfile.js';
import { assetRefs, NEW_ASSETS } from './assets.js';
import { setScriptPath, onCharsetChange, dirtyCharsets, saveCharset } from './chr.js';
import { onPictureChange } from './picture.js';
import { searchPanel } from './panelsearch.js';
import { openExportMenu, openImportMenu } from './export.js';
import { writeZip } from './zip.js';
import { createStore } from './store.js';
import { createActions } from './actions.js';
import { createScreenEditor } from './screen.js';
import { createSpriteEditor } from './sprites.js';
import { createCharEditor } from './chars.js';
import { createTileEditor } from './tiles.js';
import { createBitmapEditor } from './bitmap.js';
import { createSoundEditor } from './sound.js';
import { createCodeView } from './codeview.js';
import { createDebugView } from './debugview.js';
import { createHexView } from './hexview.js';
import { createDisasmView } from './disasmview.js';
import { createExplorer } from './explorer.js';
import { projectWizard } from './nswizard.js';
import { stopPreview } from './songpreview.js';
import { openSettings } from './settings.js';
import { t, tr, lang, setLang, translateDom, LANGUAGES } from './i18n.js';
import { h, mount, icon, button, openMenu, promptDialog, dialog, snackbar, initTooltips, select, signal } from './pui.js';
import { createRouter } from './router.js';
import {
  isOpen, projectName, isProjectDirty, onProjectChange, setProject, closeProject, openZip, zipBytes, zipName, markZipSaved,
  listSources, readText, writeText, readBinary, writeBinary, hasFile, removeFile, allFiles, projectPath, PROJECT_EXT,
  saveFileAs, closedProjects, recoverProject, discardProject, setBuild as setProjectBuild, hasBuild, buildName, buildFiles, downloadBuild,
  fromBase64, toBase64, restoreSession, flushSession, setEditorVersion, restoredNotes,
  projectFolder, openFolder, saveToFolder, flushFolder, folderProblem, listDirs, makeDir,
} from './project.js';
import { chooseFolder, forgetFolder } from './folderchooser.js';
import { setWriterTag } from './filetag.js';
import { keepUi, loadUi, watchUi } from './uistate.js';
import { readSettings, writeSettings, machineOf, MACHINES, SETTINGS } from './nsbuild.js';
import { hasEditor, setVideoMachine, GFX_VIEWS } from './video.js';
import { loadMachineFont, onFontChange } from './romfonts.js';
import { buildWith, currentToolchain, loadToolchains, projectToolchain, toolchains, chainLabel, emulatorRuns, runCommand, ultimate, ultimateRuns, runOnUltimate } from './toolchain.js';
import * as vice from './vice.js';

const $ = sel => document.querySelector(sel);

// the hidden model of the graphics
export const ASSETS = 'assets.json';

// --- theme ---------------------------------------------------------------------------------------

const picked = () => { try { return sessionStorage.getItem('adv-theme'); } catch { return null; } };
const systemTheme = () => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
const setTheme = theme => { document.documentElement.dataset.theme = theme; };
function toggleTheme() {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { sessionStorage.setItem('adv-theme', theme); } catch { /* ignore */ }
  setTheme(theme);
}
setTheme(picked() || systemTheme());
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!picked()) setTheme(systemTheme()); });

async function api(method, url, data) {
  const res = await fetch(url, { method, body: data && JSON.stringify(data), headers: data ? { 'Content-Type': 'application/json' } : {} });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${res.status} ${res.statusText}`);
  return json;
}

// --- the graphics model (assets.json, assets.js) ----------------------------------------------------------

// the graphics files the model names, and the canvases and the directory art of the screen folder
function loadGfx(text) {
  const files = new Map();
  for (const rel of assetRefs(text)) if (hasFile(projectPath(ASSETS, rel))) files.set(rel, readBinary(projectPath(ASSETS, rel)));
  const dir = gfxDir(ASSETS);
  for (const key of allFiles()) {
    if (key.startsWith(dir + '/') && (isScreenFile(key, dir) || isDirartFile(key, dir)) && !files.has(key)) files.set(key, readBinary(key));
  }
  return files;
}

function loadAssets() {
  const text = hasFile(ASSETS) ? readText(ASSETS) : NEW_ASSETS;
  setScriptPath(ASSETS);
  try {
    store.load(ASSETS, text, loadGfx(text));
  } catch (e) {
    // a model that does not read (written by hand): the screens of their files, no sprites - the file stays
    snackbar(`${ASSETS}: ${e.message} - the sprites start empty`, { error: true, timeout: 10000 });
    store.load(ASSETS, NEW_ASSETS, loadGfx(NEW_ASSETS));
  }
}

// the model into its files: true when written
function saveAssets() {
  if (!store.game || !store.dirty) return true;
  const { text, files } = store.serialize();
  try {
    for (const [rel, data] of store.changedGfx(files)) writeBinary(projectPath(ASSETS, rel), data);
    for (const rel of store.goneCanvases(files)) removeFile(projectPath(ASSETS, rel));
    writeText(ASSETS, text);
    store.markSaved(text, files);
    return true;
  } catch (e) {
    snackbar(`Saving the graphics failed: ${e.message}`, { error: true });
    return false;
  }
}

// --- setup -------------------------------------------------------------------------------------

initTooltips();
const store = createStore();
const actions = createActions(store);
const toolbarFor = name => document.querySelector(`.toolbar__view[data-for="${name}"]`);
const VIEWS = ['code', 'screen', 'sprites', 'chars', 'tiles', 'bitmap', 'sound', 'hex', 'disasm', 'debug'];
let view = 'code';
let booting = true;
let explorer = null;                  // the files of the project (explorer.js), made below

// Build, Run, Debug and the Ultimate: in the bar of the code editor (their state: runState, updateChrome), and the keys
const runState = signal({});
const codeView = createCodeView($('#view-code'), toolbarFor('code'), {
  onDirty: () => updateDots(), onRoute: () => { syncRoute(); updateChrome(); }, onMain: () => updateChrome(), isShown: () => view === 'code',
  runState, build: () => build(), run: () => runMain(), debug: () => runMain({ debug: true }), ultimate: () => runMain({ onUltimate: true }),
});
const screenEditor = createScreenEditor($('#view-screen'), store, actions, toolbarFor('screen'));
const spriteEditor = createSpriteEditor($('#view-sprites'), store, actions, toolbarFor('sprites'));
const charEditor = createCharEditor($('#view-chars'), store, actions, toolbarFor('chars'));
const tileEditor = createTileEditor($('#view-tiles'), store, actions, toolbarFor('tiles'));
const bitmapEditor = createBitmapEditor($('#view-bitmap'), store, actions, toolbarFor('bitmap'));
const soundEditor = createSoundEditor($('#view-sound'), toolbarFor('sound'), { onRoute: () => syncRoute(), onDirty: () => updateDots() });
const hexView = createHexView($('#view-hex'), toolbarFor('hex'), { onRoute: () => syncRoute(), onDirty: () => updateDots(),
  disassemble: file => { setView('disasm'); disasmView.open(file); } });
const disasmView = createDisasmView($('#view-disasm'), toolbarFor('disasm'), {
  onRoute: () => syncRoute(), openSource: file => { setView('code'); codeView.open(file); },
  // a label renamed in the disassembly: in the source saved from it as well (its buffer, unsaved)
  renameInSource: (file, old, next) => codeView.renameIn(file, old, next),
});
const debugView = createDebugView($('#view-debug'), toolbarFor('debug'), {
  debug: () => runMain({ debug: true }),
  showSource: (file, line) => { setView('code'); codeView.open(file, line); },
});

actions.openSprites = (target, frame) => { spriteEditor.select(target, frame); setView('sprites'); };
actions.openChars = (file, placeId) => { charEditor.select(file, placeId); setView('chars'); };
actions.openTiles = (file, placeId) => { tileEditor.select(file, placeId); setView('tiles'); };
actions.openBitmap = file => { bitmapEditor.select(file); setView('bitmap'); };
actions.openSound = file => { setView('sound'); if (file) soundEditor.select(file); };
actions.openScreen = placeId => {
  const canvas = placeId && store.node(placeId)?.canvas;
  setView('screen', { place: placeId });
  if (canvas) screenEditor.open(placeId);
};
actions.showInStory = () => setView('screen');

// --- explorer: the files of the project, a click opens one in the editor of its kind -------------

const FILE_VIEWS = [
  [/\.(asm|a|s|inc|bas|c|h|txt|cfg|adv|json)$/i, 'code'], [/\.sng$/i, 'sound'], [/\.(kla|koa|art)$/i, 'bitmap'],
  [/\.chr$/i, 'chars'], [/\.til$/i, 'tiles'], [/\.spr$/i, 'sprites'], [/\.scr$/i, 'screen'],
];
async function openFile(path, { hex = false } = {}) {
  let name = hex ? 'hex' : FILE_VIEWS.find(([re]) => re.test(path))?.[1] ?? 'hex';
  // an editor the machine has not (video.js), a reference image: its bytes
  if (name !== 'code' && name !== 'hex' && !hasEditor(readSettings().machine, name)) name = 'hex';
  if (path.startsWith('reference/') && name !== 'code') name = 'hex';
  switch (name) {
    case 'code': setView('code'); codeView.open(path); break;
    case 'sound': actions.openSound(path); break;
    case 'bitmap': setView('bitmap'); await bitmapEditor.select(path); break;
    case 'chars': charEditor.selectKey(path); setView('chars'); break;
    case 'tiles': tileEditor.selectKey(path); setView('tiles'); break;
    case 'sprites': {
      // the sprite named as its file
      const { symbols } = await import('./adv.js');
      const id = store.game && symbols(store.game).costumes.find(c => c.name === stemOf(path))?.id;
      if (id) actions.openSprites(id, 'stand'); else setView('sprites');
      break;
    }
    case 'screen': {
      // a screen of the screen folder: its canvas, named as its file
      const id = store.game?.canvases?.find(c => c.name === stemOf(path))?.id;
      if (id) actions.openScreen(id); else setView('screen');
      break;
    }
    default: setView('hex'); await hexView.open(path);
  }
  syncRoute();
}
const stemOf = path => path.split('/').at(-1).replace(/\.[^.]*$/, '');
// the file of the open view: screens and sprites are routed by their names, their files named as them
function currentFile() {
  const { name, params } = stateRoute();
  const named = { screen: [params.place, '.scr'], sprites: [params.sprite, '.spr'] }[name];
  if (!named) return params.file ?? null;
  return named[0] ? allFiles().find(f => f.endsWith(named[1]) && stemOf(f) === named[0]) ?? null : null;
}
explorer = createExplorer($('#explorer'), { open: openFile, current: currentFile });
actions.dirtyChanged = () => updateDots();

// --- routes ------------------------------------------------------------------------------------
//   code/src/main.asm   screen/title   sprites/hero/stand   chars/gfx/charset/x.chr   debug

const router = createRouter([
  { name: 'code', path: '/code/*file?' },
  { name: 'screen', path: '/screen/:place?' },
  { name: 'sprites', path: '/sprites/:sprite?/:frame?' },
  { name: 'chars', path: '/chars/*file?' },
  { name: 'tiles', path: '/tiles/*file?' },
  { name: 'bitmap', path: '/bitmap/*file?' },
  { name: 'sound', path: '/sound/*file?' },
  { name: 'hex', path: '/hex/*file?' },
  { name: 'disasm', path: '/disasm/*file?' },
  { name: 'debug', path: '/debug' },
  { path: '/', redirect: { name: 'code' } },
  { path: '**', redirect: { name: 'code' } },
], { keep: ['lang'] });

function stateRoute() {
  const S = store.game;
  switch (view) {
    case 'code': return { name: view, params: { file: codeView.current() }, query: {} };
    case 'screen': return { name: view, params: { place: S ? screenEditor.current() : null }, query: {} };
    case 'sprites': {
      const { sprite, frame } = S ? spriteEditor.current() : {};
      return { name: view, params: { sprite, frame: frame === 'stand' ? null : frame }, query: {} };
    }
    case 'chars': return { name: view, params: { file: charEditor.current() }, query: {} };
    case 'tiles': return { name: view, params: { file: tileEditor.current() }, query: {} };
    case 'bitmap': return { name: view, params: { file: bitmapEditor.current() }, query: {} };
    case 'sound': return { name: view, params: { file: soundEditor.current() }, query: {} };
    case 'hex': return { name: view, params: { file: hexView.current() }, query: {} };
    case 'disasm': return { name: view, params: { file: disasmView.current() }, query: {} };
    default: return { name: view, params: {}, query: {} };
  }
}

let applying = false;
function syncRoute() {
  explorer?.refresh();
  if (booting || applying) return;
  const to = stateRoute(), from = router.current;
  const filling = from && from.name === to.name && Object.entries(from.params).every(([k, v]) => k === 'frame' || v == null || v === to.params[k]);
  router.sync(to, { replace: !!filling });
}
actions.route = syncRoute;

async function applyRoute(to) {
  applying = true;
  try {
    const p = to.params;
    const S = store.game ? (await import('./adv.js')).symbols(store.game) : null;
    let place = null;
    switch (to.name) {
      case 'code': if (p.file && hasFile(p.file)) codeView.open(p.file, null, { focus: false }); break;
      case 'screen': place = (p.place && (S?.allPlaces.find(x => x.name === p.place)?.id ?? store.game?.canvases?.find(c => c.name === p.place)?.id)) || null; break;
      case 'sprites': {
        const target = S?.costumes.find(c => c.name === p.sprite)?.id;
        if (target) spriteEditor.select(target, p.frame ?? 'stand');
        break;
      }
      case 'chars': if (p.file) charEditor.selectKey(p.file); break;
      case 'tiles': if (p.file) tileEditor.selectKey(p.file); break;
      case 'bitmap': if (p.file && hasFile(p.file)) await bitmapEditor.select(p.file); break;
      case 'sound': if (p.file && hasFile(p.file)) await soundEditor.select(p.file); break;
      case 'hex': if (p.file && p.file !== hexView.current() && (hasFile(p.file) || p.file.startsWith('build:'))) await hexView.open(p.file); break;
      case 'disasm': if (p.file && p.file !== disasmView.current() && (hasFile(p.file) || p.file.startsWith('build:'))) disasmView.open(p.file); break;
    }
    setView(VIEWS.includes(to.name) ? to.name : 'code', { route: false, place });
  } finally {
    applying = false;
  }
  if (!booting) router.sync(stateRoute(), { replace: true });
}
router.onChange(to => applyRoute(to));

if (globalThis.locationbar?.visible === false || matchMedia('(display-mode: standalone)').matches) {
  const back = $('#btn-back'), fwd = $('#btn-forward');
  back.hidden = fwd.hidden = false;
  back.addEventListener('click', () => history.back());
  fwd.addEventListener('click', () => history.forward());
}

function setView(name, { route = true, place = null } = {}) {
  // an editor the machine of the project has not (video.js): the code
  if (isOpen() && !hasEditor(readSettings().machine, name)) name = 'code';
  if (name !== view) stopPreview();
  view = name;
  document.body.dataset.view = name;
  updateSearch();
  document.querySelectorAll('.md-nav-rail__item').forEach(b => b.classList.toggle('md-nav-rail__item--active', b.dataset.view === name));
  for (const v of VIEWS) $(`#view-${v}`).hidden = name !== v;
  document.querySelectorAll('.toolbar__view').forEach(el => { el.hidden = el.dataset.for !== name; });
  const ready = isOpen() && store.game;
  if (name === 'code') codeView.render();
  if (name === 'screen' && ready) screenEditor.open(place ?? undefined);
  if (name === 'sprites' && ready) spriteEditor.open();
  if (name === 'chars' && ready) charEditor.open();
  if (name === 'tiles' && ready) tileEditor.open();
  if (name === 'bitmap' && isOpen()) bitmapEditor.open();
  if (name === 'sound' && isOpen()) soundEditor.open(); else soundEditor.close();
  if (name === 'hex') hexView.render();
  if (name === 'disasm') disasmView.render();
  if (name === 'debug') debugView.open(); else debugView.close();
  renderProblems();
  if (route) syncRoute();
  explorer?.refresh();
  updateChrome();
}
document.querySelectorAll('.md-nav-rail__item').forEach(b => { b.onclick = () => setView(b.dataset.view); });

// --- build, run, debug -----------------------------------------------------------------------------

let problems = [];                    // the errors and warnings of the last build
let building = false;

function mainProgram() {
  const s = readSettings();
  if (s.main && hasFile(s.main)) return s.main;
  const cur = codeView.current();
  return cur && !/\.inc$/i.test(cur) ? cur : listSources().find(p => !/\.inc$/i.test(p)) ?? null;
}
// what Build, Run and Debug make: in the code editor the source of the selected tab (not an include,
// a header or a text), elsewhere the main program
function buildTarget() {
  const cur = view === 'code' ? codeView.current() : null;
  return cur && hasFile(cur) && !/\.(inc|h|txt)$/i.test(cur) ? cur : mainProgram();
}

// build the main program: the build, or null when it failed
async function build({ quiet = false } = {}) {
  if (!isOpen() || building) return null;
  building = true;
  updateChrome();
  try {
    const main = buildTarget();
    // the toolchain of the project (toolchain.js): its compiler, then its packer
    const r = await buildWith(await currentToolchain(), main, { over: codeView.texts() });
    problems = r.errors ?? [];
    codeView.setBuild(r);
    const errs = problems.filter(p => p.severity !== 'warning');
    if (errs.length && !consoleOpen) consoleOpen = true;
    renderProblems();
    if (!r.ok || !r.file) {
      const first = errs[0];
      snackbar(`Build failed: ${first ? `${first.file ?? ''}${first.line ? ':' + first.line : ''} ${first.msg}` : 'no program'}`,
        { error: true, timeout: 8000, action: 'Show', onaction: () => showProblems() });
      return null;
    }
    const files = { [r.file.name]: r.file.bytes };
    if (r.viceLabels) files[`${r.name}.lbl`] = new TextEncoder().encode(r.viceLabels);
    if (r.listing) files[`${r.name}.lst`] = new TextEncoder().encode(r.listing);
    setProjectBuild(r.name, files);
    vice.setBuild(r);
    lastBuild = r;
    hexView.refreshBuild?.();
    disasmView.refreshBuild?.();
    if (!quiet) {
      const size = r.packed ? `${r.packed.before} → ${r.packed.after} bytes, packed with ${r.packed.packer}` : `${r.file.bytes.length} bytes${r.start != null ? ` from $${r.start.toString(16).padStart(4, '0')}` : ''}`;
      snackbar(`Built ${r.file.name}: ${size}${problems.length ? ` · ${problems.length} warning${problems.length > 1 ? 's' : ''}` : ''}`,
        { action: 'Download', onaction: () => saveFileAs(r.file.name, r.file.bytes, 'application/octet-stream', 'Program') });
    }
    return r;
  } finally {
    building = false;
    updateChrome();
  }
}
let lastBuild = null;

// build and start it in its emulator: VICE for the Commodore machines (debug: with the breakpoints,
// the debugger view shows), Altirra, Stella or WinAPE for the others (backend/emu) - or the
// emulator of the toolchain of the project: one of them, or its command (backend/toolchain)
async function runMain({ debug = false, onUltimate = false } = {}) {
  const r = await build({ quiet: true });
  if (!r) return;
  const p = machineOf(readSettings().machine);
  const download = { action: 'Download', onaction: () => saveFileAs(r.file.name, r.file.bytes, 'application/octet-stream', 'Program') };
  const emu = onUltimate ? 'ultimate' : r.toolchain?.emulator.kind ?? 'auto';
  // a real C64: the Ultimate 64 of the Settings (backend/ultimate) - the program runs, no debugger
  if (emu === 'ultimate') {
    if (debug) snackbar('The debugger works with VICE: on the Ultimate 64 the program only runs', { timeout: 6000 });
    if (!ultimateRuns(p)) { snackbar(`The Ultimate 64 runs C64 programs: this project is for the ${p.name}`, { error: true, timeout: 8000 }); return; }
    if (!(r.runPrg ?? r.prg)) { snackbar(`${r.file.name} is no .prg the Ultimate loads (format ${r.file.format})`, { error: true, ...download }); return; }
    if (!ultimate.value.host) { snackbar('No Ultimate 64 is set up: its address in the Settings (Assemblers and emulators)', { error: true, timeout: 8000, action: 'Settings', onaction: openSettings }); return; }
    try {
      await runOnUltimate(r);
      snackbar(`${r.file.name} runs on the Ultimate 64 at ${ultimate.value.host}`);
    } catch (e) {
      snackbar(`Ultimate 64: ${e.message}`, { error: true, timeout: 10000, ...download });
    }
    return;
  }
  if (emu === 'command') {
    if (debug) snackbar('The debugger works with VICE: the emulator of the toolchain only runs the program', { timeout: 6000 });
    try {
      const res = await runCommand(r, p);
      snackbar(`${r.file.name} runs: ${res.command}`, { timeout: 6000 });
    } catch (e) {
      snackbar(`The emulator of ${r.toolchain.name}: ${e.message}. The program is built.`, { error: true, timeout: 10000, ...download });
    }
    return;
  }
  if (p.emulator.kind !== 'vice') {
    if (debug) snackbar(`The debugger works with VICE (the Commodore machines): ${p.name} programs only run`, { timeout: 6000 });
    try {
      // the names of the formats of the launcher (backend/emu)
      const format = { amsdos: 'amsdos-bin', zx81: 'zx81-p', trs80: 'trs80-cmd', plain: { vcs: 'a26', nes: 'nes', snes: 'sfc', bbc: 'bbc-bin' }[p.emulator.platform] ?? 'plain' }[r.file.format] ?? r.file.format;
      const emulator = emu !== 'auto' && emulatorRuns(emu, p) ? emu : undefined;     // the toolchain's, else the one of the settings
      const res = await api('POST', 'api/emu/run', { platform: p.emulator.platform, model: p.emulator.model, emulator, name: r.name, data: toBase64(r.file.bytes), format, load: r.start, exec: r.exec });
      snackbar(`${r.file.name} runs in ${res.emulator ?? 'the emulator'} (${p.name})${res.emulator === 'altirra' ? ' - click its window: Altirra pauses while it has no focus' : ''}`, { timeout: 6000 });
    } catch (e) {
      snackbar(`${p.name}: ${e.message}. The program is built.`, { error: true, timeout: 10000, ...download });
    }
    return;
  }
  if (!r.prg) { snackbar(`${r.file.name} is no program VICE loads (format ${r.file.format})`, { error: true, ...download }); return; }
  const s = await vice.refreshStatus();
  if (!s.available) {
    snackbar('VICE was not found: set the environment variable VICE to the folder of x64sc and restart the server. The program is built.', { error: true, timeout: 10000, ...download });
    return;
  }
  try {
    await vice.runBuild(r, p, { debug });
    snackbar(`${r.file.name} runs in VICE (${p.name})${debug ? ' with its breakpoints' : ''}`);
    if (debug) setView('debug');
  } catch (e) {
    snackbar(`VICE: ${e.message}`, { error: true, timeout: 8000 });
  }
}


// --- problems: the console below the code editor, the debugger, the disassembler and the hex view ---

const CONSOLE_VIEWS = ['code', 'debug', 'disasm', 'hex'];
const CONSOLE_KEY = 'ns-problems-open';
let consoleOpen = (() => { try { return localStorage.getItem(CONSOLE_KEY) !== '0'; } catch { return true; } })();
function setConsoleOpen(open) {
  consoleOpen = open;
  try { localStorage.setItem(CONSOLE_KEY, open ? '1' : '0'); } catch { /* the default next time */ }
  renderProblems();
}
// its top edge: dragged it resizes the console, a double click gives it its own height again, the
// arrow keys move it (like the grip of the side panels, pui.js)
const HEIGHT_KEY = 'ns-problems-height', MIN_CONSOLE = 80;
// at most the height of the main area less room for the view (not yet laid out: no limit)
const clampConsole = px => {
  const room = $('.main').getBoundingClientRect().height - 120;
  return Math.round(Math.max(MIN_CONSOLE, room > MIN_CONSOLE ? Math.min(px, room) : px));
};
let consoleHeight = (() => { try { return Number(localStorage.getItem(HEIGHT_KEY)) || null; } catch { return null; } })();
function setConsoleHeight(px) {
  consoleHeight = px == null ? null : clampConsole(px);
  $('#problems-console').style.height = consoleOpen && consoleHeight ? `${consoleHeight}px` : '';
  try { if (px == null) localStorage.removeItem(HEIGHT_KEY); else localStorage.setItem(HEIGHT_KEY, String(consoleHeight)); } catch { /* private mode */ }
}
const consoleGrip = () => h('div', { class: 'problems-console__resize', tabindex: '0', role: 'separator', 'aria-orientation': 'horizontal',
  'aria-label': 'Resize the problems', 'data-tip': 'Drag to resize, double click for the default height',
  onpointerdown: e => {
    e.preventDefault();
    const g = e.currentTarget, el = $('#problems-console'), y0 = e.clientY, h0 = el.getBoundingClientRect().height;
    g.setPointerCapture(e.pointerId);
    document.body.classList.add('row-resizing');
    const move = ev => { el.style.height = `${clampConsole(h0 + (y0 - ev.clientY))}px`; };
    const stop = () => {
      g.removeEventListener('pointermove', move);
      g.removeEventListener('pointerup', stop);
      g.removeEventListener('pointercancel', stop);
      document.body.classList.remove('row-resizing');
      setConsoleHeight(el.getBoundingClientRect().height);
    };
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', stop);
    g.addEventListener('pointercancel', stop);
  },
  ondblclick: () => setConsoleHeight(null),
  onkeydown: e => {
    const step = { ArrowUp: 24, ArrowDown: -24 }[e.key];
    if (!step) return;
    e.preventDefault();
    setConsoleHeight($('#problems-console').getBoundingClientRect().height + step);
  } });

let problemsFilter = '';
function problemsView() {
  const errors = problems.filter(p => p.severity !== 'warning').length, warnings = problems.length - errors;
  const q = problemsFilter.trim().toLowerCase();
  const list = q ? problems.filter(p => `${p.msg} ${p.file ?? ''} ${p.line ?? ''}`.toLowerCase().includes(q)) : problems;
  const head = h('div', { class: 'problems-console__head' },
    h('button', { class: 'problems-console__toggle', type: 'button', 'aria-expanded': String(consoleOpen), onclick: () => setConsoleOpen(!consoleOpen) },
      icon(consoleOpen ? 'expand_more' : 'expand_less'),
      h('span', { class: 'md-title-small' }, 'Problems'),
      h('span', { class: 'problems-console__count', 'data-i18n': 'off' }, icon('error', 'sev-error'), String(errors)),
      h('span', { class: 'problems-console__count', 'data-i18n': 'off' }, icon('warning', 'sev-warning'), String(warnings))),
    consoleOpen && problems.length > 0 && h('input', { class: 'problems-console__filter', type: 'search', placeholder: 'Filter the problems', value: problemsFilter,
      oninput: e => { problemsFilter = e.target.value; renderProblems(); } }));
  if (!consoleOpen) return head;
  const body = !list.length
    ? h('div', { class: 'problems-console__empty md-body-small' }, q ? `Nothing matches “${problemsFilter}”`
      : 'No problems. Build (Ctrl+B) lists the errors and warnings of the assembler or the BASIC tokenizer here.')
    : list.map(p => h('button', { class: 'problems-console__row', type: 'button',
      onclick: () => { if (p.file) { setView('code'); codeView.open(p.file, p.line); } } },
    icon(p.severity === 'warning' ? 'warning' : 'error', `sev-${p.severity || 'error'}`),
    h('span', { class: 'problems-console__msg', 'data-i18n': 'off' }, p.msg),
    h('span', { class: 'problems-console__where', 'data-i18n': 'off' }, `${p.file ?? ''}${p.line ? `:${p.line}` : ''}${p.col ? `:${p.col}` : ''}`)));
  return [consoleGrip(), head, h('div', { class: 'problems-console__list' }, body)];
}
let problemsMount = null;
function renderProblems() {
  const el = $('#problems-console');
  problemsMount ??= mount(el, problemsView);
  el.hidden = !isOpen() || !CONSOLE_VIEWS.includes(view);
  el.classList.toggle('problems-console--open', consoleOpen);
  el.style.height = consoleOpen && consoleHeight ? `${clampConsole(consoleHeight)}px` : '';
  problemsMount.update();
  updateChrome();
}
// the build failed: the console open, below the source when the view has none
function showProblems() {
  if (!CONSOLE_VIEWS.includes(view)) setView('code');
  setConsoleOpen(true);
}

// --- the project -----------------------------------------------------------------------------------

function unsavedEdits() {
  return codeView.isDirty() || hexView.isDirty() || store.dirty || dirtyCharsets().length > 0 || tileEditor.isDirty() || soundEditor.isDirty() || bitmapEditor.isDirty();
}

async function mayReplaceProject({ closing = false } = {}) {
  const inFolder = isOpen() && !!projectFolder();
  if (inFolder) await flushFolder();              // the folder is the project: what is still on its way
  const edits = isOpen() && unsavedEdits(), files = isOpen() && isProjectDirty();
  if (!edits && !files) return true;
  const what = edits ? 'changes that are not saved' : inFolder ? `files that could not be written to ${projectFolder()} (${folderProblem() ?? 'unknown'})` : 'files that are not exported to a project package';
  return new Promise(resolve => dialog({
    title: 'Unsaved work',
    content: h('div', { class: 'md-body-medium' }, `${projectName()} has ${what}. ${closing ? 'Close it anyway?' : 'Open another project anyway?'}`),
    actions: [
      { label: 'Cancel', value: false },
      { label: closing ? 'Close' : 'Discard', value: true, danger: true },
      inFolder ? { label: 'Save', icon: 'save', variant: 'filled', value: true, onclick: saveToDisk }
        : { label: 'Save and export', icon: 'archive', variant: 'filled', value: true, onclick: saveAndExport },
    ],
    onclose: v => resolve(v === true),
  }));
}

// a project was opened: its graphics model, its sources, the start screen gone
async function startProject() {
  hideStart();
  if (!hasFile(SETTINGS)) writeSettings({});
  loadAssets();
  vice.setBreakpointProject(projectName());
  codeView.reset();
  hexView.reset();
  disasmView.reset();
  problems = [];
  renderProblems();
  setView(view);
  updateChrome();
}

// a new project: a name, the machine and the language of the first program
async function newProject() {
  if (!(await mayReplaceProject())) return;
  const v = await projectWizard();
  if (!v) return;
  // where it is kept: a folder of its name in the folder chosen - none chosen: in this browser
  const dir = await newProjectFolder(v.name);
  if (dir === false) return;
  setProject(v.name, v.files, { isDirty: true });
  if (dir && !(await saveToFolder(dir))) snackbar(`Not saved in ${dir}: ${folderProblem()} - the project is kept in this browser`, { error: true, timeout: 10000 });
  await startProject();
  setView('code');
  if (v.main) codeView.open(v.main);
  snackbar(projectFolder() ? `${v.name} is in ${projectFolder()}, ready for the ${machineOf(v.platform).name}: Ctrl+B builds, F5 runs it`
    : `${v.name} is ready for the ${machineOf(v.platform).name} - kept in this browser (File › Save to a folder… puts it on your disk)`, { timeout: 8000 });
}

// the folder of a new project: NAME in a folder the user chooses, made there - null: none chosen (the browser
// keeps the project), false: given up (a project of that name is there and is not to be replaced)
async function newProjectFolder(projectName) {
  const name = projectName.replace(/[\\/:*?"<>|]/g, '_').trim() || 'project';
  const parent = await chooseFolder({ title: `Where should ${projectName} be kept?`, ok: 'Create here',
    note: `A folder "${name}" is made in the folder chosen; the project's files are written into it. Cancel: the project is kept in this browser.` });
  if (!parent) return null;
  const sep = parent.includes('\\') ? '\\' : '/';
  const dir = parent.endsWith(sep) ? parent + name : parent + sep + name;
  try {
    const there = (await listDirs(parent)).dirs.find(d => d.name.toLowerCase() === name.toLowerCase());
    if (there?.project && !(await new Promise(resolve => dialog({
      title: 'A project is there',
      content: h('div', { class: 'md-body-medium' }, `${dir} holds a nerdsuite project already. Its files with the names of the new project's files are replaced.`),
      actions: [{ label: 'Cancel', value: false }, { label: 'Replace', value: true, danger: true }],
      onclose: r => resolve(r === true),
    })))) return false;
    await makeDir(dir);
  } catch (e) {
    snackbar(`${dir} could not be made: ${e.message} - the project is kept in this browser`, { error: true, timeout: 10000 });
    return null;
  }
  return dir;
}

async function openProject() {
  if (!(await mayReplaceProject())) return;
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: `${PROJECT_EXT},.zip,application/zip` });
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      await openZip(new Uint8Array(await file.arrayBuffer()), file.name);
    } catch (e) {
      snackbar(`${file.name} could not be opened: ${e.message}`, { error: true, timeout: 8000 });
      return;
    }
    await startProject();
    snackbar(`${file.name} opened`);
  };
  input.click();
}

async function openExample() {
  if (!(await mayReplaceProject())) return;
  try {
    const { name, files } = await api('GET', 'api/examples');
    setProject(name, new Map(Object.entries(files).map(([p, d]) => [p, fromBase64(d)])));
  } catch (e) {
    snackbar(`The example could not be loaded: ${e.message}`, { error: true });
    return;
  }
  await startProject();
  setView('code');
}

// every editor into its files: what could not be saved (a new picture or song without a path)
async function saveEditors() {
  if (!isOpen()) return null;
  const kept = [];
  try {
    codeView.saveChanges();
    hexView.saveChanges();
    if (!saveAssets()) return null;
    for (const key of dirtyCharsets()) await saveCharset(key);
    await tileEditor.saveChanges();
    if (!(await bitmapEditor.saveChanges())) kept.push('the picture');
    if (!(await soundEditor.saveChanges())) kept.push('the song');
    return kept;
  } catch (e) {
    snackbar(`Save failed: ${e.message}`, { error: true });
    return null;
  } finally {
    updateChrome();
  }
}

async function saveAll() {
  const kept = await saveEditors();
  if (!kept) return;
  if (projectFolder() && !(await flushFolder())) return snackbar(`Not saved in ${projectFolder()}: ${folderProblem()}`, { error: true, timeout: 10000 });
  if (kept.length) snackbar(`Saved - not ${kept.join(', ')}`, { error: true, timeout: 8000 });
  else if (projectFolder()) snackbar(`Saved in ${projectFolder()}`);
  else snackbar('Saved. Export (the download icon) writes the project package to your disk - or File › Save to a folder…');
}

// the editors into their files and those into the project's folder: false when something was not saved
async function saveToDisk() {
  const kept = await saveEditors();
  if (!kept || kept.length) return false;
  if (!(await flushFolder())) { snackbar(`Not saved in ${projectFolder()}: ${folderProblem()}`, { error: true, timeout: 10000 }); return false; }
  return true;
}

// a folder of the computer as the project (backend/disk): the files are read from it and written back
async function openProjectFolder() {
  if (!(await mayReplaceProject())) return;
  const dir = await chooseFolder({ title: 'Open a project folder', ok: 'Open' });
  if (!dir) return;
  let r;
  try { r = await openFolder(dir); } catch (e) {
    snackbar(`${dir} could not be opened: ${e.message}`, { error: true, timeout: 8000 });
    return;
  }
  if (!allFiles().length) snackbar(`${dir} has no files of a project - new ones are written into it`, { timeout: 8000 });
  await startProject();
  if (r.skipped.length) snackbar(`Left out (larger than 1 MB): ${r.skipped.slice(0, 4).join(', ')}${r.skipped.length > 4 ? ' …' : ''}`, { timeout: 10000 });
  else if (allFiles().length) snackbar(`${dir} opened: changes are written into it`);
}

// the project into a folder of the computer, which is the project from then on
async function saveProjectToFolder() {
  const kept = await saveEditors();
  if (!kept) return;
  const dir = await chooseFolder({ title: 'Save the project into a folder', ok: 'Save here' });
  if (!dir) return;
  // another project there: its files of the same names are replaced
  const there = await listDirs(dir).catch(() => null);
  if (there?.project && dir !== projectFolder() && !(await new Promise(resolve => dialog({
    title: 'A project is there',
    content: h('div', { class: 'md-body-medium' }, `${dir} holds a nerdsuite project. Its files with the names of this project's files are replaced.`),
    actions: [{ label: 'Cancel', value: false }, { label: 'Replace', value: true, danger: true }],
    onclose: v => resolve(v === true),
  })))) return;
  if (!(await saveToFolder(dir))) {
    forgetFolder(dir);
    return snackbar(`Not saved in ${dir}: ${folderProblem()}`, { error: true, timeout: 10000 });
  }
  updateChrome();
  snackbar(`Saved in ${dir}: changes are written into it from now on`);
}

// a write into the folder that failed in the background: said once
let toldProblem = null;
onProjectChange(() => {
  const p = projectFolder() && folderProblem();
  if (p && p !== toldProblem) snackbar(`Not written to ${projectFolder()}: ${p}`, { error: true, timeout: 10000 });
  toldProblem = p || null;
});

async function saveAndExport() {
  const kept = await saveEditors();
  if (!kept || kept.length) return false;
  try {
    if (!(await saveFileAs(zipName(), await zipBytes(), 'application/zip', 'nerdsuite project'))) return false;
  } catch (e) {
    snackbar(`Export failed: ${e.message}`, { error: true });
    return false;
  }
  markZipSaved();
  snackbar(`${zipName()} saved`);
  return true;
}

async function offerClosedProjects() {
  for (const p of await closedProjects()) {
    if (isOpen()) return;
    const choice = await new Promise(resolve => dialog({
      title: `Restore ${p.name}?`,
      content: h('div', { class: 'md-body-medium' }, `A tab with the project ${p.name} was closed on ${new Date(p.time).toLocaleString()} before it was exported.`),
      actions: [{ label: 'Discard', value: 'discard', danger: true }, { label: 'Later', value: null }, { label: 'Restore', icon: 'restore', variant: 'filled', value: 'restore' }],
      onclose: resolve,
    }));
    if (choice === 'discard') await discardProject(p.id);
    if (choice !== 'restore') continue;
    try { await recoverProject(p.id); } catch (e) { snackbar(`${p.name}: ${e.message}`, { error: true }); continue; }
    await startProject();
    return;
  }
}

async function closeTheProject() {
  if (!(await mayReplaceProject({ closing: true }))) return;
  closeProject();
  await flushSession();
  store.dirty = false;
  history.replaceState(null, '', new URL('.', document.baseURI));
  location.reload();
}

// --- export and import ---------------------------------------------------------------------------

function buildExports() {
  if (!hasBuild()) return [];
  return [
    { label: `${buildName()}-build.zip`, icon: 'archive', name: `${buildName()}-build.zip`, type: 'application/zip', description: 'Build', bytes: () => writeZip(buildFiles()) },
    ...[...buildFiles().keys()].map(n => ({ label: n, icon: 'download', name: n, description: 'Build file', bytes: () => buildFiles().get(n) })),
  ];
}

function viewExports() {
  switch (view) {
    case 'code': return [...codeView.exportFormats(), ...buildExports()];
    case 'debug': return buildExports();
    case 'hex': return [...hexView.exportFormats(), ...buildExports()];
    case 'disasm': return [...disasmView.exportFormats(), ...buildExports()];
    case 'screen': return screenEditor.exportFormats();
    case 'sprites': return spriteEditor.exportFormats();
    case 'chars': return charEditor.exportFormats();
    case 'tiles': return tileEditor.exportFormats();
    case 'bitmap': return bitmapEditor.exportFormats();
    case 'sound': return soundEditor.exportFormats();
    default: return [];
  }
}
function exportFormats() {
  if (!isOpen()) return [];
  const project = { label: `The project (${zipName()})`, icon: 'archive', name: zipName(), type: 'application/zip', description: 'nerdsuite project', bytes: zipBytes, done: markZipSaved };
  const own = viewExports();
  return own.length ? [project, { divider: true }, ...own] : [project];
}
$('#btn-export').onclick = e => openExportMenu(e.currentTarget, exportFormats());

function importFormats() {
  if (!isOpen()) return [];
  switch (view) {
    case 'code': return codeView.importFormats();
    case 'screen': return screenEditor.importFormats();
    case 'sprites': return spriteEditor.importFormats();
    case 'chars': return charEditor.importFormats();
    case 'tiles': return tileEditor.importFormats();
    case 'bitmap': return bitmapEditor.importFormats();
    case 'sound': return soundEditor.importFormats();
    default: return [];
  }
}
$('#btn-import').onclick = e => openImportMenu(e.currentTarget, importFormats());

// --- the start screen ------------------------------------------------------------------------------

let startView = null;
function showStart() {
  if ($('#start-screen')) return;
  const el = Object.assign(document.createElement('div'), { id: 'start-screen', className: 'board-empty start-screen' });
  $('.main').append(el);
  startView = mount(el, () => [h('img', { class: 'start-screen__logo', src: 'images/nerdsuite.png', alt: 'nerdsuite' }),

    h('div', { class: 'md-body-medium start-screen__text' },
      'An IDE for 8 bit machines - Commodore, Atari, Amstrad / Schneider CPC: assembler (ACME, 6502 and Z80) and BASIC with autocompletion, the screen, sprite, char, tile and bitmap editors, the composer, a hex view, and a debugger in VICE.'),
    h('div', { class: 'start-screen__actions' },
      button('New project', { icon: 'add', variant: 'filled', onclick: newProject }),
      button('Open folder…', { icon: 'folder_open', variant: 'tonal', onclick: openProjectFolder }),
      button('Open project…', { icon: 'archive', variant: 'tonal', onclick: openProject }),
      button('Open example', { icon: 'lightbulb', variant: 'text', onclick: openExample }))]);
}
function hideStart() {
  startView?.dispose();
  startView = null;
  $('#start-screen')?.remove();
}

$('#btn-file').onclick = e => openMenu(e.currentTarget, [
  { header: 'Project' },
  { label: 'New project…', icon: 'add', onclick: newProject },
  { label: 'Open folder…', icon: 'folder_open', onclick: openProjectFolder },
  { label: 'Open project package…', icon: 'archive', onclick: openProject },
  { label: 'Open example', icon: 'lightbulb', onclick: openExample },
  isOpen() && { label: projectFolder() ? 'Save to another folder…' : 'Save to a folder…', icon: 'save', onclick: saveProjectToFolder },
  isOpen() && { label: `Export the project (${zipName()})`, icon: 'archive', onclick: saveAndExport },
  isOpen() && { divider: true },
  isOpen() && { label: 'Project settings…', icon: 'tune', onclick: projectSettings },
  { label: 'Download the build', icon: 'download', disabled: !hasBuild(), onclick: () => downloadBuild().catch(err => snackbar(err.message, { error: true })) },
  isOpen() && { label: 'Close the project', icon: 'close', onclick: closeTheProject },
]);

async function projectSettings() {
  const list = await loadToolchains({ again: true });
  const s = readSettings();
  const sources = listSources().filter(p => !/\.inc$/i.test(p));
  const v = await promptDialog({ title: 'Project settings', ok: 'Save', fields: [
    { name: 'machine', label: 'Machine (VICE, the BASIC dialect of new files)', value: s.machine, options: MACHINES.map(m => ({ value: m.id, label: m.name })) },
    { name: 'main', label: 'Main program (Build, Run, Debug)', value: s.main ?? '', options: [{ value: '', label: 'the source in the editor' }, ...sources.map(p => ({ value: p, label: p }))] },
    // the names BASIC asks with @if (basic/preprocess.js), besides the #define lines of the source
    { name: 'defines', label: 'Defines for @if in BASIC (debug, level=2)', value: s.defines ?? '', mono: true, placeholder: 'none' },
    // the toolchains of the Settings (toolchain.js): compiler › packer › emulator
    { name: 'toolchain', label: 'Toolchain (compiler › packer › emulator - the Settings set them up)', value: list.some(t => t.id === s.toolchain) ? s.toolchain : '',
      options: [{ value: '', label: `None: ${chainLabel(null, machineOf(s.machine), mainProgram())}` },
        ...list.map(t => ({ value: t.id, label: `${t.name}: ${chainLabel(t, machineOf(t.machine || s.machine), mainProgram())}${t.machine && t.machine !== s.machine ? ` (${machineOf(t.machine).name})` : ''}` }))] },
  ] });
  if (!v) return;
  writeSettings({ machine: v.machine, main: v.main || null, toolchain: v.toolchain || null, defines: v.defines.trim() || undefined });
  updateChrome();
  codeView.render();
}

// --- chrome --------------------------------------------------------------------------------------

function updateDots() {
  $('#save-dot').hidden = !isOpen() || !unsavedEdits();
  $('#export-dot').hidden = !isOpen() || !isProjectDirty();
}

function updateChrome() {
  document.documentElement.classList.toggle('no-project', !isOpen());
  // the graphics editors of the machine (video.js): no sprites on a CPC, no bitmap on a VIC-20 ...
  const machine = readSettings().machine;
  document.querySelectorAll('.md-nav-rail__item[data-view]').forEach(b => { b.hidden = isOpen() && !hasEditor(machine, b.dataset.view); });
  if (isOpen() && !hasEditor(machine, view)) { setView('code'); return; }
  // its colours and colour rules in the editors (video.js): the open one draws in them again
  loadMachineFont(isOpen() ? machine : 'c64');                     // its ROM font, from an emulator here (romfonts.js)
  if (setVideoMachine(isOpen() ? machine : 'c64') && GFX_VIEWS.includes(view)) { setView(view, { route: false }); return; }
  document.body.classList.toggle('no-game', !store.game);
  const start = $('#start-screen');
  if (start) start.hidden = isOpen();
  const main = isOpen() ? buildTarget() : null;
  $('#file-name').textContent = !isOpen() ? t('no project') : `${projectName()} · ${machineOf(readSettings().machine).name}`;
  $('#file-name').title = isOpen() ? (projectFolder() ? `in the folder ${projectFolder()}` : 'in this browser - Export or File › Save to a folder… writes it to your disk') : '';
  $('#btn-save').disabled = !isOpen();
  $('#search-box').hidden = !isOpen() || !SEARCH[view];
  // Build, Run, Debug and the Ultimate as the bar of the code editor shows them (codeview.js)
  const platform = machineOf(readSettings().machine);
  const off = !isOpen() || !main || building, vice = platform.emulator.kind === 'vice';
  const chain = isOpen() ? chainLabel(projectToolchain(), platform, main) : '';   // the steps of the toolchain of the project
  runState.value = {
    build: { disabled: off, tip: (main ? `Build ${main} (Ctrl+B)` : 'Build: create a source first') + (chain ? ` · ${chain}` : '') },
    run: { disabled: off, tip: chain ? `Build and run: ${chain} (F5)` : 'Build and run (F5)' },
    debug: { disabled: off || !vice, tip: vice ? 'Build and debug in VICE (F6)' : `The debugger works with VICE: ${platform.name} programs run with F5` },
    // the Ultimate 64: set up in the Settings, a C64 project
    ultimate: { disabled: off, hidden: !ultimate.value.host || !ultimateRuns(platform), tip: `Build and run on the Ultimate 64 at ${ultimate.value.host} (Shift+F5)` },
  };
  $('#btn-export').disabled = !isOpen();
  $('#btn-import').disabled = !isOpen() || !importFormats().length;
  updateDots();
  document.title = `${unsavedEdits() ? '• ' : ''}${isOpen() ? projectName() + ' – ' : ''}NerdSuite`;
}

store.on(() => updateChrome());
// the ROM font of the machine came from the server: the editors draw with it
onFontChange(() => { if (GFX_VIEWS.includes(view)) setView(view, { route: false }); });
toolchains.subscribe(() => updateChrome());
ultimate.subscribe(() => updateChrome());
loadToolchains();
$('#btn-save').onclick = saveAll;

$('#btn-menu').onclick = e => openMenu(e.currentTarget, [
  { label: 'Settings…', icon: 'tune', kbd: 'Ctrl+,', onclick: openSettings },
  { divider: true },
  document.documentElement.dataset.theme === 'dark'
    ? { label: 'Light theme', icon: 'light_mode', onclick: toggleTheme }
    : { label: 'Dark theme', icon: 'dark_mode', onclick: toggleTheme },
  { header: 'Language' },
  ...LANGUAGES.map(l => ({ label: l.label, icon: 'language', checked: lang.value === l.value, onclick: () => setLang(l.value) })),
  { divider: true },
  { label: 'Keyboard shortcuts', icon: 'keyboard', onclick: showKeys },
  { label: 'About NerdSuite', icon: 'info', onclick: showAbout },
]);

function showKeys() {
  const rows = [
    ['Ctrl+S', 'save every editor'], ['Ctrl+B', 'build the main program'], ['F5', 'build and run in VICE (continue while stopped)'],
    ['Shift+F5', 'build and run on the Ultimate 64 (Settings)'], ['F6', 'build and debug in VICE'], ['F8', 'pause / continue'], ['F10', 'step over'], ['F11', 'step into'], ['Shift+F11', 'step out'],
    ['Ctrl+Space', 'suggestions at the caret'], ['Ctrl+click', 'go to the definition of a label or macro'], ['Ctrl+/', 'comment the lines in or out'],
    ['Ctrl+wheel / Ctrl+0', 'zoom the code / its own size'], ['Ctrl+,', 'the settings: editor, colours, assemblers and emulators'],
    ['Tab / Shift+Tab', 'indent the lines in or out'], ['Ctrl+F', 'search'], ['Ctrl+Z / Ctrl+Y', 'undo / redo'],
  ];
  dialog({ title: 'Keyboard shortcuts', content: h('table', { class: 'ns-keys' }, rows.map(([k, d]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, d)))),
    actions: [{ label: 'Close', value: null, variant: 'filled' }] });
}

function showAbout() {
  dialog({
    title: 'About NerdSuite',
    content: h('div', { class: 'about' },
      h('img', { class: 'about__logo', src: 'images/nerdsuite.png', alt: 'nerdsuite' }),
      h('div', { class: 'md-body-small about__text', 'data-i18n': 'off' }, 'drazil 2026 · the graphics editors and the composer of yopaca'),
      h('div', { class: 'md-body-small about__text', 'data-i18n': 'off' }, 'Icons: ',
        h('a', { href: 'https://icons8.com/line-awesome', target: '_blank', rel: 'noopener' }, 'Line Awesome by Icons8'))),
    actions: [{ label: 'Close', value: null, variant: 'filled' }],
  });
}

const STATIC_CHROME = ['.md-top-app-bar', '.md-nav-rail'];
document.documentElement.lang = lang.value;
lang.subscribe(() => { updateChrome(); STATIC_CHROME.forEach(sel => document.querySelectorAll(sel).forEach(el => translateDom(el))); });

// --- search ------------------------------------------------------------------------------------------

const search = $('#search');
let matchIndex = -1;
const SEARCH = {
  code: { placeholder: 'Find in the source', next: dir => findInCode(search.value, dir), live: v => codeView.setSearch(v) },
  screen: { placeholder: 'Find a screen', list: async () => { const { screensOf } = await import('./adv.js'); return screensOf(store.game).map(r => ({ label: r.name, go: () => screenEditor.open(r.id) })); } },
  sprites: { placeholder: 'Find a sprite', list: async () => { const { symbols } = await import('./adv.js'); return store.game ? symbols(store.game).costumes.map(c => ({ label: c.name, go: () => { spriteEditor.select(c.id, 'stand'); spriteEditor.open(); } })) : []; } },
  chars: { placeholder: 'Find a charset', list: () => allFiles().filter(f => /\.(chr|fnt|bin|raw)$/i.test(f)).map(f => ({ label: f, go: () => { charEditor.selectKey(f); charEditor.open(); } })) },
  tiles: { placeholder: 'Find a tileset', list: () => allFiles().filter(f => /\.til$/i.test(f)).map(f => ({ label: f, go: () => { tileEditor.selectKey(f); tileEditor.open(); } })) },
  bitmap: { placeholder: 'Find a picture', list: () => allFiles().filter(f => /\.(kla|art)$/i.test(f)).map(f => ({ label: f, go: () => bitmapEditor.select(f) })) },
  sound: { placeholder: 'Find a song', list: () => allFiles().filter(f => /\.sng$/i.test(f)).map(f => ({ label: f, go: () => soundEditor.select(f) })) },
  hex: { placeholder: 'Find hex bytes or "text"', next: dir => hexView.findNext(search.value, dir) },
  disasm: { placeholder: 'Find in the disassembly', next: dir => disasmView.findNext(search.value, dir) },
};
function findInCode(text, dir) {
  const ta = codeView.findIn(), q = text.trim().toLowerCase();
  if (!ta || !q) return;
  const hay = ta.value.toLowerCase();
  const from = dir < 0 ? ta.selectionStart - 1 : ta.selectionEnd;
  let at = dir < 0 ? hay.lastIndexOf(q, Math.max(0, from)) : hay.indexOf(q, from);
  if (at < 0) at = dir < 0 ? hay.lastIndexOf(q) : hay.indexOf(q);
  if (at < 0) return snackbar(`“${text.trim()}” is not in the source`, { error: true });
  ta.setSelectionRange(at, at + q.length);
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
  const line = hay.slice(0, at).split('\n').length;
  const y = (line - 1) * lh;
  if (y < ta.scrollTop || y > ta.scrollTop + ta.clientHeight - lh) ta.scrollTop = Math.max(0, y - ta.clientHeight / 2);
  ta.dispatchEvent(new Event('scroll'));
}
async function searchNext(dir) {
  const s = SEARCH[view];
  if (!s?.next && !s?.list) return;
  if (s.next) return s.next(dir);
  const q = search.value.trim().toLowerCase();
  const m = q ? (await s.list()).filter(x => x.label.toLowerCase().includes(q)) : [];
  if (!m.length) return snackbar(`Nothing matches “${search.value}”`, { error: true });
  matchIndex = (matchIndex + dir + m.length) % m.length;
  m[matchIndex].go();
}
const PANEL_VIEWS = ['screen', 'sprites', 'chars', 'tiles', 'bitmap', 'sound', 'debug'];
const panelOf = v => (PANEL_VIEWS.includes(v) ? $(`#view-${v}`) : null);
function updateSearch() {
  const s = SEARCH[view];
  $('#search-box').hidden = !s;
  for (const b of ['#btn-search-prev', '#btn-search-next']) $(b).hidden = !s?.next && !s?.list;
  if (s) search.placeholder = s.placeholder;
  matchIndex = -1;
  if (s?.live) s.live(search.value);
  searchPanel(s ? panelOf(view) : null, search.value);
}
search.addEventListener('input', () => { matchIndex = -1; SEARCH[view]?.live?.(search.value); searchPanel(panelOf(view), search.value); });
search.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); searchNext(e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape') { e.preventDefault(); search.value = ''; SEARCH[view]?.live?.(''); searchPanel(panelOf(view), ''); search.blur(); if (view === 'code') codeView.focus(); }
});
for (const [sel, dir] of [['#btn-search-prev', -1], ['#btn-search-next', 1]]) {
  $(sel).addEventListener('mousedown', e => e.preventDefault());
  $(sel).addEventListener('click', e => { e.preventDefault(); searchNext(dir); });
}

// --- keys -------------------------------------------------------------------------------------------

const isTyping = el => el.closest?.('input, textarea, select, [contenteditable]');

addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (e.shiftKey && view === 'bitmap') bitmapEditor.saveAs(); else saveAll(); return; }
  if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); build(); return; }
  if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); search.focus(); search.select(); return; }
  if (mod && e.key === ',') { e.preventDefault(); openSettings(); return; }
  // the debugger's keys wherever the focus is: F8, F10, F11 (and F5 while stopped)
  if (/^F(5|8|10|11)$/.test(e.key) && debugView.keys(e)) return;
  if (e.key === 'F5' && e.shiftKey && !mod) { e.preventDefault(); if (isOpen() && ultimate.value.host) runMain({ onUltimate: true }); return; }
  if (e.key === 'F5' && !mod) { e.preventDefault(); runMain(); return; }
  if (e.key === 'F6' && !mod) { e.preventDefault(); runMain({ debug: true }); return; }
  if (document.querySelector('.md-dialog-scrim')) return;
  if ((view === 'sprites' || view === 'chars') && mod && !e.altKey && ['c', 'v'].includes(e.key.toLowerCase()) && !e.defaultPrevented
      && !String(getSelection()) && !e.target.closest?.('input, textarea, [contenteditable]')) {
    e.preventDefault();
    const ed = view === 'sprites' ? spriteEditor : charEditor;
    if (e.key.toLowerCase() === 'c') ed.copy(); else ed.paste();
    return;
  }
  if (isTyping(e.target)) return;
  const drawing = { screen: screenEditor, sprites: spriteEditor, chars: charEditor, tiles: tileEditor, bitmap: bitmapEditor }[view];
  if (drawing && e.key === 'Escape' && !mod && !e.defaultPrevented) { if (drawing.cancel()) e.preventDefault(); return; }
  if ((view === 'chars' || view === 'tiles' || view === 'bitmap') && mod && ['z', 'y'].includes(e.key.toLowerCase())) {
    e.preventDefault();
    const ed = { chars: charEditor, tiles: tileEditor, bitmap: bitmapEditor }[view];
    if (e.key.toLowerCase() === 'y' || e.shiftKey) ed.redo(); else ed.undo();
    return;
  }
  if ((view === 'screen' || view === 'sprites') && mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) store.redo(); else store.undo(); return; }
  if ((view === 'screen' || view === 'sprites') && mod && e.key.toLowerCase() === 'y') { e.preventDefault(); store.redo(); }
});

addEventListener('beforeunload', e => { if (unsavedEdits() || (isOpen() && isProjectDirty())) { e.preventDefault(); e.returnValue = ''; } });
onProjectChange(() => updateChrome());
onCharsetChange(() => { updateDots(); if (store.game) store.emit('change', { source: 'charset' }); });
onPictureChange(() => { if (store.game) store.emit('change', { source: 'picture' }); });
vice.onEvent(() => updateChrome());

// --- boot ---------------------------------------------------------------------------------------------

(async () => {
  try {
    // this window of the IDE: a desktop start ends when its windows are gone (backend/windows.go)
    const win = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const info = await api('GET', `api/info?window=${win}`);
    setEditorVersion(info.version);
    setWriterTag(info.version);
    if (info.version) {
      const v = $('#app-version');
      v.textContent = info.version;
      v.dataset.tip = `nerdsuite ${info.version}`;
      v.hidden = false;
    }
    if (info.idle) {                                  // a desktop start without a console window: it ends when its last window closes
      const alive = () => api('GET', `api/info?window=${win}`).catch(() => {});
      setInterval(alive, Math.max(10, info.idle / 5) * 1000);
      addEventListener('visibilitychange', () => { if (!document.hidden) alive(); });
      // closed (or reloaded: the new page asks at once, the server waits for that)
      addEventListener('pagehide', () => navigator.sendBeacon(`api/bye?window=${win}`));
    }
  } catch (e) {
    snackbar(`The server does not answer: ${e.message}`, { error: true, timeout: 0 });
  }
  vice.connectEvents();
  vice.refreshStatus();
  try {
    await restoreSession();
    if (isOpen()) {
      await startProject();
      const route = router.parse() ?? { name: 'code', params: {}, query: {} };
      await applyRoute(route);
      loadUi(projectName());
    } else {
      showStart();
      setView('code', { route: false });
      offerClosedProjects();
    }
  } catch (e) {
    snackbar(`The project could not be restored: ${e.message}`, { error: true, timeout: 0 });
    showStart();
  }
  booting = false;
  router.sync(stateRoute(), { replace: true });
  updateChrome();
})();

keepUi('code', { save: () => ({ view }), load() { /* the tabs keep themselves (codeview.js) */ } });
watchUi(() => (isOpen() ? projectName() : null));

window.nerdsuite = { store, actions, codeView, screenEditor, spriteEditor, charEditor, vice, build, runMain };
