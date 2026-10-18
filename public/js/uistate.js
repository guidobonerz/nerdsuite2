// uistate.js - what a reload of the tab keeps besides the address (app.js: the routes name the
// view and the place, sprite or file open in it): the pan and zoom of the storyboard, the node
// selected, the tools, pens and zoom of the editors, the caret of the source and the scroll
// positions of the canvases and panels.
//
// The parts register what they keep (keepUi); the state is written to the tab's session
// (sessionStorage) when the page goes away and given back once the project is open again - only
// for the same script, the parts get nothing for another one. Nothing of it reaches a game file.

import { walk } from './adv.js';

const KEY = 'yopaca-ui';
const parts = new Map();          // name -> { save() -> plain data, load(data) }

export function keepUi(name, part) { parts.set(name, part); }

// --- the selection: a node by its place in the game (ids are new after every load) --------------

// a node by its position in the walk of the game, its kind and name and the names of the nodes
// around it: the same position when the script is the same, else the node of that kind and name
// in the same surroundings (the session may hold other edits than the moment of the reload)
const around = (parents, n) => { const out = []; for (let p = parents.get(n); p && p.kind !== undefined; p = parents.get(p)) out.push(`${p.kind}:${p.name ?? ''}`); return out.join('/'); };
function walked(game) {
  const list = [], parents = new Map();
  walk(game, (n, p) => { list.push(n); parents.set(n, p); });
  return { list, parents };
}
export function nodeRef(game, id) {
  if (!game || !id) return null;
  const { list, parents } = walked(game);
  const i = list.findIndex(n => n.id === id);
  if (i < 0) return null;
  const n = list[i];
  return { i, kind: n.kind, name: n.name ?? null, op: n.op ?? null, around: around(parents, n) };
}
export function nodeOf(game, ref) {
  if (!game || !ref) return null;
  const { list, parents } = walked(game);
  const same = n => n.kind === ref.kind && (n.name ?? null) === ref.name && (n.op ?? null) === (ref.op ?? null);
  if (list[ref.i] && same(list[ref.i]) && around(parents, list[ref.i]) === ref.around) return list[ref.i];
  const like = list.filter(n => same(n) && around(parents, n) === ref.around);
  if (ref.name != null || like.length === 1) return like[0] ?? null;
  return like.sort((a, b) => Math.abs(list.indexOf(a) - ref.i) - Math.abs(list.indexOf(b) - ref.i))[0] ?? null;   // the nearest of its kind
}

// --- scroll positions: the scrolled elements of the open view, the panel and the side panels ----

const ROOTS = ['#inspector', '[id^="view-"]'];
// a path of the element from the nearest ancestor with an id, by child positions
function pathOf(el) {
  const steps = [];
  for (let e = el; e && e !== document.body; e = e.parentElement) {
    if (e.id) { steps.unshift('#' + CSS.escape(e.id)); return steps.join(' > '); }
    steps.unshift(`${e.tagName.toLowerCase()}:nth-child(${[...e.parentElement.children].indexOf(e) + 1})`);
  }
  return null;
}
function scrolled() {
  const out = [];
  for (const root of ROOTS) {
    for (const el of document.querySelectorAll(`${root}, ${root} *`)) {
      if (el.closest('[hidden]') || (!el.scrollTop && !el.scrollLeft)) continue;
      const path = pathOf(el);
      if (path && !out.some(x => x.path === path)) out.push({ path, top: el.scrollTop, left: el.scrollLeft });
    }
  }
  return out;
}
// the panels fill in over a few frames: tried again until each one is where it was (or 1.5 s)
function scrollBack(list) {
  let left = list.filter(Boolean), tries = 0;
  const step = () => {
    left = left.filter(s => {
      const el = document.querySelector(s.path);
      if (!el) return true;
      el.scrollTop = s.top;
      el.scrollLeft = s.left;
      el.dispatchEvent(new Event('scroll'));             // a code area moves its highlight and gutter along
      return Math.abs(el.scrollTop - s.top) > 1 || Math.abs(el.scrollLeft - s.left) > 1;
    });
    if (left.length && ++tries < 90) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// --- save and load ------------------------------------------------------------------------------

export function saveUi(script) {
  if (!script) return;
  const state = { script, parts: {}, scroll: scrolled() };
  for (const [name, part] of parts) {
    try { state.parts[name] = part.save(); } catch { /* a part that cannot say: it starts anew */ }
  }
  try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode, or too big */ }
}

// the state kept for this script: the parts get theirs, then the scroll positions follow
export function loadUi(script) {
  let state = null;
  try { state = JSON.parse(sessionStorage.getItem(KEY) ?? 'null'); } catch { /* none */ }
  if (!state || state.script !== script) return false;
  for (const [name, part] of parts) {
    if (state.parts?.[name] == null) continue;
    try { part.load(state.parts[name]); } catch { /* it starts anew */ }
  }
  scrollBack(state.scroll ?? []);
  return true;
}

// written when the page goes away: a reload, a closed tab, another app in front
export function watchUi(script) {
  const save = () => saveUi(script());
  addEventListener('pagehide', save);
  addEventListener('beforeunload', save);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });
}

// a few plain fields of an editor's state, and back
export const pick = (st, keys) => Object.fromEntries(keys.filter(k => st[k] !== undefined).map(k => [k, structuredClone(st[k])]));
export const put = (st, data, keys) => { for (const k of keys) if (data[k] !== undefined) st[k] = data[k]; };
