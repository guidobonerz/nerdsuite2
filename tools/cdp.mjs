#!/usr/bin/env node
// cdp.mjs - drive a headless Chrome over the DevTools protocol, one command per call, for checks of
// the UI by hand or by a script. Start the browser once (chrome --headless=new --remote-debugging-port=9355 ...).
//
//   node tools/cdp.mjs open URL              navigate the first page
//   node tools/cdp.mjs eval "JS"             evaluate (async allowed), prints the JSON result
//   node tools/cdp.mjs shot FILE.png         a screenshot
//   node tools/cdp.mjs click "SELECTOR"      a real mouse click in the middle of an element
//   node tools/cdp.mjs key KEY [ctrl] [shift] a key press
//   node tools/cdp.mjs type "TEXT"           insert text at the focus
//   node tools/cdp.mjs errors                the exceptions and console errors since the last call
// env: CDP_PORT (9355)

import { writeFileSync } from 'node:fs';

const PORT = Number(process.env.CDP_PORT || 9355);
const [cmdName, ...args] = process.argv.slice(2);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = list.find(t => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true });
});
const send = (method, params = {}) => new Promise(r => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async expr => {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
  const ex = r.result?.exceptionDetails;
  if (ex) throw new Error(ex.exception?.description ?? JSON.stringify(ex));
  return r.result?.result?.value;
};
// the errors of the page are collected in the page itself (installed with 'open'), read by 'errors'
const COLLECT = `if (!window.__errs) { window.__errs = []; addEventListener('error', e => __errs.push('error: ' + (e.error?.stack || e.message))); addEventListener('unhandledrejection', e => __errs.push('rejection: ' + (e.reason?.stack || e.reason))); const ce = console.error; console.error = (...a) => { __errs.push('console.error: ' + a.join(' ')); ce(...a); }; }`;

try {
  switch (cmdName) {
    case 'open': {
      await send('Page.enable');
      await send('Page.addScriptToEvaluateOnNewDocument', { source: COLLECT.replace(/^if \(!window.__errs\) \{|\}$/g, '') });
      await send('Emulation.setDeviceMetricsOverride', { width: Number(process.env.W || 1440), height: Number(process.env.H || 900), deviceScaleFactor: 1, mobile: false });
      await send('Page.navigate', { url: args[0] });
      await new Promise(r => setTimeout(r, Number(args[1] || 2500)));
      console.log(JSON.stringify(await ev('return { title: document.title, errs: window.__errs ?? [] }')));
      break;
    }
    case 'eval': console.log(JSON.stringify(await ev(args.join(' ')), null, 1)); break;
    case 'shot': {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(args[0], Buffer.from(r.result.data, 'base64'));
      console.log(args[0]);
      break;
    }
    case 'click': {
      const r = await ev(`const el = document.querySelector(${JSON.stringify(args[0])}); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 };`);
      if (!r) { console.log('no such element'); break; }
      const button = args[1] === 'right' ? 'right' : 'left';
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...r });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...r, button, clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...r, button, clickCount: 1 });
      await new Promise(res => setTimeout(res, 300));
      console.log('clicked', JSON.stringify(r));
      break;
    }
    case 'key': {
      const k = args[0], mods = (args.includes('ctrl') ? 2 : 0) | (args.includes('shift') ? 8 : 0) | (args.includes('alt') ? 1 : 0);
      const vk = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, F5: 116, F6: 117, F8: 119, F10: 121, F11: 122, ' ': 32 }[k] ?? (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0);
      const code = k.length === 1 ? (/[a-z]/i.test(k) ? 'Key' + k.toUpperCase() : k === ' ' ? 'Space' : 'Digit' + k) : k;
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
      if (k.length === 1 && !(mods & 2)) await send('Input.dispatchKeyEvent', { type: 'char', key: k, text: k, modifiers: mods });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
      await new Promise(res => setTimeout(res, 200));
      console.log('key', k);
      break;
    }
    case 'type': await send('Input.insertText', { text: args.join(' ') }); await new Promise(res => setTimeout(res, 200)); console.log('typed'); break;
    case 'errors': console.log(JSON.stringify(await ev('const e = window.__errs ?? []; window.__errs = []; return e;'), null, 1)); break;
    default: console.log('commands: open eval shot click key type errors');
  }
} catch (e) {
  console.log('ERROR', e.message);
}
ws.close();
