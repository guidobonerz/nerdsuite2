// nswizard.js - the project wizard of nerdsuite, in the manner of yopaca's story wizard: a dialog of
// steps - the machine, the project and its first programs, the graphics and the sound to start
// with, and what will be made. Create on any step makes the project of what is filled in so far.
//
// projectWizard() -> Promise<{ name, platform, files: Map path -> bytes, main } | null>

import { h, signal, dialog, field, select, checkbox, icon } from './pui.js';
import { FAMILIES, PLATFORMS, platformOf, platformKin, canDebug, cpuName, starterAsm, starterBasic, starterKick } from './platforms.js';
import { includeSource, hasMemoryMap } from './memmap.js';
import { DIALECTS } from './basic/dialects.js';
import { CHARGEN } from './chargen.js';
import { encodeScreen, costumeToFile, sprPath } from './gfxfile.js';
import { assetsText } from './assets.js';
import { videoOf, startColors, ATARI_REGS } from './video.js';
import { atariFont } from './atarifont.js';
import { encodeAtariPicture } from './ataribitmap.js';
import { encodeTbm } from './tedbitmap.js';
import { newSong, encode as encodeSong } from './song.js';
import { KOALA_SIZE } from './picture.js';

const enc = s => new TextEncoder().encode(s);
const hex = n => '$' + n.toString(16).padStart(4, '0');

// a sprite to start with: a little figure, hires, 24 x 21
const HERO = [
  '..........XXXX..........', '.........XXXXXX.........', '.........X.XX.X.........', '.........XXXXXX.........',
  '..........X..X..........', '...........XX...........', '........XXXXXXXX........', '.......XXXXXXXXXX.......',
  '......XX.XXXXXX.XX......', '......XX.XXXXXX.XX......', '......XX.XXXXXX.XX......', '.........XXXXXX.........',
  '.........XX..XX.........', '.........XX..XX.........', '.........XX..XX.........', '........XXX..XXX........',
  '........................', '........................', '........................', '........................', '........................',
];

// whether the wizard makes an asset for a machine: the Commodore machines (the editors make VIC-II data), and
// only for an editor the machine has (video.js: no sprite on a VIC-20, no charset on a PET)
const ASSET_EDITOR = { charset: 'chars', screen: 'screen', sprite: 'sprites', bitmap: 'bitmap' };
// the Atari 800 XL: a screen, a font and a picture (its players come with their part of stage 3)
const assetMade = (p, asset) => (!!p.commodore || (platformKin(p.id) === 'atari8' && ['charset', 'screen', 'bitmap'].includes(asset)))
  && (!ASSET_EDITOR[asset] || !!videoOf(p.id).editors[ASSET_EDITOR[asset]]);

// the graphics model and the files of the assets chosen (Commodore machines: the editors make VIC-II data)
function assetFiles(plan, files) {
  // assets.json (assets.js): the charset and the sprites, their art in gfx/sprite
  const items = [{ kind: 'charset', value: 'upper' }];
  const v = videoOf(plan.platform), atari = v.cells === 'atari';
  // the charset: a copy of the ROM font - the Atari's in the order of its codes (atarifont.js), 1024 bytes
  const fontFile = atari ? 'gfx/charset/font.fnt' : 'gfx/charset/font.chr';
  if (plan.assets.charset) files.set(fontFile, atari ? atariFont().slice() : CHARGEN.slice(0, 2048));
  if (plan.assets.screen) {
    // the title screen, gfx/screen/title.scr: the screen of the machine (40 x 25, the VIC-20's 22 x 23) in the
    // colours it starts with - its look in the file (gfxfile.js), the name of the project in the middle
    const { cols: w, rows: hgt } = v.screen, sc = startColors(v.cells);
    const chars = new Uint8Array(w * hgt).fill(0x20), colors = new Uint8Array(w * hgt).fill(sc.text);
    const title = `${plan.name.toUpperCase()}`.slice(0, w - 2);
    // the letters as screen codes - the Atari's: ASCII 32-95 are its codes 0-63, a space is 0
    if (atari) chars.fill(0);
    [...title].forEach((c, k) => { const code = c.charCodeAt(0); chars[Math.floor(hgt / 2) * w + Math.floor((w - title.length) / 2) + k] = atari ? (code - 32) & 0x3f : code >= 64 && code < 96 ? code - 64 : code & 0x3f; });
    const look = { bg: sc.bg, border: sc.border, text: sc.text, multicolor: null, ecm: null, charset: plan.assets.charset ? fontFile : null, tiles: null, patches: [],
      registers: atari ? ATARI_REGS : null };
    files.set('gfx/screen/title.scr', encodeScreen({ screen: { w, h: hgt, chars, colors }, patches: new Map(), look }));
  }
  if (plan.assets.sprite) {
    const hero = { kind: 'costume', name: 'hero', file: sprPath('hero'), anims: [] };
    files.set(hero.file, costumeToFile({ ...hero, frames: [{ name: 'stand', default: true, lines: HERO }], layers: [] }, {}));
    items.push(hero);
  }
  if (plan.assets.song) files.set('audio/music/song.sng', encodeSong(newSong()));
  if (plan.assets.bitmap && v.bitmap === 'atari') {
    // the Atari: GRAPHICS 15 in the colours the OS starts with (ataribitmap.js)
    files.set('gfx/bitmap/picture.mic', encodeAtariPicture({ mc: true, rows: Array.from({ length: 192 }, () => new Uint8Array(160)), regs: ATARI_REGS }));
  } else if (plan.assets.bitmap && v.bitmap === 'ted') {
    // the TED: a multicolor picture of its own (tedbitmap.js)
    files.set('gfx/bitmap/picture.tbm', encodeTbm({ mc: true, bitmap: new Uint8Array(8000), cells: Array.from({ length: 1000 }, () => [0x71, 0x32]), bg: 0, bg2: 0x46 }));
  } else if (plan.assets.bitmap) {
    const kla = new Uint8Array(KOALA_SIZE);
    kla[0] = 0x00; kla[1] = 0x60;                          // the load address of a Koala picture: $6000
    files.set('gfx/bitmap/picture.kla', kla);
  }
  files.set('assets.json', enc(assetsText(items)));
}

// the files of the project the plan makes
export function projectFiles(plan) {
  const p = platformOf(plan.platform);
  const files = new Map();
  const dialect = plan.dialect && DIALECTS[plan.dialect] ? plan.dialect : p.basic[0];
  const asm = plan.asm ? `src/${plan.asmName}.asm` : null;
  const bas = plan.basic && dialect ? `src/${plan.basName}.bas` : null;
  const kick = plan.assembler === 'kickass' && p.family === 'commodore';
  if (asm) files.set(asm, enc(kick ? starterKick(p, plan.asmName) : starterAsm(p, plan.asmName)));
  if (bas) files.set(bas, enc(starterBasic(p, dialect)));
  // the addresses of the machine: chips, ROM routines, vectors, with the meanings of their bits
  if (asm && !kick && hasMemoryMap(p.id)) files.set('src/hardware.inc', enc(includeSource(p.id, p.name)));
  const main = plan.main === 'basic' ? bas ?? asm : asm ?? bas;
  assetFiles({ ...plan, assets: Object.fromEntries(Object.entries(plan.assets).filter(([k]) => assetMade(p, k))) }, files);
  files.set('nerdsuite.json', enc(JSON.stringify({ machine: p.id, main, dialects: bas ? { [bas]: dialect } : {}, cpu: p.cpu, assembler: kick ? 'kickass' : 'acme', assemblers: {} }, null, 2) + '\n'));
  return { files, main };
}

export function projectWizard() {
  const step = signal(0);
  const errors = signal([]);
  const plan = signal({
    name: 'myproject', family: 'commodore', platform: 'c64',
    asm: true, assembler: 'acme', asmName: 'main', basic: false, basName: 'hello', dialect: 'v2', main: 'asm',
    assets: { charset: false, screen: false, sprite: false, song: false, bitmap: false },   // none ticked: the editors make them when wanted
  });
  const set = change => { plan.value = { ...plan.value, ...change }; errors.value = []; };
  const p = () => platformOf(plan.value.platform);

  const steps = [
    { key: 'machine', label: 'Machine', icon: 'cpu' },
    { key: 'project', label: 'Project', icon: 'code' },
    { key: 'assets', label: 'Graphics and sound', icon: 'brush' },
    { key: 'summary', label: 'Summary', icon: 'check' },
  ];

  const check = () => {
    const v = plan.value, out = [];
    if (!/^[\w-]+$/.test(v.name)) out.push('Name: letters, digits, - and _');
    if (v.asm && !/^[\w-]+$/.test(v.asmName)) out.push('Assembler program: a name of letters, digits, - and _');
    if (v.basic && !/^[\w-]+$/.test(v.basName)) out.push('BASIC program: a name of letters, digits, - and _');
    if (v.asm && v.basic && v.asmName === v.basName) out.push('The two programs need names of their own');
    return out;
  };

  const views = {
    machine: () => {
      const v = plan.value;
      return [
        h('div', { class: 'md-label-large' }, 'Which machine is the program for?'),
        h('div', { class: 'ns-wiz-families' }, FAMILIES.map(f => h('button', { type: 'button', class: `ns-wiz-family ${v.family === f.id ? 'ns-wiz-family--on' : ''}`,
          onclick: () => { const first = PLATFORMS.find(x => x.family === f.id); set({ family: f.id, platform: first.id, dialect: first.basic[0] ?? null, basic: v.basic && !!first.basic.length }); } },
        h('span', { class: 'ns-wiz-family__name' }, f.name), h('span', { class: 'ns-wiz-family__desc' }, f.desc)))),
        h('div', { class: 'ns-wiz-platforms' }, PLATFORMS.filter(x => x.family === v.family).map(x => h('label', { class: `ns-wiz-platform ${v.platform === x.id ? 'ns-wiz-platform--on' : ''}` },
          h('input', { type: 'radio', name: 'ns-platform', checked: v.platform === x.id, onchange: () => set({ platform: x.id, dialect: x.basic[0] ?? null, basic: v.basic && !!x.basic.length }) }),
          h('span', { class: 'ns-wiz-platform__text' },
            h('span', { class: 'ns-wiz-platform__name' }, x.name),
            h('span', { class: 'ns-wiz-platform__desc', 'data-i18n': 'off' },
              `${cpuName(x.cpu)} · ${x.basic.length ? x.basic.map(d => DIALECTS[d]?.name ?? d).join(', ') : 'no BASIC'} · .${x.ext} · ${x.emulator.kind === 'vice' ? 'run and debug in mimic or VICE' : canDebug(x) ? `run and debug in mimic, run in ${{ atari: 'Altirra', vcs: 'Stella', cpc: 'WinAPE', amiga: 'WinUAE or FS-UAE', zx81: 'EightyOne or ZEsarUX' }[x.emulator.platform]}` : `run in ${{ atari: 'Altirra', vcs: 'Stella', cpc: 'WinAPE', nes: 'Mesen or FCEUX', snes: 'Mesen, bsnes or Snes9x', zx81: 'EightyOne or ZEsarUX', trs80: 'trs80gp or MAME', bbc: 'BeebEm, b2 or MAME', mega65: 'Xemu' }[x.emulator.platform] ?? 'its emulator'}`}`))))),
      ];
    },
    project: () => {
      const v = plan.value, x = p();
      return [
        field({ label: 'Name of the project', value: v.name, mono: true, oninput: t => set({ name: t.trim() }) }),
        h('div', { class: 'md-label-large' }, 'The programs to start with'),
        h('div', { class: 'ns-wiz-prog' },
          checkbox(`Assembler (${cpuName(x.cpu)})`, v.asm, on => set({ asm: on, main: on ? v.main : 'basic' })),
          v.asm && field({ label: 'File name (.asm)', value: v.asmName, mono: true, dense: true, oninput: t => set({ asmName: t.trim() }) }),
          v.asm && select({ label: 'Assembler', value: x.family === 'commodore' ? v.assembler : 'acme', dense: true,
            options: x.family === 'commodore' ? [{ value: 'acme', label: 'ACME' }, { value: 'kickass', label: 'KickAssembler (Java, on the server)' }] : [{ value: 'acme', label: 'ACME' }],
            onchange: a => set({ assembler: a }) })),
        x.basic.length ? h('div', { class: 'ns-wiz-prog' },
          checkbox('BASIC', v.basic, on => set({ basic: on, main: on && !v.asm ? 'basic' : v.main })),
          v.basic && field({ label: 'File name (.bas)', value: v.basName, mono: true, dense: true, oninput: t => set({ basName: t.trim() }) }),
          v.basic && select({ label: 'Dialect', value: v.dialect ?? x.basic[0], dense: true, options: x.basic.map(d => ({ value: d, label: DIALECTS[d]?.name ?? d })), onchange: d => set({ dialect: d }) }))
          : h('div', { class: 'section__hint' }, `The ${x.name} has no BASIC: its programs are written in assembler.`),
        v.asm && v.basic && h('div', { class: 'md-radio-group' }, h('div', { class: 'md-label-large' }, 'The main program (Build, Run, Debug)'),
          ['asm', 'basic'].map(k => h('label', { class: 'md-radio' }, h('input', { type: 'radio', name: 'ns-main', checked: v.main === k, onchange: () => set({ main: k }) }), k === 'asm' ? `${v.asmName}.asm` : `${v.basName}.bas`))),
        h('div', { class: 'section__hint' }, `A new assembler program starts at ${hex(x.start)}${x.basicStart ? ` with a BASIC line SYS ${x.start} at ${hex(x.basicStart)}, so RUN starts it` : ''}; the assembler writes .${x.ext} files (${x.format}).`),
      ];
    },
    assets: () => {
      const v = plan.value, x = p();
      const a = v.assets, toggle = (k, on) => set({ assets: { ...a, [k]: on } });
      return [
        x.commodore ? h('div', { class: 'section__hint' }, 'The graphics editors make the data of the VIC-II and the SID. What is ticked is made now; the editors make more at any time. A source includes it with !binary.')
          : h('div', { class: 'banner banner--info' }, icon('info'), h('span', {}, `The graphics editors and the composer make Commodore data (VIC-II, SID). For the ${x.name} they are drawing tools: the hex view and the exports give the bytes.`)),
        h('div', { class: 'ns-wiz-assets' },
          checkbox(`A charset: a copy of the ROM font (gfx/charset/font.${platformKin(x.id) === 'atari8' ? 'fnt' : 'chr'})`, !!a.charset && assetMade(x, 'charset'), on => toggle('charset', on), { disabled: !assetMade(x, 'charset') }),
          checkbox(`A title screen of ${videoOf(x.id).screen?.cols ?? 40} × ${videoOf(x.id).screen?.rows ?? 25} chars (gfx/screen/title.scr)`, !!a.screen && assetMade(x, 'screen'), on => toggle('screen', on), { disabled: !assetMade(x, 'screen') }),
          checkbox('A sprite of 24 × 21 pixels (the Sprites editor)', !!a.sprite && assetMade(x, 'sprite'), on => toggle('sprite', on), { disabled: !assetMade(x, 'sprite') }),
          checkbox('A song for the composer (audio/music/song.sng)', !!a.song && assetMade(x, 'song'), on => toggle('song', on), { disabled: !assetMade(x, 'song') }),
          checkbox(`A multicolor bitmap picture (gfx/bitmap/picture.${{ ted: 'tbm', atari: 'mic' }[videoOf(x.id).bitmap] ?? 'kla'})`, !!a.bitmap && assetMade(x, 'bitmap'), on => toggle('bitmap', on), { disabled: !assetMade(x, 'bitmap') })),
      ];
    },
    summary: () => {
      const { files, main } = projectFiles(plan.value);
      const x = p();
      return [
        h('div', { class: 'md-body-medium' }, `The project ${plan.value.name} for the ${x.name}:`),
        h('ul', { class: 'ns-wiz-files', 'data-i18n': 'off' }, [...files.keys()].sort().map(f => h('li', {}, h('code', {}, f), f === main ? ' · the main program' : f === 'assets.json' ? ' · the graphics model of the editors' : f === 'nerdsuite.json' ? ' · the settings' : ''))),
        h('div', { class: 'section__hint' }, 'Export (the download icon) saves the project as a .nsp package; until then it lives in this browser tab.'),
      ];
    },
  };

  const go = to => {
    const msgs = to > step.value ? check() : [];
    if (msgs.length) { errors.value = msgs; return false; }
    errors.value = [];
    step.value = to;
    return false;
  };

  const Wizard = () => h('div', { class: 'wizard ns-wizard' },
    h('div', { class: 'wizard__steps' }, steps.map((s, i) => h('button', {
      class: `wizard__step ${i === step.value ? 'wizard__step--active' : ''} ${i < step.value ? 'wizard__step--done' : ''}`, type: 'button',
      onclick: () => go(i) }, icon(s.icon), h('span', {}, s.label)))),
    h('div', { class: 'wizard__body' }, views[steps[step.value].key]()),
    errors.value.length ? h('div', { class: 'wizard__errors' }, errors.value.map(m => h('div', {}, m))) : '');

  return new Promise(resolve => {
    dialog({
      title: 'New project', wide: true, outside: false, content: h(Wizard, {}),
      actions: () => {
        const last = step.value === steps.length - 1;
        return [
          { label: 'Cancel', value: null },
          step.value > 0 && { label: 'Back', onclick: () => go(step.value - 1) },
          { label: 'Create', icon: 'check', variant: last ? 'filled' : 'outlined', onclick: () => {
            const msgs = check();
            if (msgs.length) { errors.value = msgs; return false; }
            const { files, main } = projectFiles(plan.value);
            resolve({ name: plan.value.name, platform: plan.value.platform, files, main });
            return true;
          } },
          !last && { label: 'Next', variant: 'filled', onclick: () => go(step.value + 1) },
        ];
      },
      onclose: v => { if (v == null) resolve(null); },
    });
  });
}
