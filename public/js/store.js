// store.js - editor state: the game model, selection, undo/redo and problems

import { walk, symbols, objectStartPlace } from './adv.js';
import { validate, serialize } from './advgen.js';
import { readAssets, writeAssets } from './assets.js';
import { resolveGfx, gfxDir, canvasesFrom, canvasFiles } from './gfxfile.js';
import { readTag } from './filetag.js';

export const HANDLER_KINDS = new Set(['start', 'default', 'sub', 'enter', 'exit', 'handler', 'global']);
const UNDO_LIMIT = 300;
const COALESCE_MS = 1500;
const CHECK_MS = 250;              // the pause after a burst of changes before the game is checked

function lsGet(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

// the same file: the same data - the tag of the editor that wrote it does not count (filetag.js), so
// a file of an older editor, written again unchanged, is no change
const sameData = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const sameBytes = (a, b) => !!a && !!b && sameData(readTag(a).data, readTag(b).data);

export function createStore() {
  const listeners = new Set();
  const s = {
    game: null,
    path: null,
    savedText: '',
    gfx: new Map(),           // the graphics files as saved: path relative to the script -> bytes (gfxfile.js)
    canvasPaths: new Set(),   // the files of the canvases as saved (gfxfile.js: canvasFiles)
    dirty: false,
    selection: null,          // node id or 'group:*'
    focusStmt: null,          // statement id highlighted in the inspector
    scope: null,              // place shown in the storyboard (node id), null = the whole world
    collapsed: new Set(),
    problems: [],
    compileProblems: [],
    search: '',
    showLinks: lsGet('adv-links', false),
    index: new Map(),
    undoStack: [],
    redoStack: [],
    lastKey: null,
    lastTime: 0,
  };

  s.on = fn => { listeners.add(fn); return () => listeners.delete(fn); };
  s.emit = (type, detail = {}) => listeners.forEach(fn => fn(type, detail));

  s.reindex = (later = false) => {
    const index = new Map();
    index.set(s.game.id, { node: s.game });
    walk(s.game, (n, parent) => {
      const p = index.get(parent?.id) || {};
      index.set(n.id, {
        node: n, parent,
        owner: HANDLER_KINDS.has(n.kind) ? n : p.owner,
        object: n.kind === 'object' || n.kind === 'actor' ? n : p.object,
        place: n.kind === 'place' ? n : p.place,
      });
    });
    // the canvases: painted like places, no place of the game (gfxfile.js)
    for (const c of s.game.canvases ?? []) {
      index.set(c.id, { node: c, parent: s.game, place: c });
      for (const m of c.members) index.set(m.id, { node: m, parent: c, place: c });
    }
    s.index = index;
    if (later) checkLater(); else s.check();
  };

  // the problems of the game: the whole game is validated, so a burst of changes (a stroke,
  // typing) is checked once, at its end (checkLater) - with the dirty flag, which writes it all
  let checkTimer = 0;
  s.check = () => {
    clearTimeout(checkTimer);
    checkTimer = 0;
    try {
      s.problems = validate(s.game);
    } catch (e) {
      console.error(e);
      s.problems = [{ id: s.game.id, msg: 'validator failed: ' + e.message, severity: 'error' }];
    }
  };
  // the model (assets.json) and its graphics files as they would be saved
  s.serialize = () => {
    const out = serialize(s.game, { dir: gfxDir(s.path) });
    for (const [path, data] of canvasFiles(s.game, gfxDir(s.path))) out.files.set(path, data);   // the canvases are saved, not built
    return out;
  };
  // the files of the canvases saved last that the game has no more (a canvas deleted): app.js removes them
  s.goneCanvases = files => [...s.canvasPaths].filter(path => !files.has(path));
  // the graphics files that differ from the saved ones
  s.changedGfx = files => [...files].filter(([path, data]) => !sameBytes(s.gfx.get(path), data));
  const checkDirty = () => {
    const out = s.serialize();
    s.dirty = out.text !== s.savedText || s.changedGfx(out.files).length > 0;
  };
  const checkLater = () => {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(() => { s.check(); checkDirty(); s.emit('problems'); }, CHECK_MS);
  };

  s.node = id => s.index.get(id)?.node ?? null;
  s.info = id => s.index.get(id) ?? null;

  // places enclosing node `id`, outermost first (a place itself comes last)
  s.placePath = id => {
    const path = [];
    const start = id ? s.index.get(id) : null;
    for (let n = start?.node.kind === 'place' ? start.node : start?.place; n?.kind === 'place'; n = s.index.get(n.id)?.parent) path.unshift(n);
    return path;
  };

  // place whose storyboard level shows node `id` (null = the world)
  s.scopeOf = id => {
    const info = id && !String(id).startsWith('group:') ? s.index.get(id) : null;
    if (!info) return s.scope;
    if (info.node.kind === 'game') return null;
    if (info.object && !info.place) {
      // objects and actors declared outside places are shown in their start place
      const start = objectStartPlace(s.game, info.object);
      const place = symbols(s.game).allPlaces.find(r => r.name === start);
      if (place) return place.id;
    }
    return info.place?.id ?? null;
  };

  s.enterPlace = id => {
    const next = id && s.node(id)?.kind === 'place' ? id : null;
    if (next === s.scope) return;
    s.scope = next;
    lsSet('adv-scope:' + s.path, next && s.node(next).name);
    s.emit('scope');
  };

  // text: assets.json (assets.js); files: the graphics files it names and those of the screens
  // (Map path -> bytes). A text that is no model throws (AdvError)
  s.load = (path, text, files = new Map()) => {
    const game = resolveGfx(readAssets(text), files);
    game.canvases = canvasesFrom(game, files, gfxDir(path));
    s.game = game;
    s.path = path;
    // as it is written: a file formatted by hand is no change
    s.savedText = writeAssets(game, gfxDir(path));
    s.gfx = new Map(files);
    s.canvasPaths = new Set(canvasFiles(game, gfxDir(path)).keys());
    s.dirty = false;
    s.selection = null;
    s.focusStmt = null;
    s.undoStack = [];
    s.redoStack = [];
    s.compileProblems = [];
    s.collapsed = new Set(lsGet('adv-collapsed:' + path, ['grp:defaults']));
    s.reindex();
    checkDirty();
    const scopeName = lsGet('adv-scope:' + path, null);
    s.scope = symbols(game).allPlaces.find(p => p.name === scopeName)?.id ?? null;
    s.emit('load');
  };

  // replace the whole model (source view apply) as one undo step
  s.replace = game => {
    game.canvases ??= s.game?.canvases ?? [];          // the script does not hold them
    s.undoStack.push(JSON.stringify(s.game));
    s.redoStack = [];
    s.lastKey = null;
    s.game = game;
    s.afterChange('replace');
  };

  // run fn(game) as an undoable change. Changes with the same key within a short time are
  // merged into one undo step (typing in a field, a stroke): the game is only copied for a new
  // step, and a burst is checked when it is over (checkLater).
  s.mutate = (fn, { key = null, source = null } = {}) => {
    const now = Date.now();
    const more = !!key && key === s.lastKey && now - s.lastTime < COALESCE_MS;
    const snapshot = more ? null : JSON.stringify(s.game);
    const result = fn(s.game);
    if (result === false) return false;
    if (!more) {
      s.undoStack.push(snapshot);
      if (s.undoStack.length > UNDO_LIMIT) s.undoStack.shift();
    }
    s.redoStack = [];
    s.lastKey = key;
    s.lastTime = now;
    s.afterChange(source, more);
    return result;
  };

  // run fn(game) for what follows from other data - the chars of a place painted with tiles
  // after a tile changed (tileset.js): no undo step of its own, and the redo steps stay. fn
  // returns false when nothing changed
  s.derive = (fn, { source = null } = {}) => {
    if (!s.game || fn(s.game) === false) return false;
    s.lastKey = null;
    s.afterChange(source);
    return true;
  };

  // later: the problems and the dirty flag wait for the end of a burst; a change dirties the game
  s.afterChange = (source, later = false) => {
    s.reindex(later);
    if (s.scope && !s.index.has(s.scope)) s.scope = null;
    if (later) s.dirty = true; else checkDirty();
    if (s.selection && !s.selection.startsWith('group:') && !s.index.has(s.selection)) s.selection = null;
    if (s.focusStmt && !s.index.has(s.focusStmt)) s.focusStmt = null;
    s.emit('change', { source });
  };

  const travel = (from, to) => {
    if (!from.length) return;
    to.push(JSON.stringify(s.game));
    s.game = JSON.parse(from.pop());
    s.lastKey = null;
    s.afterChange('undo');
  };
  s.undo = () => travel(s.undoStack, s.redoStack);
  s.redo = () => travel(s.redoStack, s.undoStack);

  s.select = (id, { focusStmt = null, reveal = false } = {}) => {
    s.selection = id;
    s.focusStmt = focusStmt;
    s.emit('select', { reveal });
  };

  s.isCollapsed = key => s.collapsed.has(key);
  s.setCollapsed = (keys, collapsed) => {
    for (const k of [].concat(keys)) {
      if (collapsed) s.collapsed.add(k); else s.collapsed.delete(k);
    }
    lsSet('adv-collapsed:' + s.path, [...s.collapsed]);
    s.emit('layout');
  };

  s.setSearch = text => { s.search = text; s.emit('search'); };
  s.setShowLinks = on => { s.showLinks = on; lsSet('adv-links', on); s.emit('layout'); };

  s.markSaved = (text, files = s.gfx) => {
    s.savedText = text;
    s.gfx = new Map(files);
    s.canvasPaths = new Set(s.game ? canvasFiles(s.game, gfxDir(s.path)).keys() : []);
    s.dirty = false;
    s.emit('saved');
  };

  s.setCompileProblems = list => {
    s.compileProblems = list;
    s.emit('problems');
  };

  s.allProblems = () => [...s.compileProblems, ...s.problems];

  return s;
}
