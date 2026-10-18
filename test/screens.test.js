// nerdsuite has screens, no places: every screen is a file of its own (gfx/screen/NAME.scr) with its
// size, its look, its layers and its tile map - a project of before has its places turned into screens
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { encodeScreen, decodeScreen, canvasesFrom, placeToFile } from '../public/js/gfxfile.js';
import { parse, screensOf } from '../public/js/adv.js';

globalThis.localStorage ??= { getItem: () => null, setItem() {} };
const { createStore } = await import('../public/js/store.js');

// the demo project as the app reads it: the script and its graphics files
function demo() {
  const dir = new URL('../examples/demo/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
  const files = new Map();
  const walk = d => { for (const n of readdirSync(join(dir, d))) { const p = d ? `${d}/${n}` : n; if (statSync(join(dir, p)).isDirectory()) walk(p); else if (p.startsWith('gfx/')) files.set(p, new Uint8Array(readFileSync(join(dir, p)))); } };
  walk('');
  return { text: readFileSync(join(dir, 'assets.adv'), 'utf8'), files };
}

// a script of before: its screens as places, their layers in it
const PLACES = `charset upper
place hall {
    screen {
        bgcolor black
        border black
        textcolor white
        charset "gfx/charset/chars.chr"
        gfx "gfx/screen/hall.scr"
    }
    patch door_open { at (25, 3) }
    patch door_closed { at (25, 3) }
}
`;

test('the demo has screens, no places', () => {
  const { text, files } = demo();
  const s = createStore();
  s.load('assets.adv', text, files);
  assert.doesNotMatch(text, /\bplace\b/);
  assert.deepEqual(screensOf(s.game).map(c => c.name), ['hall', 'town']);
  assert.equal(s.dirty, false);
});

test('the places of a project become screens, assets.adv keeps no place', () => {
  const { files } = demo(), text = PLACES;
  const s = createStore();
  s.load('assets.adv', text, files);
  const hall = screensOf(s.game).find(c => c.name === 'hall');
  assert.ok(hall?.canvas, 'hall is a screen');
  assert.equal(s.game.items.some(x => x.kind === 'place'), false);
  assert.equal(s.dirty, true);                                       // the next save writes the new form
  assert.deepEqual(hall.members.filter(m => m.kind === 'patch').map(p => [p.name, p.col, p.row]), [['door_open', 25, 3], ['door_closed', 25, 3]]);
  const out = s.serialize();
  assert.doesNotMatch(out.text, /\bplace\b/);
  // its file holds what it was: the look, the layers where they were
  const file = decodeScreen(out.files.get('gfx/screen/hall.scr'));
  assert.equal(file.look.charset, 'gfx/charset/chars.chr');
  assert.deepEqual(file.look.patches.map(p => p.name), ['door_open', 'door_closed']);
  assert.deepEqual([...file.patches.keys()], ['door_open', 'door_closed']);
  // and read again it is the same screen, now without a place
  const again = createStore();
  again.load('assets.adv', out.text, out.files);
  const hall2 = screensOf(again.game).find(c => c.name === 'hall');
  assert.deepEqual(hall2.members.filter(m => m.kind === 'patch').map(p => [p.name, p.col, p.row, p.lines.length]),
    hall.members.filter(m => m.kind === 'patch').map(p => [p.name, p.col, p.row, p.lines.length]));
  assert.equal(again.dirty, false);
});

test('a screen keeps its tileset and its tile map in its file', () => {
  const look = { bg: 0, border: 0, text: 1, multicolor: null, ecm: null, charset: null, tiles: 'gfx/tiles/world.til', patches: [] };
  const screen = { w: 4, h: 2, chars: new Uint8Array(8).fill(32), colors: new Uint8Array(8).fill(1) };
  const tiles = { size: 2, w: 2, h: 1, cells: [0, 1] };
  const [c] = canvasesFrom(parse('charset upper\n'), new Map([['gfx/screen/map.scr', encodeScreen({ screen, patches: new Map(), tiles, look })]]));
  assert.equal(c.members.find(m => m.key === 'tiles').str, 'gfx/tiles/world.til');
  assert.deepEqual(c.members.find(m => m.kind === 'background').tiles, tiles);
  const back = decodeScreen(placeToFile(c, 'upper'));
  assert.deepEqual(back.tiles, tiles);
  assert.equal(back.look.tiles, 'gfx/tiles/world.til');
});
