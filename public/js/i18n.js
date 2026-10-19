// i18n.js - the languages of the editor's UI: English and German. The game is not
// translated - its texts, names and the script stay as they are.
//
// The sources name the texts by numbered labels, '§0123', whose texts are in lang/en/ and
// lang/de/: '§0123': 'Save'. A text with values is a pattern - '§0456': 'Moved {0} to {1}' -
// that the code hands its values: t('§0456', name, place). '{1?a:b}' is a when value 1 is empty,
// else b - the plural a language makes with a value: '{0} Objekt{1?:e}'. Values that are texts
// (labels too) are translated as well, those in quotes (“{0}”, a title of the game) not.
//
// The texts are translated where they become elements: h() of pui.js hands every text child
// and the attributes of TEXT_ATTRS to t(), so the panels, menus, dialogs and tooltips need no
// call of their own: a label in a text is replaced by its text in the language, in English too.
// A label a language has no text for is English.
//
// The older form is still read: a text of the sources that is English (the texts that are data
// as well - messages of the compiler, texts compared or written into the game) is looked up by
// that English text in the dictionary of de, with patterns of {} for its parts:
//   'Moved {} to {}': '{0} nach {1} verschoben'
// A text that is not in the dictionary stays English. The language is a signal, but t() does
// not subscribe to it: a component that reads a signal is rendered again only when a signal or
// its props change (the signals of Preact), and the editors keep their state elsewhere. When
// the language changes the mounted views are made anew instead (pui.js: mount). A start takes the
// language of the system (systemLang); the menu changes it for the session of the tab.

import { signal } from '../vendor/signals.js';
import en from './lang/en/index.js';
import de from './lang/de/index.js';

export const LANGUAGES = [{ value: 'en', label: 'English' }, { value: 'de', label: 'Deutsch' }];
const DICTS = { de };
export const TEXT_ATTRS = ['data-tip', 'placeholder', 'aria-label', 'title'];

// the language of the system - the language the browser prefers first, which follows the system:
// German ('de', 'de-AT' ...) is German, every other language English
export function systemLang() {
  const first = typeof navigator === 'undefined' ? '' : navigator.languages?.[0] || navigator.language || '';
  return /^de\b/i.test(first) ? 'de' : 'en';
}

// the language picked in the menu lives in the session (sessionStorage): a reload of the tab keeps
// it, a new tab or a new start of the browser takes the system's again
const SESSION_KEY = 'yopaca-lang';

function initial() {
  // an older editor kept the language picked in the menu for good: now only for the session
  try { localStorage.removeItem('adv-lang'); } catch { /* private mode, no storage */ }
  // ?lang=de in the address: for this visit (tools/uicheck.mjs, tools/screenshots.mjs)
  const asked = typeof location !== 'undefined' && /[?&]lang=(\w+)/.exec(location.search + location.hash)?.[1];
  if (LANGUAGES.some(l => l.value === asked)) return asked;
  let picked = null;
  try { picked = sessionStorage.getItem(SESSION_KEY); } catch { /* no storage */ }
  return LANGUAGES.some(l => l.value === picked) ? picked : systemLang();
}

export const lang = signal(initial());

// a pattern as a regular expression: {} is any text, the rest is literal
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const compiled = new Map();                 // language -> { exact: Map, patterns: [[RegExp, text]], cache: Map }
function dict(code) {
  if (!DICTS[code]) return null;
  if (!compiled.has(code)) {
    const exact = new Map(), patterns = [];
    for (const [key, text] of Object.entries(DICTS[code])) {
      if (LABEL.test(key)) continue;            // a label: its text is looked up by it (resolve)
      // a pattern that says little ('in {}') takes only short parts - a name, a number - not a sentence
      if (key.includes('{}')) {
        const bits = key.split('{}');
        // a part in quotes (“{}”) is a text of the game, a title: it stays as it is
        const quoted = bits.slice(0, -1).map((b, k) => b.endsWith('“') && bits[k + 1].startsWith('”'));
        patterns.push([new RegExp('^' + bits.map(escape).join('([\\s\\S]*?)') + '$'), text, key.replace(/\{\}/g, '').trim().length < 8, key.replace(/\{\}/g, '').length, key.includes(' · '), quoted, key.endsWith(': {}')]);
      } else exact.set(key, text);
    }
    // the pattern with more fixed text first: it says more ('the game starts in {}' before
    // '{} starts in {}', whose parts would take the words of the other)
    patterns.sort((a, b) => b[3] - a[3]);
    compiled.set(code, { exact, patterns, cache: new Map() });
  }
  return compiled.get(code);
}

// texts that were asked for and are not in the dictionary (tools/uicheck.mjs lists them) - not a
// text with labels in it (they are resolved after the lookup), nor one t() made itself
export const missing = new Set();
const made = new Set();
const madeBy = text => { if (made.size > 5000) made.clear(); made.add(text.trim()); return text; };

function lookup(d, text, depth) {
  const key = text.trim();
  if (!key || !/[A-Za-z]{2}/.test(key)) return text;
  if (d.cache.has(text)) return d.cache.get(text);
  let out = null;
  // a pattern; dotted: whether its parts may be lines of facts themselves ('a · b')
  const byPattern = dotted => {
    // a short pattern's parts are short - but for a message after its prefix ('line {}: {}')
    for (const [re, to, short, , lineOfFacts, quoted, freeTail] of d.patterns) {
      const m = re.exec(key);
      if (!m || (short && m.slice(1, freeTail ? -1 : undefined).some(p => p.length > 24))) continue;
      if (m.slice(1).some(p => p.includes(' · ')) && !(dotted && lineOfFacts)) continue;
      const parts = m.slice(1).map((p, k) => (quoted[k] ? p : lookup(d, p, depth + 1)));
      return text.replace(key, () => to.replace(/\{(\d)\?([^:}]*):([^}]*)\}/g, (_, n, none, some) => (m[+n + 1] ? some : none))
        .replace(/\{(\d)\}/g, (_, n) => parts[n] ?? ''));
    }
    return null;
  };
  if (d.exact.has(key)) out = text.replace(key, () => d.exact.get(key));
  else if (depth < 3) out = byPattern(false);
  // 'place · 3 objects · 1 person': the parts of a line of facts, each a text of its own - before
  // a pattern could take several of them as one of its parts ('shown without actors · 3' of '{} objects')
  if (out == null && depth <= 2 && key.includes(' · ')) {
    const parts = key.split(' · '), turned = parts.map(p => lookup(d, p, depth + 1));
    if (turned.some((p, k) => p !== parts[k])) out = text.replace(key, () => turned.join(' · '));
  }
  // a pattern that is a line of facts itself, whose parts are such lines too
  if (out == null && depth < 3 && key.includes(' · ')) out = byPattern(true);
  // 'LABEL — HINT', 'A SENTENCE (key 2)': a tooltip put together of two texts, each one of its own
  const two = out == null && depth <= 1 && (/^(.+?) (—) (.+)$/.exec(key) || /^(.*\S) ()(\([^()]*\))$/.exec(key));
  if (two) {
    const a = lookup(d, two[1], depth + 1), b = lookup(d, two[3], depth + 1);
    if (a !== two[1] || b !== two[3]) out = text.replace(key, () => `${a} ${two[2] ? two[2] + ' ' : ''}${b}`);
  }
  if (out == null && depth === 0 && /[A-Za-z]{3}/.test(key) && !key.includes('§') && !made.has(key)) missing.add(key);
  d.cache.set(text, out ?? text);
  if (d.cache.size > 20000) d.cache.clear();
  return out ?? text;
}

// a label, and the labels in a text
const LABEL = /^§\d{4}$/, LABELS = /§\d{4}/g;
export const isLabel = text => typeof text === 'string' && LABEL.test(text);

// the text of a label in a language: its own, else the English one (and the label noted as missing)
function textOf(label, code) {
  const own = code === 'en' ? null : DICTS[code]?.[label];
  if (own == null && code !== 'en' && en[label] != null) missing.add(label);
  return own ?? en[label] ?? label;
}

// a pattern with its values: {0} the value, {0?a:b} a when the value is empty, else b. Values that
// are texts are translated, those the English pattern has in quotes (“{0}”) not
function fill(label, code, values) {
  const pattern = textOf(label, code), quoted = new Set([...(en[label] ?? '').matchAll(/“\{(\d)\}”/g)].map(m => +m[1]));
  const parts = values.map((v, k) => (typeof v === 'string' && !quoted.has(k) ? t(v) : v));
  return pattern.replace(/\{(\d)\?([^:}]*):([^}]*)\}/g, (_, n, none, some) => (parts[n] != null && parts[n] !== '' ? some : none))
    .replace(/\{(\d)\}/g, (_, n) => (parts[n] == null ? '' : String(parts[n])));
}

// the text in the language of the editor: a label with the values of its pattern, a text with labels
// in it, or an English text of the older form (its parts are looked up in the dictionary)
export function t(text, ...values) {
  if (typeof text !== 'string') return text;
  const code = lang.peek();
  if (values.length && LABEL.test(text)) return madeBy(fill(text, code, values));
  let out = text;
  if (code !== 'en' && /[A-Za-z]{2}/.test(text)) {
    const d = dict(code);
    if (d) out = lookup(d, text, 0);
    if (out !== text) madeBy(out);
  }
  return out.includes('§') ? madeBy(out.replace(LABELS, l => textOf(l, code))) : out;
}
// only the labels of a text, nothing else of it looked up: the text of an icon, a token of the
// script - what h() does not translate - may still be a label (a tip of an icon, a word of a card)
export const labelsOnly = text => (typeof text === 'string' && text.includes('§') ? text.replace(LABELS, l => textOf(l, lang.peek())) : text);

// t under the name the sources call it with: a code that names a variable t (a tool, a target) still reaches it
export const tr = t;

// the elements that were not made by h(): the page of index.html. The English text stays in
// the node, so the language can change again
const sources = new WeakMap();
const SKIP = 'msr';
export function translateDom(root = document.body) {
  const walk = el => {
    if (el.classList?.contains(SKIP) || el.dataset?.i18n === 'off') return;
    // what was written last is remembered with the English text: a text the page set anew is a new source
    const turn = (holder, key, now, write) => {
      const was = holder.get(key);
      const src = was && was.shown === now ? was.src : now, shown = t(src);
      holder.set(key, { src, shown });
      if (shown !== now) write(shown);
    };
    for (const a of TEXT_ATTRS) {
      if (!el.hasAttribute?.(a)) continue;
      if (!sources.has(el)) sources.set(el, new Map());
      turn(sources.get(el), a, el.getAttribute(a), v => el.setAttribute(a, v));
    }
    for (const n of el.childNodes) {
      if (n.nodeType === 1) walk(n);
      else if (n.nodeType === 3 && n.nodeValue.trim()) {
        if (!sources.has(n)) sources.set(n, new Map());
        turn(sources.get(n), 'text', n.nodeValue, v => { n.nodeValue = v; });
      }
    }
  };
  walk(root);
}

// the language picked in the menu: for the session of the tab
export function setLang(code) {
  if (!LANGUAGES.some(l => l.value === code) || code === lang.value) return;
  try { sessionStorage.setItem(SESSION_KEY, code); } catch { /* no storage: until the page is loaded again */ }
  lang.value = code;
  if (typeof document !== 'undefined') document.documentElement.lang = code;
}
