// assets.js - the graphics model of a project as JSON (assets.json): the items of the model (adv.js)
// without their art, which is in the graphics files they name (gfxfile.js), and without what only the
// editor keeps of them (ids, the _form of the art). The screens are no items: every screen is a file
// of its own (gfxfile.js: canvasesFrom).
//
//   { "format": 1, "items": [
//       { "kind": "charset", "value": "upper" },
//       { "kind": "costume", "name": "Dave", "file": "gfx/sprite/Dave.spr",
//         "anims": [{ "name": "talk", "frames": ["front12", "front1"], "speed": "6" }] } ] }

import { AdvError, newId, walk } from './adv.js';
import { sprPath, spritePath } from './gfxfile.js';

export const ASSETS_FORMAT = 1;

// what the editor keeps of a node and the file does not: its id, where it was in a script of before
const TRANSIENT = new Set(['id', 'line', 'blank', 'lead', 'trail', 'src', 'fp']);
const transient = k => TRANSIENT.has(k) || k.startsWith('_');

// the text of assets.json of these items, as written
export const assetsText = items => JSON.stringify({ format: ASSETS_FORMAT, items }, (k, v) => (transient(k) ? undefined : v), 2) + '\n';

// the model of a new project: the upper case charset, nothing else yet
export const NEW_ASSETS = assetsText([{ kind: 'charset', value: 'upper' }]);
// the art of a node that names its file: read from the file (gfxfile.js: costumeFromFile, spriteFromFile)
const ART = { costume: ['frames', 'layers', 'multicolor', 'size', 'colors'], sprite: ['lines', 'multicolor'] };
// the file of the art of a node: the one it names, else where a new one goes (gfxfile.js: gameFiles)
const artFile = (n, dir) => n.file ?? (n.kind === 'costume' ? sprPath(n.name, dir) : spritePath(n.name, dir));

// the graphics files the text of assets.json names (relative to it): none when it is no model
export function assetRefs(text) {
  try {
    const items = JSON.parse(text)?.items;
    return Array.isArray(items) ? [...new Set(items.filter(n => ART[n?.kind] && typeof n.file === 'string').map(n => n.file))] : [];
  } catch {
    return [];
  }
}

// the model as the text of assets.json
export function writeAssets(game, dir = 'gfx') {
  const items = game.items.map(n => {
    if (!ART[n.kind]) return n;
    const { kind, name, ...rest } = n;
    const out = { kind, name, file: artFile(n, dir), ...rest };       // the file first, then the animations
    for (const k of ART[n.kind]) delete out[k];
    return out;
  });
  return assetsText(items);
}

// the text of assets.json as the model, the art still to be read from its files (gfxfile.js: resolveGfx)
export function readAssets(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new AdvError(`not JSON: ${e.message}`);
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) throw new AdvError('no "items" list');
  if (typeof data.format !== 'number' || data.format > ASSETS_FORMAT) throw new AdvError(`format ${data.format} is newer than this editor reads (${ASSETS_FORMAT})`);
  const items = data.items.map((n, k) => {
    if (!n || typeof n !== 'object' || typeof n.kind !== 'string') throw new AdvError(`item ${k + 1} has no "kind"`);
    if (!ART[n.kind]) return n;
    if (typeof n.file !== 'string') throw new AdvError(`${n.kind} '${n.name}' names no "file"`);
    return n.kind === 'costume' ? { anims: [], ...n, frames: [], layers: [], _form: 'file' } : { ...n, lines: [], _form: 'file' };
  });
  const game = { id: newId(), kind: 'game', items };
  walk(game, n => { n.id ??= newId(); });
  return game;
}
