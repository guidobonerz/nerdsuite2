#!/usr/bin/env node
// smoke.mjs - a binary of nerdsuite as a user gets it (tools/dist.mjs): it starts, answers with its
// version, hands out the IDE and its files, the example project and the settings, and ends.
//
// usage: node tools/smoke.mjs build/dist/nerdsuite-v1.0-linux-amd64 [--version v1.0]

import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const file = process.argv[2];
const vi = process.argv.indexOf('--version');
const version = vi >= 0 ? process.argv[vi + 1] : null;
if (!file) { console.error('usage: node tools/smoke.mjs <binary> [--version v1.0]'); process.exit(2); }
try { chmodSync(file, 0o755); } catch { /* Windows */ }

const port = 3900 + Math.floor(Math.random() * 90);
const settings = join(mkdtempSync(join(tmpdir(), 'ns-smoke-')), 'settings.json');
const proc = spawn(file, ['--no-browser', '--port', String(port)], { env: { ...process.env, NERDSUITE_SETTINGS: settings }, stdio: ['ignore', 'pipe', 'inherit'] });
let out = '';
proc.stdout.on('data', d => { out += d; });
const base = `http://127.0.0.1:${port}`;
const fail = msg => { console.error(`smoke: ${msg}\n${out}`); proc.kill(); process.exit(1); };
const get = async (path, accept) => {
  const r = await fetch(base + path, { headers: accept ? { Accept: accept } : {} });
  if (!r.ok) fail(`${path}: ${r.status}`);
  return r;
};

try {
  let info = null;
  for (let i = 0; i < 40 && !info; i++) {
    try { info = await (await fetch(`${base}/api/info`)).json(); } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  if (!info) fail('the server does not answer');
  if (info.name !== 'nerdsuite') fail(`info: ${JSON.stringify(info)}`);
  if (version && info.version !== version) fail(`the version is ${info.version}, not ${version}`);
  const page = await (await get('/')).text();
  if (!page.includes('<base href="./">') || !page.includes('js/app.js')) fail('the page of the IDE');
  if (!(await get('/js/app.js')).headers.get('content-type').startsWith('text/javascript')) fail('app.js is no JavaScript');
  if (!(await get('/fonts/C64_Pro_Mono-STYLE.woff2')).headers.get('content-type').startsWith('font/woff2')) fail('the C64 font');
  if (!(await (await get('/code/src/main.asm', 'text/html')).text()).includes('<base href="../../">')) fail('a deep route of the IDE');
  const ex = await (await get('/api/examples')).json();
  if (!ex.files?.['nerdsuite.json']) fail('the example project');
  const tools = await (await get('/api/settings/tools')).json();
  if (!tools.tools?.some(t => t.key === 'VICE')) fail('the settings');
  await get('/api/vice/status');
  await get('/api/emu/status');
  await get('/api/kickass/status');
  console.log(`smoke: ${file} ${info.version} - ok`);
} finally {
  proc.kill();
}
