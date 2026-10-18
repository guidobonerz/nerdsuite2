// panelsearch.js - the search of the header in the panel of the view: the game settings and the
// inspector of the story, the side panel of an editor. The sections of the panel whose text has
// the search text stay, open; the others are hidden while it is searched; the matches are marked
// (::highlight(panel-search), the elements stay as they are). Nothing matches: every section
// stays. The panels are drawn by Preact again and again: a MutationObserver applies the search
// to what they draw next.
//
// A section matches by its text, the values of its fields and the option chosen in its selects.

const HIGHLIGHT = 'panel-search';
let panel = null;            // the element of the panel searched
let query = '';
let observer = null;
let frame = 0;
let last = { hits: 0, sections: 0 };

// the sections of the panel at its top, not those inside another section. root: the inspector of
// the story, or the element of an editor's view - its side panel is searched (.side__content)
function sections(root) {
  const scope = root.querySelector('.side__content') ?? root;
  return [...scope.querySelectorAll('.section')].filter(s => { const p = s.parentElement.closest('.section'); return !p || !scope.contains(p); });
}

// what a section says: its text and the values of its fields
function textOf(el) {
  let t = el.textContent;
  for (const f of el.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]), textarea')) t += ' ' + f.value;
  for (const s of el.querySelectorAll('select')) t += ' ' + (s.selectedOptions[0]?.textContent ?? '');
  return t.toLowerCase();
}

// the ranges of the search text in the text nodes under el
function ranges(el, q) {
  const out = [];
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: n => (n.parentElement?.closest('script, style, .msr, [hidden]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const s = n.data.toLowerCase();
    for (let at = s.indexOf(q); at >= 0; at = s.indexOf(q, at + q.length)) {
      const r = new Range();
      r.setStart(n, at);
      r.setEnd(n, at + q.length);
      out.push(r);
    }
  }
  return out;
}

function clear(root) {
  if (!root) return;
  root.classList.remove('panel-searching');
  for (const s of root.querySelectorAll('.section--search-hit, .section--search-miss')) s.classList.remove('section--search-hit', 'section--search-miss');
}

function apply() {
  frame = 0;
  if (typeof CSS !== 'undefined' && CSS.highlights) CSS.highlights.delete(HIGHLIGHT);
  if (!panel || !panel.isConnected) { last = { hits: 0, sections: 0 }; return; }
  const q = query.trim().toLowerCase();
  const list = sections(panel);
  if (!q) { clear(panel); last = { hits: 0, sections: list.length }; return; }
  const hits = list.filter(s => textOf(s).includes(q));
  last = { hits: hits.length, sections: list.length };
  if (!hits.length) { clear(panel); return; }      // nothing matches: the panel stays as it is
  observer?.disconnect();                          // the classes are ours: not a change to search again
  panel.classList.add('panel-searching');
  for (const s of list) {
    const hit = hits.includes(s);
    s.classList.toggle('section--search-hit', hit);
    s.classList.toggle('section--search-miss', !hit);
  }
  observe();
  if (typeof CSS !== 'undefined' && CSS.highlights) {
    const all = hits.flatMap(s => ranges(s, q));
    if (all.length) CSS.highlights.set(HIGHLIGHT, new Highlight(...all));
  }
  hits[0].scrollIntoView?.({ block: 'nearest' });
}

const later = () => { if (!frame) frame = requestAnimationFrame(apply); };

function observe() {
  if (!panel) return;
  observer ??= new MutationObserver(later);
  observer.observe(panel, { childList: true, subtree: true });      // not characterData: a status line that changes with the pointer is no new panel
}

// the panel to search (null: none) and the text; the panel searched before is left as it was
export function searchPanel(el, text) {
  if (el !== panel) {
    observer?.disconnect();
    clear(panel);
    panel = el;
  }
  query = text ?? '';
  if (!panel) { if (typeof CSS !== 'undefined' && CSS.highlights) CSS.highlights.delete(HIGHLIGHT); return; }
  observe();
  apply();
}

// how the last search went: the sections that match, of all (for the tests)
export const panelSearchState = () => ({ ...last });
