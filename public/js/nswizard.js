// nswizard.js - the project wizard of nerdsuite, in the manner of yopaca's story wizard: a dialog of
// steps - the machine, the project and its first programs, the graphics and the sound to start
// with, and what will be made. Create on any step makes the project of what is filled in so far.
//
// projectWizard() -> Promise<{ name, platform, files: Map path -> bytes, main } | null>

import { h, signal, dialog, field, select, checkbox, icon } from './pui.js';
import { FAMILIES, PLATFORMS, platformOf, canDebug, starterAsm, starterBasic, starterKick } from './platforms.js';
import { includeSource, hasMemoryMap } from './memmap.js';
import { DIALECTS } from './basic/dialects.js';
import { CHARGEN } from './chargen.js';
import { encodeScreen } from './gfxfile.js';
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

// the graphics model and the files of the assets chosen (Commodore machines: the editors make VIC-II data)
function assetFiles(plan, files) {
  let model = `// assets.adv - the graphics of this nerdsuite project, kept by the IDE: the screens with their
// charsets, colors and layers, the sprites with their frames and animations. The art is in gfx/.
charset upper
`;
  if (plan.assets.charset) files.set('gfx/charset/font.chr', CHARGEN.slice(0, 2048));
  if (plan.assets.screen) {
    const w = 40, hgt = 25;
    const chars = new Uint8Array(w * hgt).fill(0x20), colors = new Uint8Array(w * hgt).fill(1);
    const title = `${plan.name.toUpperCase()}`.slice(0, 38);
    [...title].forEach((c, k) => { const code = c.charCodeAt(0); chars[12 * w + Math.floor((w - title.length) / 2) + k] = code >= 64 && code < 96 ? code - 64 : code & 0x3f; });
    files.set('gfx/screen/title.scr', encodeScreen({ screen: { w, h: hgt, chars, colors }, patches: new Map() }));
    model += `
place title {
    screen {
        bgcolor blue
        border lightblue
        textcolor white
${plan.assets.charset ? '        charset "gfx/charset/font.chr"\n' : ''}        gfx "gfx/screen/title.scr"
    }
}
`;
  }
  if (plan.assets.sprite) {
    model += `
costume hero {
    stand """
${HERO.join('\n')}
"""
}
`;
  }
  if (plan.assets.song) files.set('audio/music/song.sng', encodeSong(newSong()));
  if (plan.assets.bitmap) {
    const kla = new Uint8Array(KOALA_SIZE);
    kla[0] = 0x00; kla[1] = 0x60;                          // the load address of a Koala picture: $6000
    files.set('gfx/bitmap/picture.kla', kla);
  }
  files.set('assets.adv', enc(model));
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
  if (p.commodore) assetFiles(plan, files);
  else assetFiles({ ...plan, assets: {} }, files);
  files.set('nerdsuite.json', enc(JSON.stringify({ machine: p.id, main, dialects: bas ? { [bas]: dialect } : {}, cpu: p.cpu, assembler: kick ? 'kickass' : 'acme', assemblers: {} }, null, 2) + '\n'));
  return { files, main };
}

export function projectWizard() {
  const step = signal(0);
  const errors = signal([]);
  const plan = signal({
    name: 'myproject', family: 'commodore', platform: 'c64',
    asm: true, assembler: 'acme', asmName: 'main', basic: false, basName: 'hello', dialect: 'v2', main: 'asm',
    assets: { charset: true, screen: true, sprite: true, song: false, bitmap: false },
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
              `${x.cpu.toUpperCase()} · ${x.basic.length ? x.basic.map(d => DIALECTS[d]?.name ?? d).join(', ') : 'no BASIC'} · .${x.ext} · ${canDebug(x) ? 'run and debug in VICE' : `run in ${{ atari: 'Altirra', vcs: 'Stella', cpc: 'WinAPE', nes: 'Mesen or FCEUX', snes: 'Mesen, bsnes or Snes9x', zx81: 'EightyOne or ZEsarUX', trs80: 'trs80gp or MAME', bbc: 'BeebEm, b2 or MAME' }[x.emulator.platform] ?? 'its emulator'}`}`))))),
      ];
    },
    project: () => {
      const v = plan.value, x = p();
      return [
        field({ label: 'Name of the project', value: v.name, mono: true, oninput: t => set({ name: t.trim() }) }),
        h('div', { class: 'md-label-large' }, 'The programs to start with'),
        h('div', { class: 'ns-wiz-prog' },
          checkbox(`Assembler (${x.cpu.toUpperCase()})`, v.asm, on => set({ asm: on, main: on ? v.main : 'basic' })),
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
          checkbox('A charset: a copy of the ROM font (gfx/charset/font.chr)', !!a.charset && x.commodore, on => toggle('charset', on), { disabled: !x.commodore }),
          checkbox('A title screen of 40 × 25 chars (gfx/screen/title.scr)', !!a.screen && x.commodore, on => toggle('screen', on), { disabled: !x.commodore }),
          checkbox('A sprite of 24 × 21 pixels (the Sprites editor)', !!a.sprite && x.commodore, on => toggle('sprite', on), { disabled: !x.commodore }),
          checkbox('A song for the composer (audio/music/song.sng)', !!a.song && x.commodore, on => toggle('song', on), { disabled: !x.commodore }),
          checkbox('A multicolor bitmap picture (gfx/bitmap/picture.kla)', !!a.bitmap && x.commodore, on => toggle('bitmap', on), { disabled: !x.commodore })),
      ];
    },
    summary: () => {
      const { files, main } = projectFiles(plan.value);
      const x = p();
      return [
        h('div', { class: 'md-body-medium' }, `The project ${plan.value.name} for the ${x.name}:`),
        h('ul', { class: 'ns-wiz-files', 'data-i18n': 'off' }, [...files.keys()].sort().map(f => h('li', {}, h('code', {}, f), f === main ? ' · the main program' : f === 'assets.adv' ? ' · the graphics model of the editors' : f === 'nerdsuite.json' ? ' · the settings' : ''))),
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
