// actions.js - editing operations shared by the storyboard, inspector and app bar

import { walkAreaWith, walkPoints, clampToArea } from './walkarea.js';
import { OPS, newId, walk, actionVerbs, bodiesOf, symbols, objectHome, objectStartPlace, getAttr, checkExpr, PLACE_COLS, MAX_PLACE_COLS, PLACE_ROWS, FULL_ROWS, MAX_FULL_COLS, gameRows, maxPlaceCols, MAX_CANVAS, DIRART_COLS, MAX_DIRART_ROWS, hasScreen, CLICK_VERB, onName, parseBody, walkBody, LOCKED_TEXT } from './adv.js';
import {
  newPlace, newObject, newHandler, newStmt, newTop, cloneFresh, uniqueName, renameSymbol, numValue, placeWidth, setObjAttr, behindStrips,
} from './advgen.js';
import { openMenu, promptDialog, snackbar, setSideCollapsed, confirmRemove } from './pui.js';
import { convertGameToPetscii } from './petscii.js';
import { tr } from './i18n.js';
import { SEQ_KINDS } from './seqtags.js';
import { newCanvas, gameFiles, scrPath, gfxDir, dirartPath, canvasPath } from './gfxfile.js';

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(['place', 'inventory', 'nowhere', 'click', 'true', 'false', 'has', 'random', 'and', 'or', 'not',
  'if', 'else', 'while', 'on', 'at', 'in', 'size', 'layer', 'walkto', 'state', 'to']);

// a point of place p for an actor: x, y, clamped into its walk area when it has one, without its
// block areas (walkarea.js)
function walkSpot(p, x, y) {
  const wa = p && getAttr(p, 'walkarea');
  const blocks = p?.members.filter(m => m.kind === 'attr' && m.key === 'blockarea').map(m => ({ pts: walkPoints(m.values.map(v => numValue(v) ?? 0)), cond: m.cond })) ?? [];
  const area = wa && walkAreaWith(walkPoints(wa.map(v => numValue(v) ?? 0)), blocks);
  if (!area || area.error) return [x, y];
  const q = clampToArea(area, x, y);
  return [q.x, q.y];
}

export const VERB_ICONS = {
  walk: 'directions_walk', look: 'visibility', pickup: 'back_hand', use: 'handyman', open: 'door_open',
  close: 'door_front', push: 'pan_tool', pull: 'front_hand', give: 'redeem', talk: 'forum', read: 'menu_book',
  click: 'ads_click',
};

export const KIND_ICONS = {
  game: 'sports_esports', start: 'play_circle', object: 'category', handler: 'bolt',
  enter: 'login', sub: 'function', default: 'rule', stmt: 'data_object', actor: 'person', costume: 'checkplace', place: 'travel_explore',
};

// icon of a place: group (no screen), shown without actors (goto PLACE: a map, a closeup - symbols) or place
export const placeIcon = p => (!hasScreen(p) ? KIND_ICONS.place : p._noActors ? 'map' : KIND_ICONS.place);

// find the list that holds node `id`
export function locate(game, id) {
  const lists = [game.items];
  walk(game, n => {
    if (n.kind === 'place' && n.members) lists.push(n.members);
    if ((n.kind === 'object' || n.kind === 'actor') && n.handlers) lists.push(n.handlers);
    bodiesOf(n).forEach(b => lists.push(b.stmts));
  });
  for (const list of lists) {
    const index = list.findIndex(x => x.id === id);
    if (index >= 0) return { list, index, node: list[index] };
  }
  return null;
}

// ref = { owner: node id, branch: index | 'else' }
export function resolveBody(store, ref) {
  const n = store.node(ref.owner);
  if (!n) return null;
  if (n.kind === 'stmt') {
    if (n.op === 'if') return ref.branch === 'else' ? n.else : n.branches[ref.branch ?? 0]?.body;
    if (n.op === 'while' || n.op === 'cutscene') return n.body;
    if (n.op === 'choose') return n.options[ref.branch ?? 0]?.body;
    return null;
  }
  return n.body ?? null;
}

export function createActions(store) {
  const A = {};
  const game = () => store.game;
  const S = () => symbols(store.game);

  // kind 'patch': patches have names of their own, other names may be the same as a patch's
  const nameField = (label, value, current = null, kind = 'symbol') => ({
    name: 'name', label, value, mono: true,
    validate: v => {
      if (!NAME_RE.test(v)) return '§0949';
      if (RESERVED.has(v)) return `'${v}' is a reserved word`;
      if (v !== current && uniqueName(game(), v, kind) !== v) return tr('§0121', v);
      return null;
    },
  });

  // members of a place (id) or of the place shown in the storyboard, else the top level
  const scopeItems = placeId => {
    const n = store.node(typeof placeId === 'string' ? placeId : store.scope);
    return n?.kind === 'place' ? n.members : game().items;
  };

  const insertItem = (item, afterKind, items = game().items) => {
    let at = -1;
    items.forEach((it, k) => { if (it.kind === afterKind) at = k; });
    items.splice(at >= 0 ? at + 1 : items.length, 0, item);
  };

  // a place inside a place (id), inside the place shown in the storyboard, or at the top level
  // a new place in these items: at the top level it joins the first chapter (places inside a place inherit its chapter)
  // (a place is declared at the top level and names no chapter: the chapters name their places)
  const newPlaceChapter = () => null;

  // the size of a new screen, chosen in its dialog: the game's - 17 rows under the sentence line,
  // the verbs and the inventory (19 with the verb coin), 40 columns or more (up to 120, 107 with the
  // coin) that scroll - or fullscreen, 40 x 24
  // over them (it does not scroll); in the dialog of a new place also a free size: a canvas of 1-255
  // x 1-255 chars to paint and to save, no place of the game (gfxfile.js: canvases)
  // A game on a .d64 also has the directory art: a canvas of 16 columns, a file name each row
  const sizeFields = ({ free = false } = {}) => [
    { name: 'size', label: '§1645', value: 'game', radios: [
      { value: 'game', label: `Screen: ${gameRows(game())} rows, 40 columns or wider (scrolls)` }, ...(free ? [{ value: 'free', label: '§1648' }] : []),
      ...(free ? [{ value: 'dirart', label: '§1739' }] : [])],
      onchange: (v, dlg) => {                     // the directory art: its own name, rows that fit the directory
        if (v === 'dirart' && /^drawing\d*$/.test(dlg.values().file)) dlg.set('file', uniqueCanvas('dirart'));
        if (v === 'dirart' && Number(dlg.values().rows) > MAX_DIRART_ROWS) dlg.set('rows', '10');
      } },
    { name: 'cols', label: '§1649', value: '40', mono: true, when: v => v.size !== 'full' && v.size !== 'dirart', row: 'size',
      spin: v => (v.size === 'free' ? { min: 1, max: MAX_CANVAS } : { min: PLACE_COLS, max: maxPlaceCols(game()) }),
      validate: (c, v) => {
        const [min, max] = v.size === 'free' ? [1, MAX_CANVAS] : [PLACE_COLS, maxPlaceCols(game())], n = Number(c);
        return Number.isInteger(n) && n >= min && n <= max ? null : tr('§1653', min, max);
      } },
    { name: 'rows', label: '§1650', value: '25', mono: true, when: v => v.size === 'free' || v.size === 'dirart', row: 'size',
      spin: v => ({ min: 1, max: v.size === 'dirart' ? MAX_DIRART_ROWS : MAX_CANVAS }),
      validate: (r, v) => {
        const n = Number(r), max = v.size === 'dirart' ? MAX_DIRART_ROWS : MAX_CANVAS;
        return Number.isInteger(n) && n >= 1 && n <= max ? null : tr('§1655', 1, max);
      } },
  ];
  const sizeOf = v => ({ cols: v.size === 'full' ? MAX_FULL_COLS : v.size === 'dirart' ? DIRART_COLS : Number(v.cols),
    rows: v.size === 'full' ? FULL_ROWS : v.size === 'free' || v.size === 'dirart' ? Number(v.rows) : gameRows(game()) });

  // the name of a canvas is the name of its file, gfx/screen/NAME.scr: none a place writes
  const canvasTaken = name => (game().canvases ?? []).some(c => c.name === name) || gameFiles(game(), gfxDir(store.path)).files.has(scrPath(name, gfxDir(store.path)))
    || gameFiles(game(), gfxDir(store.path)).files.has(dirartPath(name, gfxDir(store.path)));
  const uniqueCanvas = base => { let n = base; for (let k = 2; canvasTaken(n); k++) n = base + k; return n; };
  const canvasField = () => ({
    name: 'file', label: '§1656', mono: true, when: v => v.size === 'free' || v.size === 'dirart',
    value: uniqueCanvas('drawing'),
    validate: v => (!NAME_RE.test(v) ? '§0949' : canvasTaken(v) ? tr('§0121', v) : null),
  });

  // a new canvas, shown in the screen editor
  const addCanvas = (name, { cols, rows }) => {
    const c = newCanvas(name, cols, rows, S().charset);
    store.mutate(g => { (g.canvases ??= []).push(c); g.canvases.sort((a, b) => a.name.localeCompare(b.name)); }, { source: 'structure' });
    snackbar(tr('§1652', name, cols, rows, scrPath(name, gfxDir(store.path))));
    A.openScreen(c.id);
    return c;
  };

  // the directory art of the .d64: a canvas of 16 columns in the upper case charset, in a folder of
  // its own (gfx/dirart), and the line 'dirart "gfx/dirart/NAME.scr"' of the script - the new one is
  // the one in use (the game settings choose among them)
  const addDirart = (name, rows) => {
    const c = newCanvas(name, DIRART_COLS, rows, S().charset, { dirart: true });
    const file = dirartPath(name, gfxDir(store.path));
    store.mutate(g => {
      (g.canvases ??= []).push(c);
      g.canvases.sort((a, b) => a.name.localeCompare(b.name));
      const it = g.items.find(x => x.kind === 'dirart');
      if (it) it.str = file;
      else {
        const after = ['year', 'author', 'gametitle', 'media', 'platform', 'charset'].map(k => g.items.findIndex(x => x.kind === k)).find(i => i >= 0) ?? -1;
        g.items.splice(after + 1, 0, { id: newId(), kind: 'dirart', str: file });
      }
    }, { source: 'structure' });
    snackbar(tr('§1741', name, rows, file));
    A.openScreen(c.id);
    return c;
  };

  // the directory art in use (the script's 'dirart' line): a canvas of gfx/dirart, or none - the
  // .d64 then shows the default art, the box with the title, the author and the year
  A.setDirart = c => store.mutate(g => {
    const i = g.items.findIndex(x => x.kind === 'dirart');
    const file = c && dirartPath(c.name, gfxDir(store.path));
    if (!file) { if (i >= 0) g.items.splice(i, 1); return; }
    if (i >= 0) { g.items[i].str = file; return; }
    const after = ['year', 'author', 'gametitle', 'media', 'platform', 'charset'].map(k => g.items.findIndex(x => x.kind === k)).find(k => k >= 0) ?? -1;
    g.items.splice(after + 1, 0, { id: newId(), kind: 'dirart', str: file });
  }, { source: 'structure' });

  // a canvas out of the game (asked first); its file goes with the next save. The directory art in
  // use takes the script's line along: the default art again
  A.deleteCanvas = async id => {
    const c = (game().canvases ?? []).find(x => x.id === id);
    if (!c || !(await confirmRemove({ what: tr('§1658', c.name), detail: tr('§1659', canvasPath(c, gfxDir(store.path))), kind: 'canvas' }))) return false;
    const inUse = c.canvas.dirart && S().dirart === dirartPath(c.name, gfxDir(store.path));
    store.mutate(g => {
      g.canvases = g.canvases.filter(x => x.id !== id);
      if (inUse) g.items.splice(g.items.findIndex(x => x.kind === 'dirart'), 1);
    }, { source: 'structure' });
    return true;
  };

  A.addPlace = async placeId => {
    const parent = store.node(typeof placeId === 'string' ? placeId : store.scope);
    const into = null;                        // places are declared at the top level
    const placeOnly = v => v.size !== 'free' && v.size !== 'dirart';
    const v = await promptDialog({
      title: 'New screen', icon: 'add_location_alt', ok: '§0124',
      text: 'A screen of 25 rows, 40 to 120 columns wide, with its own charset, colors and layers - or a free size canvas.',
      fields: [
        { ...nameField('Name', uniqueName(game(), 'screen')), when: placeOnly },
        canvasField(),
        ...sizeFields({ free: true }),
      ],
    });
    if (!v) return null;
    if (v.size === 'free') return addCanvas(v.file, sizeOf(v));
    if (v.size === 'dirart') return addDirart(v.file, sizeOf(v).rows);
    const place = newPlace(v.name, S().charset, into ? null : newPlaceChapter(game().items), sizeOf(v));
    store.mutate(() => insertItem(place, 'place', into ? into.members : game().items), { source: 'structure' });
    store.select(place.id, { reveal: true });
    return place;
  };

  // rect: optional hotspot {col, row, w, h} (drawn in the screen editor)
  A.addObject = async (placeId, rect = null, { select: doSelect = true, name = null } = {}) => {
    const place = placeId ? store.node(placeId) : null;
    const v = await promptDialog({
      title: place ? tr('§0128', place.name) : '§0129', icon: 'category', ok: '§0124',
      fields: [nameField('§0130', name ?? uniqueName(game(), 'item', 'symbol')),
        { name: 'title', label: '§0131', value: '', validate: t => (t ? null : 'required') }],
    });
    if (!v) return;
    const obj = newObject(v.name, v.title, !!place);
    if (place && rect) {
      setObjAttr(obj, 'at', [String(rect.col), String(rect.row)]);
      setObjAttr(obj, 'size', [String(rect.w), String(rect.h)]);
    }
    store.mutate(() => {
      if (place) place.members.push(obj);
      else insertItem(obj, 'object', scopeItems());
    }, { source: 'structure' });
    if (doSelect) store.select(obj.id, { reveal: true });
    return obj;
  };

  A.showInStory = () => {};     // replaced by the app shell
  A.test = () => {};            // debug play of a place or a handler: replaced by the app shell

  // an exit: an object whose walk handler goes to another place, optionally only by a rule - on a
  // map the places to choose from, in a place a door or a path
  //   onWalk {
  //       if RULE { goto PLACE (X, Y) }
  //       else { say "You can't go there yet." }
  //   }
  A.addExitObject = async placeId => {
    const place = store.node(placeId);
    const targets = S().places.filter(r => r !== place);
    const v = await promptDialog({
      title: tr('§0132', place.name), icon: 'location_on', ok: '§0124',
      fields: [nameField('§0130', uniqueName(game(), 'exit')),
        { name: 'title', label: '§0131', value: '', validate: t => (t ? null : 'required') },
        { name: 'place', label: '§0133', value: targets[0]?.name ?? place.name,
          options: (targets.length ? targets : [place]).map(r => ({ value: r.name, label: r.name })) },
        { name: 'cond', label: '§0134', value: '', mono: true, placeholder: 'has(boat)',
          validate: t => (t && checkExpr(t)) || null }],
    });
    if (!v) return null;
    const target = S().places.find(r => r.name === v.place);
    const wb = target && getAttr(target, 'walkbox');
    const [x, y] = walkSpot(target, wb ? numValue(wb[0]) + 36 : 40, wb ? numValue(wb[3]) : 120);
    const go = `goto ${v.place} (${x}, ${y})`;
    const travel = parseBody(v.cond ? `if ${v.cond} { ${go} }\nelse { say "${LOCKED_TEXT.replace(/"/g, '\\"')}" }` : go);
    delete travel.inline;
    walkBody(travel, s => { delete s.src; delete s.fp; });
    const walkVerb = S().verbs[0]?.name ?? 'walk';
    const exit = {
      id: newTop('object').id, kind: 'object', name: v.name, title: v.title, blank: true,
      attrs: [{ key: 'at', values: ['18', '5'] }, { key: 'size', values: ['4', '3'] }],
      handlers: [newHandler(walkVerb, null, travel.stmts), newHandler('look', null, [Object.assign(newStmt('say'), { text: `The ${v.title}.` })])],
    };
    store.mutate(() => { place.members.push(exit); }, { source: 'structure' });
    store.select(exit.id, { reveal: true });
    return exit;
  };

  const isPlayable = n => n?.kind === 'actor' && n.attrs.some(x => x.key === 'playable');
  const setAttrOf = (n, key, values) => {
    const i = n.attrs.findIndex(x => x.key === key);
    if (values == null) { if (i >= 0) n.attrs.splice(i, 1); } else if (i >= 0) n.attrs[i].values = values;
    else n.attrs.push({ key, values });
  };

  // a playable character is declared at the top level, with the game: out of the place it was
  // declared in, which it still starts in ('in PLACE'). call inside store.mutate
  const toTopLevel = (g, n) => {
    const loc = locate(g, n.id);
    if (!loc || loc.list === g.items) return;
    const home = store.info(n.id)?.parent;
    loc.list.splice(loc.index, 1);
    if (home?.kind === 'place' && !n.attrs.some(x => x.key === 'in')) n.attrs.unshift({ key: 'in', values: [home.name] });
    walk({ items: [n] }, x => { delete x.src; delete x.fp; });   // written again with the new indentation
    n.blank = true;
    insertItem(n, 'actor', g.items);
  };

  // the playable flag of an actor: a playable character lives at the top level
  A.setPlayable = (id, on) => {
    const n = store.node(id);
    if (n?.kind !== 'actor') return;
    store.mutate(g => {
      setAttrOf(n, 'playable', on ? [] : null);
      if (on) toTopLevel(g, n);
    }, { source: 'structure' });
  };

  // a person in a place, or a (playable) actor without a place. A playable character of a place
  // is an actor of the game that starts there
  // role: what the dialog proposes - 'playable', or 'npc' (an extra of the game, a person of the place)
  A.addActor = async (placeId, role = placeId ? 'npc' : 'playable') => {
    const place = placeId ? store.node(placeId) : null;
    const v = await promptDialog({
      title: place ? tr('§0135', place.name) : role === 'npc' ? '§0136' : '§0137', icon: 'person_add', ok: '§0124',
      fields: [nameField('§0138', uniqueName(game(), role === 'npc' ? 'person' : 'kid')),
        { name: 'title', label: '§0139', value: '', validate: t => (t ? null : 'required') },
        { name: 'role', label: '§0140', value: role,
          options: [{ value: 'npc', label: '§0141' }, { value: 'playable', label: '§0142' }] }],
    });
    if (!v) return null;
    const a = { id: newTop('actor').id, kind: 'actor', name: v.name, title: v.title, blank: true, attrs: [], handlers: [] };
    const playable = v.role === 'playable';
    if (place && playable) a.attrs.push({ key: 'in', values: [place.name] });
    if (place) a.attrs.push({ key: 'at', values: walkSpot(place, 80, Number(getAttr(place, 'walkbox')?.[3] ?? '140')).map(String) });
    if (playable) a.attrs.push({ key: 'playable', values: [] });
    a.handlers.push(newHandler('look', null, [Object.assign(newStmt('say'), { text: `That's ${v.title}.` })]));
    if (S().verbs.some(vb => vb.name === 'talk')) {
      a.handlers.push(newHandler('talk', null, [Object.assign(newStmt('say'), { actor: v.name, text: 'Hello!' })]));
    }
    store.mutate(() => {
      if (place && !playable) place.members.push(a);
      else insertItem(a, 'actor', game().items);           // actors and extras of the game: the top level
    }, { source: 'structure' });
    store.select(a.id, { reveal: true });
    return a;
  };

  // the verbs offered are those of the mode: in symbol mode walk, look, hand and talk (actionVerbs)
  A.addHandler = async objectId => {
    const obj = store.node(objectId);
    const verbs = actionVerbs(S());
    const used = new Set((obj.handlers || []).map(h => h.verb + ' ' + (h.other || '')));
    const free = verbs.find(vb => !used.has(vb.name + ' '));
    const v = await promptDialog({
      title: tr('§0143', obj.name), icon: 'bolt', ok: '§0144',
      fields: [
        { name: 'verb', label: 'Verb', value: free?.name ?? verbs[0]?.name, options: [
          ...verbs.map(vb => ({ value: vb.name, label: `${vb.text}${vb.prep ? ' … ' + vb.prep : ''}  (${vb.name})` })),
          { value: CLICK_VERB, label: '§0145' }] },
        { name: 'other', label: '§0146', value: '',
          options: [{ value: '', label: '§0147' }, ...[...S().objects, ...S().actors].filter(o => o !== obj).map(o => ({ value: o.name, label: `${o.title} (${o.name})` }))],
          validate: (other, all) => (used.has(all.verb + ' ' + other) ? '§0148' : null) },
      ],
    });
    if (!v) return;
    const h = newHandler(v.verb, v.other || null);
    store.mutate(() => { (obj.handlers ??= []).push(h); }, { source: 'structure' });
    store.select(h.id, { reveal: true });
  };

  // the scripts of a place: 'on enter' when it is there, 'on exit' before it is left
  const addPlaceScript = (placeId, kind) => {
    const place = store.node(placeId);
    const existing = place.members.find(m => m.kind === kind);
    if (existing) return store.select(existing.id, { reveal: true });
    const script = { id: newTop(kind === 'enter' ? 'enter' : 'sub').id, kind, blank: true, body: { stmts: [] } };
    store.mutate(() => {
      const firstObj = place.members.findIndex(m => m.kind === 'object');
      place.members.splice(firstObj >= 0 ? firstObj : place.members.length, 0, script);
    }, { source: 'structure' });
    store.select(script.id, { reveal: true });
  };
  A.addEnter = placeId => addPlaceScript(placeId, 'enter');
  A.addExit = placeId => addPlaceScript(placeId, 'exit');

  // the scripts of the game around those of every place (advc/adv/enterexit.go)
  A.addGlobalMenu = anchor => {
    const has = new Set(game().items.filter(n => n.kind === 'global').map(n => `${n.when} ${n.what}`));
    const one = (when, what) => ({ label: onName(when, what), icon: what === 'enter' ? 'login' : 'logout', disabled: has.has(`${when} ${what}`),
      onclick: () => {
        const n = { id: newTop('sub').id, kind: 'global', when, what, blank: true, body: { stmts: [] } };
        store.mutate(() => insertItem(n, 'start'), { source: 'structure' });
        store.select(n.id, { reveal: true });
      } });
    openMenu(anchor, [{ header: '§1046' },
      one('pre', 'enter'), one('post', 'enter'), one('pre', 'exit'), one('post', 'exit')]);
  };

  // the text sequences after the intro (prolog) and at an end of the game (epilog NAME), seqtags.js
  const newSeq = kind => ({ kind, charset: null, screen: null, picture: null, rows: null, music: null, typesound: null, fadeout: null,
    text: kind === 'writer' ? 'Dear adventurer,\n{hold 1}the story begins ...{key}' : '{center}{color white}THE END{hold 3}' });
  A.newSeq = newSeq;
  // the prolog, a writer or a scroller (kind) - one of them: another kind is deleted and made anew
  A.addProlog = (kind = 'writer') => {
    if (S().prolog) return store.select(S().prolog.id, { reveal: true });
    const n = newTop('prolog', { seqs: [newSeq(kind)], blank: true });
    store.mutate(() => insertItem(n, 'intro'), { source: 'structure' });
    store.select(n.id, { reveal: true });
  };
  // the outro after every epilog, a writer or a scroller: one of them, like the prolog
  A.addOutro = (kind = 'scroller') => {
    if (S().outro) return store.select(S().outro.id, { reveal: true });
    const seq = newSeq(kind);
    if (kind === 'scroller') seq.text = '{center}{color white}THANK YOU FOR PLAYING{hold 3}';
    const n = newTop('outro', { seqs: [seq], blank: true });
    const after = ['epilog', 'prolog', 'intro'].find(k => game().items.some(x => x.kind === k));
    store.mutate(() => insertItem(n, after), { source: 'structure' });
    store.select(n.id, { reveal: true });
  };
  // the menu of the kinds: then fn(kind)
  A.seqKindMenu = (anchor, fn) => openMenu(anchor, Object.entries(SEQ_KINDS).map(([kind, d]) => ({ label: d.label, icon: d.icon, onclick: () => fn(kind) })));
  A.addEpilog = async (kind = 'scroller') => {
    const taken = new Set(S().epilogs.map(e => e.name));
    let name = 'ending', k = 1;
    while (taken.has(name)) name = 'ending' + ++k;
    const v = await promptDialog({ title: tr('§1545'), icon: 'flag', ok: '§0124', text: '§1546',
      fields: [{ name: 'name', label: '§1547', value: name, mono: true,
        validate: x => (!NAME_RE.test(x) ? '§0949' : taken.has(x) ? tr('§0121', x) : null) }] });
    if (!v) return;
    const n = newTop('epilog', { name: v.name, seqs: [newSeq(kind)], blank: true });
    store.mutate(() => insertItem(n, game().items.some(x => x.kind === 'epilog') ? 'epilog' : 'prolog'), { source: 'structure' });
    store.select(n.id, { reveal: true });
  };

  A.openScreen = () => {};      // replaced by the app shell
  A.openBitmap = () => {};

  // text maps -> PETSCII glyphs + color maps
  A.convertToPetscii = () => {
    const maps = store.mutate(g => convertGameToPetscii(g) || false, { source: 'structure' });
    if (maps) snackbar(tr('§0149', maps), { action: 'Undo', onaction: () => store.undo() });
  };

  // 40 = no scrolling. Shrinking crops the background map, the walkbox and the corners of the walk
  // area at the right edge follow
  A.setPlaceWidth = (placeId, value) => {
    const rm = store.node(placeId);
    const w = Math.max(PLACE_COLS, Math.min(store.node(placeId)?.fullscreen ? MAX_FULL_COLS : maxPlaceCols(store.game), Math.round(Number(value) || PLACE_COLS)));   // fullscreen: 40
    const old = placeWidth(rm);
    if (!rm || w === old) return;
    store.mutate(() => {
      const i = rm.members.findIndex(m => m.kind === 'attr' && m.key === 'width');
      if (w === PLACE_COLS) { if (i >= 0) rm.members.splice(i, 1); }
      else if (i >= 0) rm.members[i].values = [String(w)];
      else {
        const at = rm.members.findIndex(m => m.kind === 'attr' && m.key === 'textcolor');
        rm.members.splice(at >= 0 ? at + 1 : 0, 0, { id: newTop('attr').id, kind: 'attr', key: 'width', values: [String(w)] });
      }
      const bg = rm.members.find(m => m.kind === 'background');
      if (bg && w < old) bg.lines = bg.lines.map(l => l.slice(0, w));
      const wb = rm.members.find(m => m.kind === 'attr' && m.key === 'walkbox');
      const x2 = wb && numValue(wb.values[2]);
      if (x2 != null && (x2 > w * 4 - 1 || x2 >= old * 4 - 5)) wb.values[2] = String(w * 4 - (old * 4 - 1 - x2) - 1);
      const wa = rm.members.find(m => m.kind === 'attr' && m.key === 'walkarea');
      wa?.values.forEach((v, k) => {
        const x = numValue(v);
        if (k % 2 === 0 && x != null && (x > w * 4 - 1 || x >= old * 4 - 5)) wa.values[k] = String(Math.max(0, w * 4 - (old * 4 - 1 - x) - 1));
      });
      for (const ba of rm.members.filter(m => m.kind === 'attr' && m.key === 'blockarea')) {   // the block areas: inside the place
        ba.values = ba.values.map((v, k) => (k % 2 === 0 && (numValue(v) ?? 0) > w * 4 - 1 ? String(w * 4 - 1) : v));
      }
      // the behind areas: one beyond the new right edge goes, one across it ends there
      const be = rm.members.find(m => m.kind === 'attr' && m.key === 'behind');
      if (be && w < old) {
        const keep = [];
        for (let k = 0; k + 3 < be.values.length; k += 4) {
          const r = be.values.slice(k, k + 4), col = numValue(r[0]) ?? 0;
          if (col >= w) continue;
          if (col + (numValue(r[2]) ?? 1) > w) r[2] = String(w - col);
          keep.push(...r);
        }
        if (keep.length) be.values = keep;
        else rm.members.splice(rm.members.indexOf(be), 1);
      }
      // the polygons: their corners beyond the new right edge come to it; one that covers no cell goes
      if (w < old) {
        for (const bp of rm.members.filter(m => m.kind === 'attr' && m.key === 'behindpoly')) {
          bp.values = bp.values.map((v, k) => (k % 2 === 0 && (numValue(v) ?? 0) > w ? String(w) : v));
          const pts = walkPoints(bp.values.map(v => numValue(v) ?? 0));
          if (!behindStrips(pts, w, 1000).length) rm.members.splice(rm.members.indexOf(bp), 1);
        }
      }
    }, { source: 'structure' });
    snackbar(tr('§0150', rm.name, w, w > PLACE_COLS ? '§1940' : ''), { action: 'Undo', onaction: () => store.undo() });
  };

  // open a place on the storyboard: its level, and its settings in the panel on the right -
  // unfolded when it was folded to its strip. null: the world, with the settings of the game
  A.openPlace = id => {
    store.enterPlace(id);
    store.select(id);
    setSideCollapsed(false);
  };

  A.addStart = () => {
    if (S().start) return store.select(S().start.id, { reveal: true });
    const start = newTop('start');
    store.mutate(() => insertItem(start, 'var'), { source: 'structure' });
    store.select(start.id, { reveal: true });
  };

  // a variable: global, or local to a place (placeId)
  A.addVar = placeId => {
    const place = placeId ? store.node(placeId) : null;
    const v = newTop('var', { name: uniqueName(game(), 'flag'), init: null });
    store.mutate(() => insertItem(v, 'var', place?.kind === 'place' ? place.members : game().items), { source: 'structure' });
  };

  // music or a sound: global, or of a place (placeId); file: a song of the Sound view, relative to the script
  A.addSong = (songKind, placeId, file) => {
    const place = placeId ? store.node(placeId) : null;
    const base = (file.split('/').pop() || songKind).replace(/\.\w+$/, '').replace(/\W+/g, '_').replace(/^(\d)/, '_$1') || songKind;
    const song = newTop('song', { songKind, name: uniqueName(game(), base === 'off' ? songKind : base, 'song'), file });
    store.mutate(() => {
      const items = place?.kind === 'place' ? place.members : game().items;
      if (items.some(x => x.kind === 'song')) insertItem(song, 'song', items);
      else if (items === game().items) insertItem(song, 'var', items);
      else { const at = items.findIndex(m => ['patch', 'enter', 'object', 'actor', 'place', 'sub'].includes(m.kind)); items.splice(at >= 0 ? at : items.length, 0, song); }
    }, { source: 'structure' });
    return song.name;
  };

  A.addSub = async areaId => {
    const v = await promptDialog({ title: tr('§0151'), icon: 'function', ok: '§0124',
      fields: [nameField('§1293', uniqueName(game(), 'sub'))] });
    if (!v) return;
    const sub = newTop('sub', { name: v.name });
    store.mutate(() => insertItem(sub, 'sub', scopeItems(areaId)), { source: 'structure' });
    store.select(sub.id, { reveal: true });
  };

  // a place without a screen gets the default background, walkbox and 'on enter'
  A.addScreen = async placeId => {
    const p = store.node(placeId);
    if (!p || hasScreen(p)) return;
    const v = await promptDialog({ title: tr('§1654', p.title || p.name), icon: 'wallpaper', ok: '§0124', fields: sizeFields() });
    if (!v || !store.node(placeId) || hasScreen(p)) return;
    const fresh = newPlace(p.name, S().charset, null, sizeOf(v));
    store.mutate(() => {
      for (let i = p.members.length - 1; i >= 0; i--) if (p.members[i].kind === 'attr' && p.members[i].key === 'width') p.members.splice(i, 1);   // the size is the one chosen
      p.members.unshift(...fresh.members);
      if (fresh.fullscreen) p.fullscreen = true; else delete p.fullscreen;
    }, { source: 'structure' });
    snackbar(tr('§0152', p.title || p.name), { action: 'Undo', onaction: () => store.undo() });
  };

  // move a place, sub, object or person into another place (null = top level)
  A.moveToPlace = (id, placeId) => {
    const n = store.node(id);
    const target = placeId ? store.node(placeId) : null;
    if (!n || (target && store.placePath(target.id).includes(n))) return;
    if (n.kind === 'place' && target) return snackbar('§1031', { error: true });
    if (target && ['object', 'actor'].includes(n.kind) && !hasScreen(target)) {
      snackbar(tr('§0153', target.title || target.name, n.name), { error: true });
      return;
    }
    if (isPlayable(n)) {                     // it stays an actor of the game: the place is where it starts
      store.mutate(g => { toTopLevel(g, n); setAttrOf(n, 'in', target ? [target.name] : null); }, { source: 'structure' });
      snackbar(target ? tr('§0154', n.name, target.title || target.name) : tr('§0155', n.name),
        { action: 'Undo', onaction: () => store.undo() });
      return;
    }
    const ok = store.mutate(g => {
      const loc = locate(g, id);
      const list = target ? target.members : g.items;
      if (!loc || loc.list === list) return false;
      loc.list.splice(loc.index, 1);
      walk({ items: [n] }, x => { delete x.src; delete x.fp; });   // written again with the new indentation
      n.blank = true;
      insertItem(n, n.kind, list);
    }, { source: 'structure' });
    if (ok === false) return;
    snackbar(tr('§0156', n.name, target ? target.title || target.name : '§1941'), { action: 'Undo', onaction: () => store.undo() });
  };

  A.moveMenu = (anchor, id) => {
    const n = store.node(id);
    const parent = store.info(id)?.parent;
    const needsScreen = ['object', 'actor'].includes(n.kind);
    // a playable character is not moved into a place: the menu says where it starts
    const playable = isPlayable(n), start = playable ? objectStartPlace(game(), n) : null;
    openMenu(anchor, [
      { header: playable ? tr('§0157', n.name) : tr('§0158', n.name) },
      playable ? { label: '§0159', icon: 'visibility_off', checked: !S().allPlaces.some(p => p.name === start), onclick: () => A.moveToPlace(id, null) }
        : { label: '§0160', icon: 'public', checked: parent?.kind !== 'place', onclick: () => A.moveToPlace(id, null) },
      ...S().allPlaces.filter(p => !store.placePath(p.id).includes(n) && (!needsScreen || hasScreen(p))).map(a => ({
        label: ' '.repeat(store.placePath(a.id).length - 1) + (a.title || a.name), icon: placeIcon(a),
        checked: playable ? a.name === start : parent === a, onclick: () => A.moveToPlace(id, a.id) })),
    ]);
  };

  // remove a place without a screen but keep the places and subs inside it
  A.ungroup = async id => {
    const n = store.node(id);
    if (n?.kind !== 'place' || hasScreen(n)) return;
    if (!(await confirmRemove({ what: tr('§1443', n.title || n.name), detail: '§1444', kind: 'ungroup', verb: 'remove' }))) return;
    const parent = store.info(id).parent;
    if (store.scope === id) store.enterPlace(parent?.kind === 'place' ? parent.id : null);
    store.mutate(g => {
      const loc = locate(g, id);
      if (!loc) return false;
      const keep = n.members.filter(m => m.kind === 'place' || m.kind === 'sub');
      walk({ items: keep }, x => { delete x.src; delete x.fp; });
      loc.list.splice(loc.index, 1, ...keep);
    }, { source: 'structure' });
    snackbar(tr('§0161', n.title || n.name), { action: 'Undo', onaction: () => store.undo() });
  };

  // --- the chapters: the groups of places that share a file on disk (advc/adv/disks.go) -----------
  const touch = n => { delete n.src; delete n.fp; };

  A.addChapter = async () => {
    const n = S().chapters.length + 1;
    const v = await promptDialog({ title: tr('§1033'), icon: 'auto_stories', ok: '§0124',
      text: 'A chapter is the group of places that share a file on disk. A place joins it in its panel.',
      fields: [nameField('§1034', uniqueName(game(), 'chapter' + n)),
        { name: 'title', label: '§1035', value: `Chapter ${n}`, validate: t => (t && t.length <= 40 ? null : '§1036') }] });
    if (!v) return null;
    const ch = { id: newTop('chapter').id, kind: 'chapter', name: v.name, title: v.title, disk: null, members: [], blank: true };
    store.mutate(() => insertItem(ch, 'chapter'), { source: 'structure' });
    store.select(ch.id, { reveal: true });
    return ch;
  };

  A.addDefault = async () => {
    const taken = new Set(S().defaults.map(d => d.verb));
    const free = actionVerbs(S()).filter(vb => !taken.has(vb.name));
    if (!free.length) return snackbar('§0162');
    const v = await promptDialog({ title: tr('§0163'), icon: 'rule', ok: '§0124',
      text: 'Runs when the player uses this verb on something without its own handler.',
      fields: [{ name: 'verb', label: 'Verb', value: free[0].name, options: free.map(vb => ({ value: vb.name, label: vb.text })) }] });
    if (!v) return;
    const d = newTop('default', { verb: v.verb });
    d.body.stmts.push(Object.assign(newStmt('say'), { text: "That doesn't work." }));
    store.mutate(() => insertItem(d, 'default'), { source: 'structure' });
    store.select(d.id, { reveal: true });
  };

  // statement with sensible arguments for its context
  A.makeStmt = (op, ownerId) => {
    const s = newStmt(op);
    const sym = S();
    const info = store.info(ownerId);
    const obj = info?.object;
    const place = info?.place ?? (obj && objectHome(game(), obj));
    if ('place' in s) s.place = sym.places.find(r => r !== place)?.name ?? sym.places[0]?.name ?? '';
    if (op === 'printvar') s.var = sym.vars[0]?.name ?? '';
    if (op === 'goto' && sym.noActors.has(s.place)) s.x = s.y = null;   // shown without actors: no position
    else if (op === 'goto') {
      const target = sym.places.find(r => r.name === s.place);
      const wb = target && getAttr(target, 'walkbox');
      if (wb) { s.x = String(numValue(wb[0]) + 16 || 40); s.y = wb[3]; }
      if (target && getAttr(target, 'walkarea')) [s.x, s.y] = walkSpot(target, 40, (gameRows(store.game) + 1) * 8 - 1).map(String);
    }
    if ('obj' in s) s.obj = obj?.name ?? sym.objects[0]?.name ?? '';
    if (op === 'place') s.place = place?.name ?? s.place;
    if (op === 'draw') s.patch = (place && place.members.find(m => m.kind === 'patch')?.name) ?? sym.patches[0]?.name ?? '';
    if (op === 'call' || op === 'run' || op === 'stopsub') s.sub = sym.subs[0]?.name ?? '';
    if (op === 'music' || op === 'sound') {                      // a song of the place first, then a global one
      const usable = sym.songs.filter(x => x.songKind === op && (!store.info(x.id)?.place || store.placePath(ownerId).includes(store.info(x.id).place)));
      s.song = (usable.find(x => store.info(x.id)?.place) ?? usable[0])?.name ?? (op === 'music' ? 'off' : '');
    }
    if (op === 'animate') {
      const actor = sym.actors.find(a => !a.attrs.some(x => x.key === 'playable')) ?? sym.actors[0];
      if (actor) Object.assign(s, { target: actor.name, anim: 'stand' });
      else s.target = sym.patchanims[0]?.name ?? '';
    }
    if (op === 'assign') {
      if (sym.vars.length) { s.target = sym.vars[0].name; s.expr = '1'; }
      else if (obj) { s.target = obj.name + '.state'; s.expr = '1'; }
    }
    if (op === 'if' && obj) s.branches[0].cond = `${obj.name}.state == 0`;
    if (op === 'while') s.cond = 'false';
    return s;
  };

  A.addStatement = (ref, op, index = null) => {
    const s = A.makeStmt(op, ref.owner);
    const ok = store.mutate(() => {
      const body = resolveBody(store, ref);
      if (!body) return false;
      body.stmts.splice(index ?? body.stmts.length, 0, s);
    }, { source: 'structure' });
    if (ok !== false) store.select(s.id, { focusStmt: s.id, reveal: true });
    return s;
  };

  // the groups of the statements (adv.js OPS) as headers of the menu
  const GROUP_LABELS = { Dialog: '§2024', Sound: '§2025', Actor: '§2026' };
  A.insertMenu = (anchor, ref, index = null) => {
    const groups = {};
    for (const [op, def] of Object.entries(OPS)) (groups[def.group] ??= []).push([op, def]);
    const items = [];
    for (const [group, ops] of Object.entries(groups)) {
      items.push({ header: GROUP_LABELS[group] ?? group });
      for (const [op, def] of ops) items.push({ label: def.label, icon: def.icon, onclick: () => A.addStatement(ref, op, index) });
    }
    openMenu(anchor, items);
  };

  A.addBranch = (stmtId, kind) => {
    store.mutate(() => {
      const s = store.node(stmtId);
      if (s.op === 'choose') s.options.push({ text: 'Something else?', cond: null, body: { stmts: [] } });
      else if (kind === 'else') s.else ??= { stmts: [] };
      else s.branches.push({ cond: 'true', body: { stmts: [] } });
    }, { source: 'structure' });
    store.select(stmtId, { focusStmt: stmtId });
  };

  A.removeBranch = async (stmtId, k) => {
    const s0 = store.node(stmtId);
    const body = !s0 ? null : s0.op === 'choose' ? s0.options[k]?.body : k === 'else' ? s0.else : s0.branches?.[k]?.body;
    const what = s0?.op === 'choose' ? tr('§1445', s0.options[k]?.text ?? k + 1) : k === 'else' ? '§1446' : tr('§1447', s0?.branches?.[k]?.cond ?? '');
    if (!(await confirmRemove({ what, detail: body ? removeDetail({ kind: 'branch', body }) : null, kind: 'branch', verb: 'remove' }))) return;
    store.mutate(() => {
      const s = store.node(stmtId);
      if (s.op === 'choose') {
        if (s.options.length < 2) return false;
        s.options.splice(k, 1);
      } else if (k === 'else') s.else = null;
      else if (s.branches.length > 1) s.branches.splice(k, 1);
      else return false;
    }, { source: 'structure' });
  };

  const describe = n => (n.name ? `${n.kind === 'stmt' ? n.op : n.kind} '${n.name}'` : n.kind === 'handler' ? tr('§0164', onName(n.verb), n.other ? `(${n.other})` : '') : n.kind === 'stmt' ? OPS[n.op].label.toLowerCase() : n.kind);

  // what goes with node n when it is deleted: the places, objects, layers, handlers and steps in it
  function removeDetail(n) {
    const count = {};
    if (n.kind === 'branch') walkBody(n.body, x => { count.stmt = (count.stmt ?? 0) + 1; });
    else walk({ items: [n] }, x => { if (x !== n) count[x.kind] = (count[x.kind] ?? 0) + 1; });
    const parts = [['place', '§1435'], ['object', '§1436'], ['actor', '§1437'], ['patch', '§1438'], ['handler', '§1439'], ['sub', '§1440'], ['stmt', '§1441']]
      .filter(([k]) => count[k]).map(([k, l]) => tr(l, count[k]));
    return parts.length ? tr('§1442', parts.join(', ')) : null;
  }

  // closePanel: removed from a list of the storyboard, the panel shows the game settings; removed in
  // the panel itself, a step leaves its handler open there. Asks first (confirmRemove) unless
  // confirmed; before() runs once it is answered, before the node goes; true when it is gone
  A.remove = async (id, { closePanel = false, confirmed = false, before = null } = {}) => {
    const n = store.node(id);
    if (!n || n.kind === 'game') return false;
    const label = describe(n);
    const what = n.kind === 'stmt' ? tr('§1494', tr(OPS[n.op].label)) : n.kind === 'patch' ? tr('§1495', n.name) : label;
    if (!confirmed && !(await confirmRemove({ what, detail: removeDetail(n), kind: 'node:' + n.kind }))) return false;
    if (store.node(id) !== n) return false;
    before?.();
    const parentOwner = store.info(id)?.owner;
    store.mutate(g => {
      const loc = locate(g, id);
      if (!loc) return false;
      loc.list.splice(loc.index, 1);
    }, { source: 'structure' });
    if (!closePanel && n.kind === 'stmt' && parentOwner && store.node(parentOwner.id)) store.select(parentOwner.id);
    else store.select(null);
    snackbar(tr('§0165', label), { action: 'Undo', onaction: () => store.undo() });
    return true;
  };

  A.duplicate = id => {
    const n = store.node(id);
    if (!n || ['game', 'start', 'enter'].includes(n.kind)) return;
    const copy = cloneFresh(n);
    store.mutate(g => {
      const rename = x => { if (x.name && x.kind !== 'stmt') x.name = uniqueName(g, x.name + '_copy'); };
      rename(copy);
      if (copy.kind === 'place') walk({ items: copy.members }, rename);
      if (copy.kind === 'handler') {
        const obj = store.info(id).object;
        const verbs = actionVerbs(S());
        const used = new Set(obj.handlers.map(h => h.verb + ' ' + (h.other || '')));
        const free = verbs.find(vb => !used.has(vb.name + ' '));
        if (!free) return false;
        copy.verb = free.name;
        copy.other = null;
      }
      const loc = locate(g, id);
      loc.list.splice(loc.index + 1, 0, copy);
    }, { source: 'structure' });
    store.select(copy.id, { focusStmt: copy.kind === 'stmt' ? copy.id : null, reveal: true });
  };

  A.move = (id, delta) => {
    store.mutate(g => {
      const loc = locate(g, id);
      const to = loc?.index + delta;
      if (!loc || to < 0 || to >= loc.list.length) return false;
      const [n] = loc.list.splice(loc.index, 1);
      loc.list.splice(to, 0, n);
    }, { source: 'structure' });
  };

  A.rename = async id => {
    const n = store.node(id);
    if (!n?.name) return;
    const v = await promptDialog({
      title: tr('§0816', n.kind), icon: 'edit', ok: '§0166',
      text: 'All references in the script are updated.',
      fields: [nameField('§0167', n.name, n.name, n.kind === 'patch' ? 'patch' : 'symbol')],
    });
    if (!v || v.name === n.name) return;
    const old = n.name;
    store.mutate(g => renameSymbol(g, old, v.name, n.kind), { source: 'structure' });
    snackbar(tr('§0168', old, v.name), { action: 'Undo', onaction: () => store.undo() });
  };

  // context menu for any storyboard card / inspector header
  A.nodeMenu = (anchor, id) => {
    // opened from the storyboard (a card's button, or a right click: a position): Delete closes the settings panel
    const fromBoard = !anchor?.closest?.('#inspector');
    if (id?.startsWith('group:')) {
      const group = id.slice(6);
      const map = { inventory: ['§0169', 'category', () => A.addObject(null)],
        actors: ['§0170', 'person_add', () => A.addActor(null)],
        subs: ['§0171', 'function', A.addSub], defaults: ['§0172', 'rule', A.addDefault] };
      if (group === 'shows') {
        const items = (what, fn) => Object.entries(SEQ_KINDS).map(([kind, d]) => ({ label: tr(what, tr(d.label)), icon: d.icon, onclick: () => fn(kind) }));
        return openMenu(anchor, [...(S().prolog ? [] : [...items('§1569', A.addProlog), { divider: true }]), ...items('§1570', A.addEpilog),
          ...(S().outro ? [] : [{ divider: true }, ...items('§1590', A.addOutro)])]);
      }
      if (!map[group]) return;                  // (the intro: its panel has it all)
      const [label, ic, fn] = map[group];
      return openMenu(anchor, [{ label, icon: ic, onclick: fn }]);
    }
    const n = store.node(id);
    if (!n) return;
    const items = [];
    const common = () => {
      if (n.name && ['place', 'object', 'actor', 'sub'].includes(n.kind)) items.push({ label: '§0173', icon: 'edit', onclick: () => A.rename(id) });
      if (!['game', 'start', 'enter'].includes(n.kind)) items.push({ label: '§0174', icon: 'content_copy', onclick: () => A.duplicate(id) });
      if (['place', 'sub', 'object', 'actor'].includes(n.kind) && ['game', 'place'].includes(store.info(id)?.parent?.kind)) {
        items.push({ label: '§0175', icon: 'drive_file_move', onclick: () => A.moveMenu(anchor, id) });
      }
      if (n.kind !== 'game') {
        items.push({ label: '§0176', icon: 'arrow_upward', onclick: () => A.move(id, -1) },
          { label: '§0177', icon: 'arrow_downward', onclick: () => A.move(id, 1) });
        items.push({ divider: true }, { label: 'Delete', icon: 'delete', danger: true, kbd: 'Del', onclick: () => A.remove(id, { closePanel: fromBoard }) });
      }
    };
    switch (n.kind) {
      case 'game':
        items.push({ label: '§0178', icon: 'add_location_alt', onclick: () => A.addPlace(null) },
          { label: '§0169', icon: 'category', onclick: () => A.addObject(null) },
          { label: '§0170', icon: 'person_add', onclick: () => A.addActor(null) },
          { label: '§0171', icon: 'function', onclick: A.addSub },
          { label: '§0172', icon: 'rule', onclick: A.addDefault });
        if (!S().start) items.push({ label: '§0179', icon: 'play_circle', onclick: A.addStart });
        break;
      case 'place':
        items.push({ label: 'Open', icon: 'arrow_forward', onclick: () => A.openPlace(id) });
        if (hasScreen(n)) {
          items.push({ label: '§0180', icon: 'wallpaper', onclick: () => A.openScreen(id) },
            { label: '§0181', icon: 'add_location_alt', onclick: () => A.addExitObject(id) },
            { label: '§0182', icon: 'person_add', onclick: () => A.addActor(id) });
          if (!n.members.some(m => m.kind === 'enter')) items.push({ label: '§0183', icon: 'login', onclick: () => A.addEnter(id) });
        } else {
          items.push({ label: '§0184', icon: 'wallpaper', onclick: () => A.addScreen(id) },
            { label: '§0185', icon: 'folder_off', onclick: () => A.ungroup(id) });
        }
        items.push({ label: '§0186', icon: 'add_location_alt', onclick: () => A.addPlace(id) },
          { label: '§0187', icon: 'function', onclick: () => A.addSub(id) });
        items.push({ divider: true });
        common();
        break;
      case 'object':
      case 'actor':
        items.push({ label: '§0188', icon: 'bolt', onclick: () => A.addHandler(id) }, { divider: true });
        common();
        break;
      case 'stmt':
        if (n.op === 'choose') {
          items.push({ label: '§0189', icon: 'add_comment', onclick: () => A.addBranch(id, 'option') }, { divider: true });
        }
        if (n.op === 'if') {
          items.push({ label: '§0190', icon: 'alt_route', onclick: () => A.addBranch(id, 'elseif') });
          if (!n.else) items.push({ label: '§0191', icon: 'call_split', onclick: () => A.addBranch(id, 'else') });
          items.push({ divider: true });
        }
        items.push({ label: '§0192', icon: 'playlist_add', onclick: () => {
          const info = store.info(id);
          const ownerId = info.parent.id;
          const loc = locate(game(), id);
          const p = info.parent;
          const branch = p.kind !== 'stmt' ? undefined
            : p.op === 'if' ? (p.else?.stmts === loc.list ? 'else' : p.branches.findIndex(b => b.body.stmts === loc.list))
            : p.op === 'choose' ? p.options.findIndex(o => o.body.stmts === loc.list)
            : undefined;
          A.insertMenu(anchor, { owner: ownerId, branch }, loc.index + 1);
        } });
        common();
        break;
      default: // handler, enter, start, sub, default
        items.push({ label: '§0193', icon: 'playlist_add', onclick: () => A.insertMenu(anchor, { owner: id }) }, { divider: true });
        common();
    }
    openMenu(anchor, items);
  };

  return A;
}
