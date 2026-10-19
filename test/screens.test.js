// nerdsuite has screens, no places: every screen is a file of its own (gfx/screen/NAME.scr) with its
// size, its look, its layers and its tile map; the graphics model of the rest is assets.json (assets.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { encodeScreen, decodeScreen, canvasesFrom, placeToFile } from '../public/js/gfxfile.js';
import { screensOf, symbols } from '../public/js/adv.js';
import { readAssets, writeAssets, assetRefs, NEW_ASSETS } from '../public/js/assets.js';

globalThis.localStorage ??= { getItem: () => null, setItem() {} };
const { createStore } = await import('../public/js/store.js');

// the demo project as the app reads it: the model and its graphics files
function demo() {
  const dir = new URL('../examples/demo/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
  const files = new Map();
  const walk = d => { for (const n of readdirSync(join(dir, d))) { const p = d ? `${d}/${n}` : n; if (statSync(join(dir, p)).isDirectory()) walk(p); else if (p.startsWith('gfx/')) files.set(p, new Uint8Array(readFileSync(join(dir, p)))); } };
  walk('');
  // its line ends as the app reads them (project.js readText): a checkout on Windows has CRLF
  return { text: readFileSync(join(dir, 'assets.json'), 'utf8').replace(/\r\n?/g, '\n'), files };
}

test('the demo has its screens and its sprite, unchanged when read', () => {
  const { text, files } = demo();
  const s = createStore();
  s.load('assets.json', text, files);
  assert.deepEqual(screensOf(s.game).map(c => c.name), ['hall', 'town']);
  const dave = symbols(s.game).costumes.find(c => c.name === 'Dave');
  assert.ok(dave.frames.length > 0, 'its frames come from gfx/sprite/Dave.spr');
  assert.deepEqual(dave.anims.map(a => a.name), ['walk_right', 'talk']);
  assert.equal(s.dirty, false);
  assert.equal(s.serialize().text, text);                           // written back as it was
});

test('assets.json names the art, it does not hold it', () => {
  const { text, files } = demo();
  const s = createStore();
  s.load('assets.json', text, files);
  const json = JSON.parse(s.serialize().text);
  assert.equal(json.format, 1);
  const dave = json.items.find(n => n.kind === 'costume');
  assert.equal(dave.file, 'gfx/sprite/Dave.spr');
  for (const k of ['frames', 'layers', 'id', '_form']) assert.equal(k in dave, false, k);
  assert.deepEqual(assetRefs(text), ['gfx/sprite/Dave.spr']);
});

test('a changed animation is written and read again', () => {
  const { text, files } = demo();
  const s = createStore();
  s.load('assets.json', text, files);
  s.mutate(g => { g.items.find(n => n.kind === 'costume').anims[1].speed = '9'; });
  assert.equal(s.dirty, true);
  const out = s.serialize();
  const again = createStore();
  again.load('assets.json', out.text, new Map([...files, ...out.files]));
  assert.equal(symbols(again.game).costumes[0].anims[1].speed, '9');
  assert.equal(again.dirty, false);
});

test('a model formatted by hand is no change', () => {
  const { text, files } = demo();
  const s = createStore();
  s.load('assets.json', JSON.stringify(JSON.parse(text)), files);
  assert.equal(s.dirty, false);
});

test('what is no model is refused', () => {
  assert.throws(() => readAssets('charset upper\n'), /not JSON/);
  assert.throws(() => readAssets('{"format": 1}'), /no "items"/);
  assert.throws(() => readAssets('{"format": 99, "items": []}'), /newer/);
  assert.throws(() => readAssets('{"format": 1, "items": [{"kind": "costume", "name": "x"}]}'), /names no "file"/);
  assert.equal(readAssets(NEW_ASSETS).items[0].value, 'upper');
  assert.equal(writeAssets(readAssets(NEW_ASSETS)), NEW_ASSETS);
});

test('a screen keeps its tileset and its tile map in its file', () => {
  const look = { bg: 0, border: 0, text: 1, multicolor: null, ecm: null, charset: null, tiles: 'gfx/tiles/world.til', patches: [] };
  const screen = { w: 4, h: 2, chars: new Uint8Array(8).fill(32), colors: new Uint8Array(8).fill(1) };
  const tiles = { size: 2, w: 2, h: 1, cells: [0, 1] };
  const [c] = canvasesFrom(readAssets(NEW_ASSETS), new Map([['gfx/screen/map.scr', encodeScreen({ screen, patches: new Map(), tiles, look })]]));
  assert.equal(c.members.find(m => m.key === 'tiles').str, 'gfx/tiles/world.til');
  assert.deepEqual(c.members.find(m => m.kind === 'background').tiles, tiles);
  const back = decodeScreen(placeToFile(c, 'upper'));
  assert.deepEqual(back.tiles, tiles);
  assert.equal(back.look.tiles, 'gfx/tiles/world.til');
});
