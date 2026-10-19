#!/usr/bin/env node
// handbook-shots.mjs - the screenshots of the handbook (public/handbook/img/*.webp): a headless Chrome on
// the DevTools port (CDP_PORT, 9355) goes through the IDE of a server (URL, http://localhost:3164) and
// takes them in order - the menu and the settings, the code view with the example project, the
// disassembler, the hex view, the debugger (with VICE: it starts and stops it).
//
//   chrome --headless=new --remote-debugging-port=9355 --user-data-dir=<a new folder> about:blank
//   NERDSUITE_SETTINGS=<an empty file> go run ./cmd/nerdsuite --root . --no-browser --port 3164
//   node tools/handbook-shots.mjs [name ...]      (names: only these shots; none: all)
//
// The server should have settings of its own (NERDSUITE_SETTINGS): the shots show its toolchains and paths.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'handbook', 'img');
const URL_ = process.env.URL || 'http://localhost:3164/';
const PORT = Number(process.env.CDP_PORT || 9355);
const W = 1440, H = 900;
const only = new Set(process.argv.slice(2));
mkdirSync(OUT, { recursive: true });

// --- the connection ----------------------------------------------------------------------------------

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true });
});
const send = (method, params = {}) => new Promise(r => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
  const ex = r.result?.exceptionDetails;
  if (ex) throw new Error(ex.exception?.description ?? JSON.stringify(ex));
  return r.result?.result?.value;
}
// in the page: $(sel), byText(text, sel), wait(ms)
const LIB = `const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const byText = (t, s = 'button') => $$(s).find(b => b.textContent.trim() === t || b.dataset.tip === t);
  const wait = ms => new Promise(r => setTimeout(r, ms));`;
const page = expr => ev(`${LIB}\n${expr}`);

async function open(url) {
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await sleep(3500);
}
async function mouse(type, x, y, extra = {}) { await send('Input.dispatchMouseEvent', { type, x, y, ...extra }); }
async function click(x, y, button = 'left', modifiers = 0) {
  await mouse('mouseMoved', x, y, { modifiers });
  await mouse('mousePressed', x, y, { button, clickCount: 1, modifiers });
  await mouse('mouseReleased', x, y, { button, clickCount: 1, modifiers });
  await sleep(300);
}
// the middle of an element (its rect from the page)
async function center(expr) {
  const r = await page(`const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, l: b.left, t: b.top, w: b.width, h: b.height };`);
  if (!r) throw new Error(`not found: ${expr}`);
  return r;
}
async function clickEl(expr, button = 'left') { const c = await center(expr); await click(c.x, c.y, button); return c; }
const KEYS = { Enter: 13, Escape: 27, Tab: 9, F5: 116, F6: 117, F8: 119, F10: 121, F11: 122, Backspace: 8, ArrowDown: 40, ArrowUp: 38, Shift: 16 };
async function key(k, mods = 0) {
  const vk = KEYS[k] ?? (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0);
  const code = k.length === 1 ? (/[a-z]/i.test(k) ? 'Key' + k.toUpperCase() : k === ',' ? 'Comma' : k === ' ' ? 'Space' : 'Digit' + k) : k === 'Shift' ? 'ShiftLeft' : k;
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
  if (k.length === 1 && !(mods & 2)) await send('Input.dispatchKeyEvent', { type: 'char', key: k, text: k, modifiers: mods });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await sleep(250);
}
const CTRL = 2, SHIFT = 8;
async function type(text) { await send('Input.insertText', { text }); await sleep(250); }

// the paths of this computer in what is shown, as those of anyone's (the user's name, the folder of the
// settings of the server of the shots) - in the page only, for the shot
const ANON = `const home = /[A-Z]:\\\\Users\\\\[^\\\\]+/g, hb = /[A-Z]:\\\\Users\\\\[^\\s]*?settings\\.json/g;
  const fix = s => s.replace(hb, 'C:\\\\Users\\\\you\\\\.nerdsuite\\\\settings.json').replace(home, 'C:\\\\Users\\\\you');
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (/Users/.test(n.data)) n.data = fix(n.data);
  for (const i of document.querySelectorAll('input')) { if (/Users/.test(i.value)) i.value = fix(i.value); if (/Users/.test(i.placeholder)) i.placeholder = fix(i.placeholder); }
  return 1;`;

// a screenshot: the window, or the part around an element (clip: a page expression of an element, pad)
async function shot(name, clip = null, pad = 12, { toasts = false } = {}) {
  if (!toasts) await ev(`document.querySelectorAll('.md-toast button').forEach(b => b.click()); await new Promise(r => setTimeout(r, 300)); return 1;`);
  await ev(ANON);
  let params = { format: 'webp', quality: 82 };
  if (clip) {
    const r = await center(clip);
    const x = Math.max(0, r.l - pad), y = Math.max(0, r.t - pad);
    params.clip = { x, y, width: Math.min(W - x, r.w + 2 * pad), height: Math.min(H - y, r.h + 2 * pad), scale: 1 };
  }
  const res = await send('Page.captureScreenshot', params);
  writeFileSync(join(OUT, `${name}.webp`), Buffer.from(res.result.data, 'base64'));
  console.log('shot', name);
}

// the code editor: the offset of the start of a line (1 based) - and its point on the screen
async function linePoint(line, col = 0) {
  return page(`const ta = $('.code-view__input'); const cs = getComputedStyle(ta), lh = parseFloat(cs.lineHeight), pt = parseFloat(cs.paddingTop), pl = parseFloat(cs.paddingLeft);
    const probe = document.createElement('span'); probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:' + cs.font; probe.textContent = 'x'.repeat(100); document.body.append(probe);
    const cw = probe.getBoundingClientRect().width / 100; probe.remove();
    const r = ta.getBoundingClientRect();
    return { x: r.left + pl + (${col} + 0.5) * cw - ta.scrollLeft, y: r.top + pt + (${line} - 0.5) * lh - ta.scrollTop };`);
}
async function caretTo(line, col = 0) {
  await page(`const ta = $('.code-view__input'); ta.focus(); const L = ta.value.split('\\n'); const at = L.slice(0, ${line} - 1).join('\\n').length + (${line} > 1 ? 1 : 0) + ${col};
    ta.setSelectionRange(at, at); ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }));`);
}
const lineOf = text => page(`return $('.code-view__input').value.split('\\n').findIndex(l => l.includes(${JSON.stringify(text)})) + 1;`);
// the problems console open or shut
const problems = open => page(`const t = $('.problems-console__toggle'); if (!t) return 0;
  if ((t.getAttribute('aria-expanded') === 'true') !== ${open}) t.click(); await wait(300); return 1;`);
const view = v => page(`$('.md-nav-rail__item[data-view="${v}"]').click(); await wait(900); return 1;`);
const toast = () => page(`return $$('.md-toast').map(x => x.textContent).join(' | ');`);
const closeToasts = () => page(`$$('.md-toast button').forEach(b => b.click()); await wait(300); return 1;`);

// --- the shots -------------------------------------------------------------------------------------------

const steps = [];
const step = (name, fn) => steps.push({ name, fn });

step('start', async () => {
  await open(URL_);
});

step('menu', async () => {
  await page(`$('#btn-menu').click(); await wait(500); return 1;`);
  await shot('menu', `document.querySelector('.md-menu')`, 16);
  await key('Escape');
});

step('settings', async () => {
  await key(',', CTRL);
  await sleep(800);
  await shot('settings-editor', `document.querySelector('.md-dialog')`);
  await page(`$$('.ns-set__group').find(g => /per platform/.test(g.textContent)).scrollIntoView(); await wait(300); return 1;`);
  await shot('settings-platforms', `document.querySelector('.md-dialog')`);
  await page(`byText('Colours', '.ns-set__navitem').click(); await wait(500); return 1;`);
  await shot('settings-colours', `document.querySelector('.md-dialog')`);
  await page(`byText('Toolchains', '.ns-set__navitem').click(); await wait(500); return 1;`);
  if (!(await page(`return !!$('.ns-chain');`))) {
    await clickEl(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add a toolchain')`);
    await page(`$$('.md-menu__item').find(b => /ACME › Exomizer/.test(b.textContent)).click(); await wait(1200); return 1;`);
  }
  await shot('settings-toolchains', `document.querySelector('.md-dialog')`);
  await page(`byText('Assemblers and emulators', '.ns-set__navitem').click(); await wait(1500); return 1;`);
  await shot('settings-tools', `document.querySelector('.md-dialog')`);
  await page(`const s = $('.ns-set__search input'); s.focus(); return 1;`);
  await type('basic');
  await sleep(500);
  await shot('settings-search', `document.querySelector('.md-dialog')`);
  await key('Escape');
});

step('example', async () => {
  await ensureBuild();
  await problems(false);
  await caretTo(await lineOf('sta BORDER'), 8);
  await sleep(300);
  await shot('code-overview');
});

step('completion', async () => {
  const n = await lineOf('sta BACKGROUND');
  await caretTo(n, 22);
  await key('Enter');
  await type('ld');
  await key('a');
  await sleep(600);
  await shot('code-completion');
  await key('Escape');
  // the text as it was: undo until the line typed is gone
  await page(`const ta = $('.code-view__input'); ta.focus();
    for (let i = 0; i < 6 && /\\n\\s*lda?\\s*\\n/.test(ta.value); i++) { document.execCommand('undo'); await wait(80); }
    return 1;`);
});

step('hover', async () => {
  const n = await lineOf('sta BORDER');
  const p = await linePoint(n, 13);
  await mouse('mouseMoved', p.x, p.y);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: SHIFT });
  await mouse('mouseMoved', p.x + 1, p.y, { modifiers: SHIFT });
  await sleep(700);
  await shot('code-hover');
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 0 });
  await sleep(200);
});

step('context', async () => {
  const n = await lineOf('jmp .frame');
  await page(`const ta = $('.code-view__input'), lh = parseFloat(getComputedStyle(ta).lineHeight); ta.scrollTop = Math.max(0, ${n} * lh - ta.clientHeight / 3); ta.dispatchEvent(new Event('scroll')); await wait(200); return 1;`);
  const p = await linePoint(n, 14);
  await caretTo(n, 14);
  await page(`$('.code-view__input').dispatchEvent(new MouseEvent('contextmenu', { clientX: ${p.x}, clientY: ${p.y}, bubbles: true, cancelable: true, button: 2 })); await wait(500); return 1;`);
  await shot('code-context');
  await key('Escape');
});

step('search', async () => {
  await page(`const s = $('#search'); s.focus(); s.select(); return 1;`);
  await type('sta');
  await key('Enter');
  await sleep(400);
  await shot('code-search');
  await page(`const s = $('#search'); s.focus(); return 1;`);
  await key('Escape');
});

step('breakpoint', async () => {
  const n = await lineOf('.frame: ldy #0');
  await page(`$('.code-gutter [data-line="${n}"]').click(); await wait(300); return 1;`);
  await page(`const s = $('.screen-bar input[role="switch"]'); if (s && s.checked) s.click(); await wait(300); return 1;`);
  await caretTo(n, 8);
  await shot('code-breakpoint');
  await page(`const s = $('.screen-bar input[role="switch"]'); if (s && !s.checked) s.click(); await wait(300); return 1;`);
});

step('problems', async () => {
  const n = await lineOf('sta BORDER');
  await caretTo(n, 18);
  await type('_X');
  await key('Escape');
  await key('b', CTRL);
  await sleep(1500);
  await closeToasts();
  await problems(true);
  await shot('code-problems');
  await problems(false);
  await page(`const ta = $('.code-view__input'); ta.focus(); document.execCommand('undo'); await wait(200); return 1;`);
  await key('b', CTRL);
  await sleep(1200);
  await closeToasts();
});

step('basic', async () => {
  await page(`$$('.explorer__row').find(e => e.textContent.trim() === 'hello.bas').click(); await wait(800); return 1;`);
  await caretTo(4, 8);
  await shot('code-basic');
  const p = await linePoint(2, 12);
  await click(p.x, p.y, 'right');
  await sleep(500);
  await shot('code-petscii');
  await key('Escape');
});

step('newfile', async () => {
  await page(`$('.ns-tab--add').click(); await wait(600); return 1;`);
  await shot('code-newfile', `document.querySelector('.md-dialog')`);
  await key('Escape');
});

// the file of the view shown: the first select of it that is visible
const pickFile = re => page(`const s = $$('select').find(x => x.offsetParent && [...x.options].some(o => ${re}.test(o.textContent)));
  const o = [...s.options].find(o => ${re}.test(o.textContent)); s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); await wait(1500); return 1;`);

// the files of the project at the left shown or hidden (more room for the disassembler, the hex view, the debugger)
const files = show => page(`const b = byText('Hide the files') ?? byText('Show the files'); if (!b) return 0;
  if ((b.dataset.tip === 'Hide the files') !== ${show}) b.click(); await wait(400); return 1;`);

// a build of the example (the disassembler and the hex view show demo.prg): the project opened, main.asm built
async function ensureBuild() {
  if (await page(`return !!$('.start-screen__actions');`)) await page(`$$('.start-screen__actions button').at(-1).click(); await wait(3000); return 1;`);
  await view('code');
  await page(`$$('.ns-tab').find(t => /main\\.asm/.test(t.textContent))?.click(); await wait(500); return 1;`);
  await key('b', CTRL);
  await sleep(1500);
  await closeToasts();
}

step('disasm', async () => {
  await ensureBuild();
  await view('disasm');
  await files(false);
  await pickFile('/demo\\.prg/');
  // 8 bytes a row: room for the disassembly beside the bytes
  await page(`const s = $$('select').find(x => x.offsetParent && [...x.options].some(o => o.textContent === '8 bytes')); s.value = [...s.options].find(o => o.textContent === '8 bytes').value; s.dispatchEvent(new Event('change', { bubbles: true })); await wait(600); return 1;`);
  await shot('disasm-view');
  // the charset of the demo at $3000 in the preview (the mode of the Preview section: nothing marked)
  await page(`byText('Go to an address or label (Ctrl+G)')?.click(); await wait(500); return 1;`);
  await type('$3000');
  await key('Enter');
  await sleep(600);
  await page(`const sec = $$('.section').find(s => /^Preview/.test(s.querySelector('.section__title, .section__head, h3')?.textContent.trim() ?? ''));
    sec?.scrollIntoView(); [...(sec?.querySelectorAll('button') ?? [])].find(b => b.textContent.trim() === 'Chars')?.click(); await wait(800); return 1;`);
  await shot('disasm-preview');
  await files(true);
});

step('hex', async () => {
  await ensureBuild();
  await view('hex');
  await files(false);
  await pickFile('/demo\\.prg/');
  await shot('hex-view');
  await files(true);
});

step('debug-idle', async () => {
  await view('debug');
  await files(false);
  await shot('debug-idle');
  await files(true);
});

step('debug-live', async () => {
  await ensureBuild();
  // the breakpoint at the start of the frame loop
  const n = await lineOf('.frame: ldy #0');
  await page(`const g = $('.code-gutter [data-line="${n}"]'); if (!g.classList.contains('code-gutter__bp')) g.click(); await wait(300); return 1;`);
  await key('F6');
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const s = await page(`return $$('.screen-bar .md-body-small, .screen-bar span').map(x => x.textContent).join(' ');`).catch(() => '');
    if (/Stopped at/.test(s)) break;
  }
  await closeToasts();
  await view('debug');
  await files(false);
  await sleep(1500);
  // a watch: the border colour, shown as a byte (a constant of c64.inc is no label of the build: its address)
  await page(`byText('New watch')?.click(); await wait(600); return 1;`);
  await page(`const i = $('.md-dialog input:not([type=radio])'); i.focus(); return 1;`);
  await type('$d020');
  await shot('debug-watch-dialog', `document.querySelector('.md-dialog')`);
  await page(`byText('Add', '.md-dialog button')?.click(); await wait(800); return 1;`);
  // one step, so the watch is read
  await key('F10');
  await sleep(1200);
  await shot('debug-stopped');
  await page(`byText('New breakpoint or watchpoint')?.click(); await wait(600); return 1;`);
  await shot('debug-breakpoint-dialog', `document.querySelector('.md-dialog')`);
  await key('Escape');
  await files(true);
  await view('code');
  await sleep(800);
  // the line the CPU stopped at in the middle of the editor
  await page(`const ta = $('.code-view__input'), lh = parseFloat(getComputedStyle(ta).lineHeight); const n = ta.value.split('\\n').findIndex(l => l.includes('.wait:'));
    ta.scrollTop = Math.max(0, n * lh - ta.clientHeight / 2); ta.dispatchEvent(new Event('scroll')); await wait(300); return 1;`);
  await shot('debug-code-here');
  await view('debug');
  await page(`byText('Stop VICE')?.click(); await wait(1500); return 1;`);
});

for (const s of steps) {
  if (only.size && !only.has(s.name) && s.name !== 'start') continue;
  try { await s.fn(); } catch (e) { console.log('FAILED', s.name, e.message); }
}
console.log(await toast().catch(() => ''));
ws.close();
