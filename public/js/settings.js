// settings.js - the Settings of the IDE (the menu of the app bar, Ctrl+,):
//   Editor      the font of the code, its size, the line spacing, the tab width, the PETSCII glyphs; the BASIC
//               and assembler properties of each platform (platformprefs.js: the longest BASIC line)
//   Colours     the colour, bold and italic of each kind of token (directives, mnemonics, strings ...)
//   Toolchains  compiler › packer › emulator: what Build and Run do with the program (toolchain.js);
//               a project picks one in its settings
//   Tools       where the server finds VICE, KickAssembler, Java, the packers and the other emulators, and
//               which emulator runs a platform (backend/settings_api.go, ~/.nerdsuite/settings.json)
// The editor settings are kept in this browser and take effect at once, as CSS variables on the root
// (nerdsuite.css: --code-*, --syn-*); the tools are saved on the server when a field is left.
// The search field finds a setting by its name, its group or its hint, in every category.

import { h, useState, useEffect, useMemo, signal, icon, iconButton, button, field, select, slider, dialog, snackbar, openMenu } from './pui.js';
import { spans, measureCodeFont } from './codeeditor.js';
import { COMPILERS, PACKERS, EMULATORS, emulatorRuns, chainLabel, setServerSettings } from './toolchain.js';
import { PLATFORMS, platformOf } from './platforms.js';
import { platformPref, isPlatformPrefSet, setPlatformPref, resetPlatformPrefs } from './platformprefs.js';
import { DIALECTS } from './basic/dialects.js';
import { tokenBased } from './basic/typed.js';

const KEY = 'ns-editor-settings';

// --- the editor settings ---------------------------------------------------------------------------

export const FONTS = [
  { value: '"Geist Mono"', label: 'Geist Mono' },
  { value: '"C64 Pro Mono"', label: 'C64 Pro Mono (the C64 font)' },
  { value: '"Cascadia Mono", "Cascadia Code"', label: 'Cascadia Mono' },
  { value: 'Consolas', label: 'Consolas' },
  { value: '"JetBrains Mono"', label: 'JetBrains Mono' },
  { value: '"Fira Code", "Fira Mono"', label: 'Fira Code' },
  { value: '"Source Code Pro"', label: 'Source Code Pro' },
  { value: '"Courier New"', label: 'Courier New' },
  { value: 'ui-monospace', label: 'the system\'s monospace font' },
];
const DEFAULTS = { font: '"Geist Mono"', size: 12.5, line: 1.44, tab: 8, petscii: 1.15 };

// the kinds of tokens: the key of their CSS variables (nerdsuite.css), what they are, a sample
export const ROLES = [
  { key: 'flow', label: 'Directives and pseudo-ops', hint: 'ACME !byte !macro !if, KickAssembler .byte #import, BASIC GOTO GOSUB IF, {control codes}' },
  { key: 'kw', label: 'Mnemonics and keywords', hint: 'lda sta jsr, BASIC print poke' },
  { key: 'name', label: 'Labels', hint: 'definitions of labels' },
  { key: 'event', label: 'Macro calls', hint: '+macro, function calls' },
  { key: 'num', label: 'Numbers', hint: '$d020 %1010 42' },
  { key: 'str', label: 'Strings', hint: '"text"' },
  { key: 'comment', label: 'Comments', hint: '; comment, // comment, REM' },
  { key: 'sym', label: 'Symbols', hint: 'names used in expressions, variables' },
  { key: 'bracket', label: 'Brackets and operators', hint: '( ) [ ] { } #' },
  { key: 'lineno', label: 'BASIC line numbers', hint: '10 20 30' },
];
// the colours without a style of their own
const PLAIN = [
  { key: 'text', label: 'Plain text', hint: 'everything else' },
  { key: 'bg', label: 'Background', hint: 'the area of the code' },
  { key: 'caret', label: 'Caret', hint: 'the text cursor' },
];

function load() {
  try { return { ...DEFAULTS, syntax: {}, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return { ...DEFAULTS, syntax: {} }; }
}
export const editorSettings = signal(load());

// the settings as CSS variables on the root: nothing set - the default of the stylesheet
function apply(s) {
  const st = document.documentElement.style;
  const set = (name, v) => (v == null || v === '' ? st.removeProperty(name) : st.setProperty(name, String(v)));
  set('--code-font', s.font !== DEFAULTS.font ? s.font : null);
  set('--code-size', s.size !== DEFAULTS.size ? `${s.size}px` : null);
  set('--code-line-base', s.size !== DEFAULTS.size || s.line !== DEFAULTS.line ? `${Math.round(s.size * s.line * 100) / 100}px` : null);
  set('--code-tab', s.tab !== DEFAULTS.tab ? s.tab : null);
  set('--code-petscii', s.petscii !== DEFAULTS.petscii ? s.petscii : null);
  for (const r of [...ROLES, ...PLAIN]) {
    const v = s.syntax?.[r.key] ?? {};
    set(`--syn-${r.key}`, v.color);
    set(`--syn-${r.key}-weight`, v.bold == null ? null : v.bold ? 700 : 400);
    set(`--syn-${r.key}-style`, v.italic == null ? null : v.italic ? 'italic' : 'normal');
  }
}
if (typeof document !== 'undefined') apply(editorSettings.value);

function save(next) {
  const fontChanged = next.font !== editorSettings.value.font;
  editorSettings.value = next;
  apply(next);
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ }
  if (fontChanged) measureCodeFont();            // the PETSCII glyphs one column of the new font
}
const setEditor = patch => save({ ...editorSettings.value, ...patch });
const setRole = (key, patch) => {
  const syntax = { ...editorSettings.value.syntax, [key]: { ...editorSettings.value.syntax?.[key], ...patch } };
  for (const k of Object.keys(syntax[key])) if (syntax[key][k] == null) delete syntax[key][k];
  if (!Object.keys(syntax[key]).length) delete syntax[key];
  setEditor({ syntax });
};

// the colour a token has without a setting, as #rrggbb (the colour input needs one)
function defaultColor(key) {
  const host = document.createElement('div');
  host.className = 'ns-code code-view';
  host.style.cssText = `position:absolute;visibility:hidden;--syn-${key}:initial`;
  const pre = document.createElement('pre');
  pre.className = 'code-highlight';
  const span = document.createElement('span');
  if (ROLES.some(r => r.key === key)) span.className = `tok-${key}`;     // text, bg, caret: the area itself
  pre.append(span);
  host.append(pre);
  document.body.append(host);
  if (key === 'caret') host.style.setProperty('--syn-text', 'initial');   // the caret has the colour of the text
  const cs = key === 'bg' ? getComputedStyle(host).backgroundColor : getComputedStyle(span).color;
  host.remove();
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(cs);
  if (!m || m[4] === '0') return '#ffffff';
  return '#' + [m[1], m[2], m[3]].map(x => Number(x).toString(16).padStart(2, '0')).join('');
}

// --- the tools of the server ---------------------------------------------------------------------------

async function api(method, data) {
  const res = await fetch('api/settings/tools', { method, body: data && JSON.stringify(data), headers: data ? { 'Content-Type': 'application/json' } : {} });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${res.status} ${res.statusText}`);
  return json;
}
const PLATFORM_NAMES = { atari: 'Atari 8-bit', cpc: 'Amstrad / Schneider CPC', vcs: 'Atari 2600 (VCS)', nes: 'NES', snes: 'SNES', zx81: 'Sinclair ZX81', trs80: 'TRS-80', bbc: 'BBC Micro' };
// a path set that the program found does not come from: the default or the PATH stood in
const strayed = t => t.value && t.found && !t.found.toLowerCase().replace(/\\/g, '/').startsWith(t.value.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, ''));

// --- the dialog --------------------------------------------------------------------------------------------

// Enter in a field takes what is typed (the field is left: its change); the dialog stays (data-keep-enter)
const enterCommits = e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } };

const SECTIONS = [
  { id: 'editor', label: 'Editor', icon: 'code' },
  { id: 'colors', label: 'Colours', icon: 'brush' },
  { id: 'chains', label: 'Toolchains', icon: 'link' },
  { id: 'tools', label: 'Assemblers and emulators', icon: 'handyman' },
];

// --- the toolchains ----------------------------------------------------------------------------------------

// the ones a new toolchain can start from
const c64 = (name, compiler, packer, extra = {}) => ({ name, machine: 'c64', compiler, packer, emulator: { kind: 'auto', command: '' }, ...extra });
const PRESETS = [
  { label: 'Empty: the compiler of the project', make: () => ({ name: 'New toolchain', machine: '', compiler: { kind: 'project', command: '' }, packer: { kind: 'none', command: '', args: '' }, emulator: { kind: 'auto', command: '' } }) },
  { label: 'ACME › Exomizer › VICE (C64)', make: () => c64('ACME packed', { kind: 'acme', command: '' }, { kind: 'exomizer', command: '', args: '' }) },
  { label: 'KickAssembler › Exomizer › VICE (C64)', make: () => c64('KickAssembler packed', { kind: 'kickass', command: '' }, { kind: 'exomizer', command: '', args: '' }) },
  { label: '64tass › VICE (C64)', make: () => c64('64tass', { kind: 'command', command: '64tass --cbm-prg -o {out} {main}' }, { kind: 'none', command: '', args: '' }) },
  { label: 'cc65 (C) › VICE (C64)', make: () => c64('cc65', { kind: 'command', command: 'cl65 -t c64 -o {out} {main}' }, { kind: 'none', command: '', args: '' }) },
  { label: 'oscar64 (C) › Exomizer › VICE (C64)', make: () => c64('oscar64', { kind: 'command', command: 'oscar64 -tm=c64 -o={out} {main}' }, { kind: 'exomizer', command: '', args: '' }) },
];
const newId = list => { let i = list.length + 1; while (list.some(t => t.id === `tc${i}`)) i++; return `tc${i}`; };

// the placeholders of each command
const PLACES = {
  compiler: '{main} the source, {out} the program to write, {dir} the folder of the project, {name}, {platform}',
  packer: '{in} the program, {out} the packed one, {exec} where it starts (0x0810, sys or basic), {name}, {platform}',
  emulator: '{file} the program, {name}, {platform}',
};

// one toolchain: its name and machine, then compiler › packer › emulator and the commands they need
function Chain({ tc, tools, change, remove }) {
  const p = platformOf(tc.machine || 'c64');
  const step = (key, patch) => change({ ...tc, [key]: { ...tc[key], ...patch } });
  const found = key => tools?.tools?.find(t => t.key === key);
  const packers = PACKERS.filter(x => !tc.machine || !x.machines || x.machines.includes(tc.machine)).map(x => {
    const t = found(x.id.toUpperCase());
    return { value: x.id, label: `${x.name}${t && !t.available ? ' (not found)' : ''}` };
  });
  const emulators = EMULATORS.filter(x => !tc.machine || emulatorRuns(x.id, p)).map(x => ({ value: x.id, label: x.id === 'auto' && tc.machine ? `${x.name}: ${chainLabel(null, p).split(' › ').pop()}` : x.name }));
  const command = (key, placeholder) => field({ label: `The command of the ${key}`, dense: true, mono: true, value: tc[key].command, placeholder,
    onchange: v => step(key, { command: v }), onkeydown: enterCommits, support: PLACES[key] });
  return h('div', { class: 'ns-chain' },
    h('div', { class: 'ns-chain__head' },
      field({ label: 'Name', dense: true, value: tc.name, onchange: v => v.trim() && change({ ...tc, name: v.trim() }), onkeydown: enterCommits }),
      select({ label: 'Machine', dense: true, value: tc.machine, options: [{ value: '', label: 'every machine' }, ...PLATFORMS.map(x => ({ value: x.id, label: x.name }))],
        onchange: v => change({ ...tc, machine: v }) }),
      iconButton('delete', 'Remove the toolchain', remove)),
    h('div', { class: 'ns-chain__steps' },
      select({ label: 'Compiler', dense: true, value: tc.compiler.kind, options: COMPILERS.map(x => ({ value: x.id, label: x.name })), onchange: v => step('compiler', { kind: v }) }),
      icon('chevron_right'),
      select({ label: 'Packer', dense: true, value: tc.packer.kind, options: packers, onchange: v => step('packer', { kind: v }) }),
      icon('chevron_right'),
      select({ label: 'Emulator', dense: true, value: tc.emulator.kind, options: emulators, onchange: v => step('emulator', { kind: v }) })),
    tc.compiler.kind === 'command' && command('compiler', '64tass --cbm-prg -o {out} {main}'),
    tc.packer.kind === 'command' && command('packer', 'exomizer sfx {exec} -t64 -o {out} {in}'),
    !['none', 'command'].includes(tc.packer.kind) && field({ label: `Options of ${PACKERS.find(x => x.id === tc.packer.kind)?.name ?? 'the packer'}`, dense: true, mono: true, value: tc.packer.args ?? '',
      placeholder: tc.packer.kind === 'exomizer' ? '-n  (no effect while it unpacks)' : 'more options', onchange: v => step('packer', { args: v }), onkeydown: enterCommits }),
    tc.emulator.kind === 'command' && command('emulator', 'x64sc -autostart {file}'));
}

// the sample of the colours: [class, text] lines
const SAMPLE = [
  [['tok-comment', '; the border flashes']],
  [['tok-flow', '!to'], [null, ' '], ['tok-str', '"flash.prg"'], [null, ', '], ['tok-sym', 'cbm']],
  [['tok-flow', '*'], [null, ' = '], ['tok-num', '$0801']],
  [['tok-name', 'loop'], [null, '    '], ['tok-kw', 'inc'], [null, ' '], ['tok-num', '$d020'], [null, '      '], ['tok-comment', '; the border']],
  [[null, '        '], ['tok-kw', 'lda'], [null, ' '], ['tok-op', '#'], ['tok-bracket', '('], ['tok-sym', 'delay'], [null, ' + '], ['tok-num', '1'], ['tok-bracket', ')']],
  [[null, '        '], ['tok-event', '+wait'], [null, ' '], ['tok-num', '10'], [null, '          '], ['tok-flow', '!byte'], [null, ' '], ['tok-num', '%1010']],
  [['tok-lineno', '10'], [null, ' '], ['tok-kw', 'print'], ['tok-str', '"hello"'], [null, ':'], ['tok-flow', 'goto'], [null, ' '], ['tok-num', '10']],
];

function Settings() {
  const [section, setSection] = useState('editor');
  const [query, setQuery] = useState('');
  const [tools, setTools] = useState(null);       // the answer of the server, or { error }
  const [, redraw] = useState(0);
  const [prefsVersion, bump] = useState(0);       // a property of a platform changed (platformprefs.js)
  useEffect(() => editorSettings.subscribe(() => redraw(n => n + 1)), []);    // a change: drawn again
  const s = editorSettings.value;
  useEffect(() => { api('GET').then(setTools, e => setTools({ error: e.message })); }, []);
  // whether the Ultimate 64 answers: { reachable, version, error } (backend/ultimate)
  const [u64, setU64] = useState(null);
  const askUltimate = () => { setU64({ asking: true }); fetch('api/ultimate/status').then(r => r.json()).then(setU64, e => setU64({ error: e.message })); };
  useEffect(askUltimate, []);

  const saveTools = async data => {
    try {
      const next = await api('PUT', data);
      setTools(next);
      setServerSettings(next);       // the project settings and the tips of Run know them at once
      if (data.ultimate) askUltimate();
    } catch (e) { snackbar(`The settings were not saved: ${e.message}`, { error: true }); }
  };
  const chains = tools?.toolchains ?? [];
  const saveChains = list => saveTools({ toolchains: list });
  const addChain = anchor => openMenu(anchor, PRESETS.map(x => ({ label: x.label, icon: 'add', onclick: () => {
    setQuery('');
    setSection('chains');
    saveChains([...chains, { id: newId(chains), ...x.make() }]);
  } })));

  // every setting: { section, group, label, hint, control }
  const entries = useMemo(() => {
    const out = [];
    const add = (sec, group, label, hint, control, extra = '', cls = '') => out.push({ section: sec, group, label, hint, control, cls, words: `${group} ${label} ${hint} ${extra}`.toLowerCase() });
    // the editor
    add('editor', 'Font', 'Font of the code', 'the font of the code editor; a font that is not installed falls back to the next one',
      h('div', { class: 'ns-set__ctl ns-set__ctl--wide' },
        select({ label: 'Font', hideLabel: true, dense: true, value: FONTS.some(f => f.value === s.font) ? s.font : 'other',
          options: [...FONTS, { value: 'other', label: 'Another font …' }],
          onchange: v => setEditor({ font: v === 'other' ? (s.font && !FONTS.some(f => f.value === s.font) ? s.font : '"Lucida Console"') : v }) }),
        !FONTS.some(f => f.value === s.font) && field({ label: 'Font family (CSS)', dense: true, value: s.font, onchange: v => v.trim() && setEditor({ font: v.trim() }), onkeydown: enterCommits })),
      'family typeface monospace');
    add('editor', 'Font', 'Font size', 'in pixels at 100 % zoom (Ctrl+wheel zooms the code)',
      h('div', { class: 'ns-set__ctl' }, slider({ min: 8, max: 28, step: 0.5, value: s.size, format: v => `${v} px`, oninput: v => setEditor({ size: v }) })), 'size pixels');
    add('editor', 'Font', 'Line spacing', 'the height of a line in units of the font size',
      h('div', { class: 'ns-set__ctl' }, slider({ min: 1, max: 2.2, step: 0.02, value: s.line, format: v => `${v.toFixed(2)} ×`, oninput: v => setEditor({ line: v }) })), 'line height rows');
    add('editor', 'Text', 'Tab width', 'the columns of a tab character',
      h('div', { class: 'ns-set__ctl' }, select({ label: 'Tab width', hideLabel: true, dense: true, value: String(s.tab), options: ['2', '4', '8'], onchange: v => setEditor({ tab: Number(v) }) })), 'indent tabulator');
    add('editor', 'Text', 'PETSCII glyphs in BASIC strings', 'their size in a column of the code: above 1 the glyphs grow into each other',
      h('div', { class: 'ns-set__ctl' }, slider({ min: 0.8, max: 1.5, step: 0.05, value: s.petscii, format: v => `${v.toFixed(2)} ×`, oninput: v => setEditor({ petscii: v }) })), 'commodore c64 characters scale');
    // the properties of the BASIC and the assembler of each platform (platformprefs.js)
    for (const p of PLATFORMS.filter(x => x.basic.length)) {
      const own = isPlatformPrefSet(p.id, 'basicLine');
      add('editor', 'BASIC and assembler per platform', p.name, p.basic.map(d => DIALECTS[d]?.name ?? d).join(', '),
        h('div', { class: 'ns-set__ctl ns-set__ctl--wide' },
          field({ label: 'Max. BASIC line length', dense: true, type: 'number', value: own ? String(platformPref(p.id, 'basicLine')) : '',
            placeholder: p.basicLine ? `${p.basicLine} (the ${p.short})` : 'no limit',
            // a BASIC of tokens is typed with its keywords abbreviated, one of text as written (basic/typed.js)
            support: tokenBased(p.basic[0]) ? 'keys, with the keywords abbreviated (pO for POKE) · 0: no limit' : 'characters, as written · 0: no limit',
            onchange: v => {
              const n = v.trim() === '' ? null : Math.max(0, Math.min(9999, Math.round(Number(v))));
              setPlatformPref(p.id, 'basicLine', n == null || Number.isNaN(n) || n === p.basicLine ? null : n);
              bump(x => x + 1);
            }, onkeydown: enterCommits,
            trailing: own && iconButton('undo', `The default of the ${p.short}`, () => { setPlatformPref(p.id, 'basicLine', null); bump(x => x + 1); }) })),
        `${p.id} ${p.short} ${p.basic.join(' ')} basic line length max maximum characters columns platform machine`);
    }
    // the colours
    for (const r of [...ROLES, ...PLAIN]) {
      const v = s.syntax?.[r.key] ?? {};
      const styled = ROLES.includes(r);
      add('colors', styled ? 'Tokens' : 'Editor', r.label, r.hint, h('div', { class: 'ns-set__ctl ns-set__color' },
        h('input', { type: 'color', class: 'ns-set__swatch', value: v.color ?? defaultColor(r.key), 'aria-label': `${r.label}: colour`,
          oninput: e => setRole(r.key, { color: e.target.value }) }),
        styled && h('button', { type: 'button', class: `ns-set__style ${v.bold ? 'ns-set__style--on' : ''}`, 'aria-pressed': String(!!v.bold), 'data-tip': 'Bold',
          onclick: () => setRole(r.key, { bold: v.bold ? undefined : true }) }, h('b', {}, 'B')),
        styled && h('button', { type: 'button', class: `ns-set__style ${v.italic ? 'ns-set__style--on' : ''}`, 'aria-pressed': String(!!v.italic), 'data-tip': 'Italic',
          onclick: () => setRole(r.key, { italic: v.italic ? undefined : true }) }, h('i', {}, 'I')),
        iconButton('undo', 'The colour of the theme', () => setRole(r.key, { color: undefined, bold: undefined, italic: undefined }), Object.keys(v).length ? '' : 'ns-set__hidden')),
      'colour color syntax highlighting');
    }
    // the toolchains
    if (tools && !tools.error) {
      for (const tc of chains) {
        const p = platformOf(tc.machine || 'c64');
        add('chains', 'Toolchains', tc.name, `${chainLabel(tc, p)}${tc.machine ? ` · ${p.name}` : ' · every machine'}`,
          h(Chain, { tc, tools, change: next => saveChains(chains.map(t => (t.id === tc.id ? next : t))), remove: () => saveChains(chains.filter(t => t.id !== tc.id)) }),
          `toolchain chain compiler packer emulator ${tc.compiler.kind} ${tc.packer.kind} ${tc.emulator.kind} ${tc.compiler.command} ${tc.packer.command} ${tc.emulator.command} ${p.name}`, 'ns-set__row--block');
      }
    }
    // the tools
    if (tools && !tools.error) {
      for (const t of tools.tools) {
        const status = t.available ? (strayed(t) ? `not found there - ${t.found} is used` : t.found) : 'not found';
        add('tools', t.group, t.label, t.hint, h('div', { class: 'ns-set__ctl ns-set__ctl--wide' },
          field({ label: 'Path', dense: true, mono: true, value: t.value, placeholder: t.env ? `${t.env} (from the environment variable ${t.key})` : `the default, or the environment variable ${t.key}`,
            onchange: v => saveTools({ paths: { [t.key]: v } }), onkeydown: enterCommits,
            support: h('span', { class: `ns-set__found ${t.available && !strayed(t) ? 'ns-set__found--ok' : 'ns-set__found--bad'}` }, icon(t.available && !strayed(t) ? 'task_alt' : 'warning'), status) })),
        `${t.key} path program executable`);
      }
      // the Ultimate 64 on the network: its address and its password (Run on the Ultimate, Shift+F5)
      const u = tools.ultimate ?? { host: '' };
      const reach = !u64 || u64.asking ? h('span', { class: 'ns-set__found' }, 'asking the device …')
        : !u64.configured ? h('span', { class: 'ns-set__found' }, 'not set up')
          : h('span', { class: `ns-set__found ${u64.reachable ? 'ns-set__found--ok' : 'ns-set__found--bad'}` }, icon(u64.reachable ? 'task_alt' : 'warning'),
            u64.reachable ? `answers${u64.version ? ` - REST API ${u64.version}` : ''}` : u64.error ?? 'no answer');
      add('tools', 'Ultimate 64', 'Address', 'the name or the IP of the Ultimate 64 or the Ultimate-II+ on the network: Run on the Ultimate (Shift+F5) sends the program there (its REST API, firmware 3.11 or later)',
        h('div', { class: 'ns-set__ctl ns-set__ctl--wide' },
          field({ label: 'Address', dense: true, mono: true, value: u.host, placeholder: u.env ? `${u.env} (from the environment variable ULTIMATE)` : '192.168.1.64',
            onchange: v => saveTools({ ultimate: { host: v } }), onkeydown: enterCommits, support: reach,
            trailing: iconButton('refresh', 'Ask the device again', askUltimate) })),
        'ultimate u64 ultimate-ii real c64 hardware network ip host');
      add('tools', 'Ultimate 64', 'Password', 'the network password of the device, when it has one (kept on the server, not shown again)',
        h('div', { class: 'ns-set__ctl ns-set__ctl--wide' },
          field({ label: 'Password', dense: true, type: 'password', value: '', placeholder: u.password ? '•••••• set - type a new one' : 'none',
            onchange: v => saveTools({ ultimate: { host: u.host, password: v } }), onkeydown: enterCommits,
            trailing: u.password && iconButton('close', 'Remove the password', () => saveTools({ ultimate: { host: u.host, password: '' } })) })),
        'ultimate u64 password network');
      for (const p of tools.platforms) {
        add('tools', 'Emulator per platform', PLATFORM_NAMES[p.id] ?? p.id, 'the emulator Run starts; the first one found when none is chosen',
          h('div', { class: 'ns-set__ctl' }, select({ label: 'Emulator', hideLabel: true, dense: true, value: p.preferred,
            options: [{ value: '', label: 'the first one found' }, ...p.emulators.map(id => {
              const t = tools.tools.find(x => x.label.toLowerCase() === id);
              return { value: id, label: `${t?.label ?? id}${t && !t.available ? ' (not found)' : ''}` };
            })],
            onchange: v => saveTools({ preferred: { [p.id]: v } }) })), `${p.id} run emulator preferred`);
      }
    }
    return out;
  }, [s, tools, query, section, u64, prefsVersion]);

  const q = query.trim().toLowerCase();
  const shown = q ? entries.filter(e => q.split(/\s+/).every(w => e.words.includes(w))) : entries.filter(e => e.section === section);
  const groups = [];
  for (const e of shown) {
    const name = q ? `${SECTIONS.find(x => x.id === e.section).label} · ${e.group}` : e.group;
    (groups.find(g => g.name === name) ?? (groups.push({ name, list: [] }), groups.at(-1))).list.push(e);
  }
  const sample = (q ? shown.some(e => e.section === 'colors') : section === 'colors') || (!q && section === 'editor');

  return h('div', { class: 'ns-set', 'data-keep-enter': '' },
    h('div', { class: 'ns-set__search' }, field({ label: 'Search the settings', dense: true, value: query, oninput: v => setQuery(v),
      trailing: query && iconButton('close', 'Clear', () => setQuery('')) })),
    h('div', { class: 'ns-set__body' },
      h('nav', { class: 'ns-set__nav' }, SECTIONS.map(x => h('button', {
        type: 'button', class: `ns-set__navitem ${!q && x.id === section ? 'ns-set__navitem--on' : ''}`,
        onclick: () => { setQuery(''); setSection(x.id); },
      }, icon(x.icon), h('span', {}, x.label), q ? h('span', { class: 'ns-set__count' }, shown.filter(e => e.section === x.id).length) : ''))),
      h('div', { class: 'ns-set__list' },
        sample && h('div', { class: 'ns-code code-view ns-set__sample', 'aria-hidden': 'true' },
          h('pre', { class: 'code-highlight ns-set__sample-pre', 'data-i18n': 'off' }, SAMPLE.map(line => [...spans(line.map(([cls, text]) => ({ cls, text }))), '\n']))),
        !q && section === 'chains' && h('div', { class: 'section__hint ns-set__chains-hint' },
          h('span', {}, 'What Build and Run do with the program: it is compiled, packed and started. The project settings choose the toolchain of a project; the commands run on the server.'),
          button('Add a toolchain', { icon: 'add', variant: 'tonal', onclick: e => addChain(e.currentTarget) })),
        !q && section === 'chains' && tools && !tools.error && !chains.length && h('div', { class: 'section__hint' }, 'No toolchain yet: a project builds with its own compiler and runs in the emulator of its machine.'),
        !q && section === 'tools' && (!tools ? h('div', { class: 'section__hint' }, 'Asking the server …')
          : tools.error ? h('div', { class: 'section__hint' }, `The server did not answer: ${tools.error}`)
            : h('div', { class: 'section__hint' }, 'Kept on the server in ', h('code', { 'data-i18n': 'off' }, tools.file), '. A path set here comes before the environment variable; an empty field uses the variable or the default.')),
        !groups.length && h('div', { class: 'section__hint' }, q ? `No setting matches “${query}”` : ''),
        groups.map(g => h('section', { class: 'ns-set__group' },
          h('h3', { class: 'ns-set__group-title' }, g.name),
          g.list.map(e => h('div', { class: `ns-set__row ${e.cls}` },
            h('div', { class: 'ns-set__text' }, h('div', { class: 'ns-set__label' }, e.label), h('div', { class: 'ns-set__hint' }, e.hint)),
            e.control)))),
        !q && (section === 'editor' || section === 'colors') && h('div', { class: 'ns-set__reset' },
          button(section === 'colors' ? 'All colours as the theme has them' : 'The editor as it was', { icon: 'undo',
            onclick: () => { if (section === 'colors') setEditor({ syntax: {} }); else { resetPlatformPrefs(); bump(x => x + 1); setEditor({ ...DEFAULTS }); } } })))));
}

let open = null;
export function openSettings() {
  if (open) return;
  open = dialog({ title: 'Settings', wide: true, content: h(Settings), actions: [{ label: 'Close', value: null, variant: 'filled' }], onclose: () => { open = null; } });
}
