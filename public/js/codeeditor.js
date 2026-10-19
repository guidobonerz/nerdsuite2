// codeeditor.js - the code surface of nerdsuite: a source text with line numbers, the colours of
// its language, the lines of errors marked, breakpoints in the gutter, the line the CPU stopped at
// and suggestions at the caret (autocompletion).
//
// The same technique as yopaca's codearea.js: the colours lie *behind* the text - a <pre> holds the
// coloured tokens and a transparent <textarea> lies on top of it, so typing, selecting, undo, the
// caret and the clipboard are the browser's own. Both layers have the same metrics (app.css,
// .code-view) and scroll together.
//
// The language (lang-acme.js, lang-basic.js) gives
//   highlight(text)        -> the children of the <pre>: strings and <span class="tok-...">
//   complete(text, caret)  -> { from, to, items: [{ label, insert?, kind, hint?, detail? }] } or null
//   comment                -> the line comment (';' for assembler, 'rem ' for BASIC), for Ctrl+/
//   autoTrigger(ch)        -> true when typing ch should open the list at once ('!', '{', '+')
//   collapse(text, caret)  -> { from, to, insert } what was just typed in its short form (BASIC: a {code} as
//                             one character per byte), or null
//   copyText(text)         -> the selection as the clipboard holds it; pasteText(text, at, pasted) the other way

import { h, useRef, useState, useLayoutEffect, icon, floater } from './pui.js';
import { buildBitmapFont } from './bitfont.js';

const KIND_ICON = {
  mnemonic: 'cpu', pseudo: 'bolt', label: 'label', macro: 'function', keyword: 'code', code: 'tag',
  line: 'list', const: 'tag', cpu: 'cpu', zone: 'folder',
};
const MAX_SHOWN = 100;

// --- the C64 font in the code: the bytes of BASIC strings (U+EE00 + byte, lang-basic.js) are drawn
// with it, in the textarea as 'PETSCII Column' (the code font has no glyph for them, the next of the
// family, nerdsuite.css, is the C64 font made as small as one column) and in the coloured layer as
// 'PETSCII Glyph' (app.css .tok-petscii, at 1ch). Both get the ascent and the descent of the code font,
// so a row is as high as every other whatever font draws its characters. Measured once the code font
// is there, whichever font that is (the Settings choose it: --code-font); each face is measured again and
// corrected once, for a browser that applies size-adjust to the overrides otherwise than assumed.
// measureCodeFont() again after the code font changed (settings.js)
const faces = [];
let measuring = 0;
export function measureCodeFont() {
  if (typeof document === 'undefined' || typeof FontFace === 'undefined') return;
  const run = ++measuring;                                       // a later call wins
  for (const f of faces.splice(0)) document.fonts.delete(f);
  const root = getComputedStyle(document.documentElement);
  const mono = root.getPropertyValue('--code-font').trim() || root.getPropertyValue('--md-font-mono').trim() || 'monospace';
  const src = `url(${new URL('../fonts/C64_Pro_Mono-STYLE.woff2', import.meta.url)}) format("woff2")`;
  // width, ascent and descent of a text in em
  const metrics = (family, text) => {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `100px ${family}`;
    const m = ctx.measureText(text);
    return { width: m.width / 100, ascent: m.fontBoundingBoxAscent / 100, descent: m.fontBoundingBoxDescent / 100 };
  };
  // a face with the ascent and the descent (in em of the size it is used at) of the code font
  const addFace = async (name, range, size, ascent, descent) => {
    const make = (a, d) => new FontFace(name, src, { unicodeRange: range, sizeAdjust: `${(size * 100).toFixed(4)}%`,
      ...(Number.isFinite(a) && Number.isFinite(d) ? { ascentOverride: `${(a * 100).toFixed(4)}%`, descentOverride: `${(d * 100).toFixed(4)}%`, lineGapOverride: '0%' } : {}) });
    let face = make(ascent / size, descent / size);
    document.fonts.add(face);
    await face.load();
    if (run !== measuring) { document.fonts.delete(face); return; }
    const got = metrics(`"${name}"`, '');
    if (Number.isFinite(ascent) && got.ascent > 0 && got.descent > 0 && (Math.abs(got.ascent - ascent) > 0.002 || Math.abs(got.descent - descent) > 0.002)) {
      document.fonts.delete(face);
      face = make(ascent / size * ascent / got.ascent, descent / size * descent / got.descent);
      document.fonts.add(face);
      await face.load();
      if (run !== measuring) { document.fonts.delete(face); return; }
    }
    faces.push(face);
  };
  document.fonts.load(`100px ${mono}`).catch(() => {}).then(() => {
    const code = metrics(mono, 'x'.repeat(10));
    const ratio = code.width / 10;                               // one column in em
    addFace('PETSCII Column', 'U+EE00-EEFF', ratio, code.ascent, code.descent).catch(() => {});
    addFace('PETSCII Glyph', 'U+EE00-EFFF', 1, code.ascent / ratio, code.descent / ratio).catch(() => {});
    if (Number.isFinite(code.ascent) && Number.isFinite(code.descent)) glyphLine = { ascent: code.ascent / ratio, descent: code.descent / ratio };
    customFace();
  });
}

// --- a charset of the project in the strings: its characters as a font of their own, 'PETSCII Custom'
// (bitfont.js), at U+EE00 + screen code like the C64 font, with the line of the code font. app.css
// draws the glyphs with it first: without a custom charset there is no such face and the C64 font draws.
// setCustomGlyphs(bytes) with the 2048 bytes of a charset, null: the C64 font again
let glyphLine = { ascent: 1, descent: 0.25 }, customBytes = null, custom = null, customRun = 0;
export function setCustomGlyphs(bytes) {
  customBytes = bytes;
  customFace();
}
function customFace() {
  if (typeof document === 'undefined' || typeof FontFace === 'undefined') return;
  const run = ++customRun;
  const drop = () => { if (custom) { document.fonts.delete(custom); custom = null; } };
  if (!customBytes) { drop(); return; }
  const { ascent, descent } = glyphLine;
  const face = new FontFace('PETSCII Custom', buildBitmapFont(customBytes, { ascent, descent }), {
    unicodeRange: 'U+EE00-EEFF', ascentOverride: `${(ascent * 100).toFixed(4)}%`, descentOverride: `${(descent * 100).toFixed(4)}%`, lineGapOverride: '0%' });
  face.load().then(() => {
    if (run !== customRun) return;
    drop();
    document.fonts.add(face);
    custom = face;
  }, e => console.warn('the glyphs of the charset are no font:', e));
}
measureCodeFont();

// --- zoom: Ctrl+wheel makes the code larger or smaller, Ctrl+0 gives it its own size again; every
// code editor follows (--code-zoom on the root, nerdsuite.css), the factor is remembered
const ZOOM_KEY = 'ns-code-zoom', MIN_ZOOM = 0.6, MAX_ZOOM = 3;
let zoom = (() => { try { return Number(localStorage.getItem(ZOOM_KEY)) || 1; } catch { return 1; } })();
const applyZoom = () => document.documentElement.style.setProperty('--code-zoom', String(zoom));
if (typeof document !== 'undefined') applyZoom();
// the new factor, the area kept at the same line on top
function setZoom(next, ta) {
  next = Math.round(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next)) * 100) / 100;
  if (next === zoom) return;
  const lh = ta ? parseFloat(getComputedStyle(ta).lineHeight) : 0, top = lh ? ta.scrollTop / lh : 0;
  zoom = next;
  applyZoom();
  try { if (zoom === 1) localStorage.removeItem(ZOOM_KEY); else localStorage.setItem(ZOOM_KEY, String(zoom)); } catch { /* private mode */ }
  if (lh) ta.scrollTop = top * parseFloat(getComputedStyle(ta).lineHeight);
}

// the line and the column (1 based) of an offset
export function caretAt(text, caret) {
  const before = text.slice(0, caret);
  const line = before.split('\n').length;
  return { line, col: caret - before.lastIndexOf('\n') };
}

// the offset where a line (1 based) starts
export function lineStart(text, line) {
  let at = 0;
  for (let k = 1; k < line; k++) {
    const nl = text.indexOf('\n', at);
    if (nl < 0) return text.length;
    at = nl + 1;
  }
  return at;
}

// the width of one character of the element, measured
function charWidth(el) {
  const probe = document.createElement('span');
  const cs = getComputedStyle(el);
  probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font-family:${cs.fontFamily};font-size:${cs.fontSize};letter-spacing:${cs.letterSpacing}`;
  probe.textContent = 'x'.repeat(100);
  document.body.append(probe);
  const w = probe.getBoundingClientRect().width / 100;
  probe.remove();
  return w;
}

// the rectangle of the caret in the window, for the list of suggestions
function caretRect(ta, text, caret) {
  const { line, col } = caretAt(text, caret);
  const cs = getComputedStyle(ta);
  const r = ta.getBoundingClientRect();
  const lineH = parseFloat(cs.lineHeight);
  const padL = parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
  const padT = parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth);
  const lineText = text.split('\n')[line - 1] ?? '';
  const column = lineText.slice(0, col - 1).replace(/\t/g, '    ').length;
  const x = r.left + padL - ta.scrollLeft + column * charWidth(ta);
  const y = r.top + padT - ta.scrollTop + (line - 1) * lineH;
  const top = Math.max(r.top, Math.min(y, r.bottom - lineH));
  return { left: Math.max(r.left, Math.min(x, r.right - 8)), top, bottom: top + lineH, right: r.right, width: 0 };
}

// the offset of the text under a point of the window (a right click: the caret does not move there
// by itself), tabs as four columns
function offsetAt(ta, x, y) {
  const cs = getComputedStyle(ta);
  const r = ta.getBoundingClientRect();
  const lineH = parseFloat(cs.lineHeight);
  const padL = parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
  const padT = parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth);
  const lines = ta.value.split('\n');
  const line = Math.max(0, Math.min(lines.length - 1, Math.floor((y - r.top - padT + ta.scrollTop) / lineH)));
  const col = (x - r.left - padL + ta.scrollLeft) / charWidth(ta);
  const l = lines[line];
  let k = 0;
  for (let vis = 0; k < l.length; k++) {
    const w = l[k] === '\t' ? 4 : 1;
    if (vis + w / 2 > col) break;
    vis += w;
  }
  return lineStart(ta.value, line + 1) + k;
}

// scroll a line into the middle of the area when it is not in view
export function revealLine(ta, line, { select = false, text = ta?.value } = {}) {
  if (!ta) return;
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
  const y = (line - 1) * lh;
  if (y < ta.scrollTop || y + lh > ta.scrollTop + ta.clientHeight) ta.scrollTop = Math.max(0, y - ta.clientHeight / 2);
  if (select) {
    const a = lineStart(text, line), b = text.indexOf('\n', a);
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(a, b < 0 ? text.length : b);
  }
}

// the lines of the selection: [first offset, end offset] widened to whole lines
function selectedLines(el) {
  const v = el.value;
  const a = v.lastIndexOf('\n', el.selectionStart - 1) + 1;
  let end = el.selectionEnd;
  if (end > el.selectionStart && v[end - 1] === '\n') end--;           // a selection up to the start of a line: not that line
  const nl = v.indexOf('\n', end);
  return [a, nl < 0 ? v.length : nl];
}

// replace a range as one step of the browser's undo
function replaceRange(el, text, a, b, select = 'end') {
  el.focus();
  el.setSelectionRange(a, b);
  if (!document.execCommand('insertText', false, text)) el.setRangeText(text, a, b, select);
}

// the matches of the search in the highlighted text (::highlight(code-search)); the one selected - where Find
// went - ::highlight(code-search-current). The inlays after a line (DATA @embed) are not the text
const MAX_MATCHES = 5000;

// the text of the highlighted code as it is shown, and Ranges of its offsets (pieces [from, to), in order)
function shownText(el) {
  const nodes = [];
  let text = '';
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: n => (n.parentElement?.closest('.tok-inlay') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  for (let n = walk.nextNode(); n; n = walk.nextNode()) { nodes.push({ n, at: text.length }); text += n.data; }
  let k = 0;
  // the node and offset of a position of the text (the positions asked for only grow)
  const point = (pos, end) => {
    while (k < nodes.length - 1 && (end ? nodes[k].at + nodes[k].n.data.length < pos : nodes[k + 1].at <= pos)) k++;
    return [nodes[k].n, pos - nodes[k].at];
  };
  const range = (a, b) => { const r = new Range(); r.setStart(...point(a, false)); r.setEnd(...point(b, true)); return r; };
  return { text, range, empty: !nodes.length };
}

function markSearch(el, ta, search) {
  if (typeof CSS === 'undefined' || !CSS.highlights) return;
  CSS.highlights.delete('code-search');
  CSS.highlights.delete('code-search-current');
  const q = (search ?? '').trim().toLowerCase();
  if (!q || !el?.isConnected) return;
  const shown = shownText(el);
  if (shown.empty) return;
  const hay = shown.text.toLowerCase();
  const all = [], cur = [];
  for (let at = hay.indexOf(q), count = 0; at >= 0 && count < MAX_MATCHES; at = hay.indexOf(q, at + q.length), count++) {
    (ta && ta.selectionStart === at && ta.selectionEnd === at + q.length ? cur : all).push(shown.range(at, at + q.length));
  }
  if (all.length) CSS.highlights.set('code-search', new Highlight(...all));
  if (cur.length) CSS.highlights.set('code-search-current', new Highlight(...cur));
}

// the parts of the lines past the limit of the editor of the machine (limit.column(line): where a line
// passes it, null when it fits) - ::highlight(code-overlimit)
function markLimit(el, limit) {
  if (typeof CSS === 'undefined' || !CSS.highlights) return;
  CSS.highlights.delete('code-overlimit');
  if (!limit || !el?.isConnected) return;
  const shown = shownText(el);
  if (shown.empty) return;
  const out = [];
  let at = 0;
  for (const line of shown.text.split('\n')) {
    const col = limit.column(line);
    if (col != null && col < line.length) out.push(shown.range(at + col, at + line.length));
    at += line.length + 1;
  }
  if (out.length) CSS.highlights.set('code-overlimit', new Highlight(...out));
}

// the width of a column of the code: kept per font (asked at every scroll)
const widths = new Map();
function columnWidth(ta) {
  const cs = getComputedStyle(ta), key = `${cs.fontFamily}|${cs.fontSize}|${cs.letterSpacing}`;
  if (!widths.has(key)) widths.set(key, charWidth(ta));
  return widths.get(key);
}

// CodeEditor: the surface. Props
//   value, oninput(text, textarea)
//   lang         the language (see above)
//   marks        Map line -> 'bp' | 'bp-off' | 'here' | 'bp here' (the gutter)
//   errors       Map line -> message: the line marked, the message as the tip of its number
//   onGutter     (line) a click on a line number: a breakpoint on or off
//   search       the text of the search: its matches marked
//   limit        { max, length(line), column(line), hint }: the longest line - a red line at column max, the
//                part of a line past it marked, a key that makes a line longer refused (onLimit() then)
//   gutterText   Map line -> text shown instead of the line numbers (the addresses of a build); a line not in it: blank
//   gutterStale  a message when that text is out of date (the gutter dimmed, the message its tip)
//   inputRef     a ref that is given the textarea
//   onCaret      (line, col) after a click or a key that moves the caret
//   onkeydown    (event, textarea) before the area's own keys - true when it is handled
//   onHover      (word, event) the word under the pointer with Ctrl held - a definition to go to
//   onContext    (offset, insert(text), event) a right click at the offset: true when it opened a panel of
//                its own (the browser's menu stays shut, the caret moves there); insert writes at the caret
export function CodeEditor(o) {
  const ta = useRef(null), pre = useRef(null), gutter = useRef(null), caretLine = useRef(null);
  const [list, setList] = useState(null);
  const [active, setActive] = useState(0);
  const text = o.value ?? '';
  const lines = text.split('\n').length;
  const emit = el => o.oninput?.(el.value, el);

  const sync = () => {
    const el = ta.current;
    if (!el) return;
    if (pre.current) { pre.current.scrollTop = el.scrollTop; pre.current.scrollLeft = el.scrollLeft; }
    if (gutter.current) gutter.current.scrollTop = el.scrollTop;
    markCaretLine(el);
    markSearch(pre.current, el, o.search);
    placeLimit(el);
  };
  // the limit of a line (o.limit): a red line at its column
  const limitLine = useRef(null);
  const placeLimit = el => {
    const m = limitLine.current;
    if (!m || !o.limit) return;
    const cs = getComputedStyle(el);
    const x = parseFloat(cs.paddingLeft) + o.limit.max * columnWidth(el) - el.scrollLeft;
    m.style.transform = `translateX(${Math.round(x)}px)`;          // on a whole pixel: sharp, not smeared over two
    m.hidden = x < 0;
  };
  useLayoutEffect(() => markLimit(pre.current, o.limit));
  useLayoutEffect(() => () => { if (typeof CSS !== 'undefined') CSS.highlights?.delete('code-overlimit'); }, []);
  // the line of the caret: a thin line above and below it (the start of a selection: its line)
  const markCaretLine = el => {
    const m = caretLine.current;
    if (!m || !el) return;
    const cs = getComputedStyle(el), lh = parseFloat(cs.lineHeight), pad = parseFloat(cs.paddingTop);
    const line = el.value.slice(0, el.selectionStart).split('\n').length - 1;
    const top = pad + line * lh - el.scrollTop;
    m.style.transform = `translateY(${top}px)`;
    m.style.height = `${lh}px`;
    m.hidden = !Number.isFinite(top) || top + lh < 0 || top > el.clientHeight;
    markGutter(el);
  };
  // the lines of the caret or of a selection in the gutter too: their number or address in bold, a selection
  // in its colour (the line of the caret itself goes across the gutter)
  const markGutter = el => {
    const g = gutter.current;
    if (!g) return;
    const v = el.value, a = el.selectionStart;
    let b = el.selectionEnd;
    if (b > a && v[b - 1] === '\n') b--;                                // a selection up to the start of a line: not that line
    const first = v.slice(0, a).split('\n').length, last = first + (v.slice(a, b).match(/\n/g)?.length ?? 0);
    const selected = a !== b;
    for (const s of g.querySelectorAll('.code-gutter__cur')) {
      const n = Number(s.dataset.line);
      if (n < first || n > last) s.classList.remove('code-gutter__cur', 'code-gutter__sel');
    }
    for (let n = first; n <= last; n++) {
      const s = g.querySelector(`[data-line="${n}"]`);
      s?.classList.add('code-gutter__cur');
      s?.classList.toggle('code-gutter__sel', selected);
    }
  };
  useLayoutEffect(sync);
  useLayoutEffect(() => { if (o.inputRef) o.inputRef.current = ta.current; });

  const close = () => { setList(null); setActive(0); };
  const caretMoved = el => { markCaretLine(el); if (o.onCaret) { const c = caretAt(el.value, el.selectionStart); o.onCaret(c.line, c.col); } };

  // what may be written at the caret; while typing only once there is something to filter by,
  // Ctrl+Space anywhere
  const suggest = (el, force) => {
    if (!o.lang?.complete) return;
    const caret = el.selectionStart;
    if (caret !== el.selectionEnd) return close();
    const r = o.lang.complete(el.value, caret, { force });
    if (!r) return close();
    const info = [r.info].flat().filter(Boolean);
    // nothing typed yet: only the help of the instruction or keyword (its parameters, its flags) -
    // without a list, so Enter still ends the line
    if (!force && r.from === caret && !r.open) {
      if (!info.length) return close();
      setList({ from: caret, to: caret, items: [], info, caret });
      return;
    }
    if (!r.items.length && !info.length) return close();
    setList({ ...r, info, caret });
    setActive(0);
  };

  const pick = item => {
    const el = ta.current;
    if (!el || !list) return;
    const word = item.insert ?? item.label;
    replaceRange(el, word, list.from, list.to);
    if (item.caret != null) { const at = list.from + item.caret; el.setSelectionRange(at, at); }   // a snippet: the caret inside it
    close();
    emit(el);
  };

  const shown = list ? list.items.slice(0, MAX_SHOWN) : [];
  const at = Math.min(active, Math.max(0, shown.length - 1));
  const pop = useRef(null);
  pop.current ??= floater();
  useLayoutEffect(() => () => pop.current.close(), []);
  useLayoutEffect(() => {
    if (!list || (!shown.length && !list.info?.length) || !ta.current) { pop.current.close(); return; }
    const cur = shown[at];
    // the details: those of the suggestion, then the help of where the caret is (the instruction or
    // the keyword whose argument is typed)
    const docs = [cur?.doc, ...(list.info ?? [])].filter(Boolean);
    pop.current.show(h('div', { class: `md-menu code-complete ns-complete ${shown.length ? '' : 'ns-complete--info'}`, role: shown.length ? 'listbox' : 'tooltip', 'data-i18n': 'off' },
      shown.length > 0 && h('div', { class: 'ns-complete__list' }, shown.map((x, k) => h('button', {
        class: `md-menu__item ${k === at ? 'md-menu__item--active' : ''}`, role: 'option', type: 'button', tabindex: -1,
        onpointerdown: e => e.preventDefault(),
        onclick: () => pick(x),
      }, icon(x.icon || KIND_ICON[x.kind] || 'chevron_right'), h('span', { class: 'tok-name' }, x.label),
      x.hint && h('kbd', {}, x.hint)))),
      !cur?.doc && cur?.detail ? h('div', { class: 'ns-complete__detail' }, cur.syntax ? h('code', {}, cur.syntax) : '', h('div', {}, cur.detail)) : '',
      docs.length > 0 && h('div', { class: 'ns-complete__docs' }, docs.map(docView))),
    caretRect(ta.current, text, list.caret));
    document.querySelector('.ns-complete .md-menu__item--active')?.scrollIntoView({ block: 'nearest' });
  });

  // Shift and the mouse: the whole doc of the word under the pointer (lang.hover) - while Shift is held over
  // the text; Shift alone shows it after a moment, so typing capitals does not
  const tip = useRef(null), pointer = useRef(null), tipKey = useRef(''), tipTimer = useRef(0);
  tip.current ??= floater();
  const hideTip = () => { clearTimeout(tipTimer.current); if (tipKey.current) { tip.current.close(); tipKey.current = ''; } };
  const showTip = useRef(null);
  showTip.current = () => {
    const el = ta.current, p = pointer.current;
    if (!el || !p || !o.lang?.hover) return hideTip();
    const r = o.lang.hover(el.value, offsetAt(el, p.x, p.y));
    if (!r?.docs?.length) return hideTip();
    const key = `${r.from}:${r.to}`;
    if (key === tipKey.current) return;
    tipKey.current = key;
    close();
    tip.current.show(h('div', { class: 'md-menu code-complete ns-complete ns-complete--info ns-hover', role: 'tooltip', 'data-i18n': 'off' },
      h('div', { class: 'ns-complete__docs' }, r.docs.map(docView))), caretRect(el, el.value, r.from));
  };
  useLayoutEffect(() => {
    const down = e => {
      if (e.key !== 'Shift') { hideTip(); return; }
      if (!e.repeat && pointer.current) { clearTimeout(tipTimer.current); tipTimer.current = setTimeout(() => showTip.current(), 250); }
    };
    const up = e => { if (e.key === 'Shift') hideTip(); };
    addEventListener('keydown', down, true);
    addEventListener('keyup', up, true);
    addEventListener('blur', hideTip);
    return () => { removeEventListener('keydown', down, true); removeEventListener('keyup', up, true); removeEventListener('blur', hideTip); hideTip(); tip.current.close(); };
  }, []);

  const numbers = [];
  for (let i = 1; i <= lines; i++) {
    const err = o.errors?.get(i);
    const cls = ['code-gutter__line', err && 'code-gutter__err', ...(o.marks?.get(i)?.split(' ') ?? []).map(m => `code-gutter__${m}`),
      o.onGutter && 'code-gutter__stop'].filter(Boolean).join(' ');
    const label = o.gutterText ? (o.gutterText.get(i) ?? '') : String(i);
    numbers.push(h('span', { class: cls, 'data-line': i, title: err || (o.gutterText ? [`line ${i}`, o.gutterStale].filter(Boolean).join(' · ') : undefined) }, label), '\n');
  }

  // Tab and Shift+Tab: the selected lines in or out; without a selection Tab writes spaces
  const indent = (el, out) => {
    const [a, b] = selectedLines(el);
    const block = el.value.slice(a, b);
    const one = el.selectionStart === el.selectionEnd || !block.includes('\n') && el.selectionEnd - el.selectionStart < block.length;
    if (!out && one) { replaceRange(el, '    ', el.selectionStart, el.selectionEnd); return; }
    const next = block.split('\n').map(l => (out ? l.replace(/^( {1,4}|\t)/, '') : '    ' + l)).join('\n');
    replaceRange(el, next, a, b);
    el.setSelectionRange(a, a + next.length);
  };

  // Ctrl+/: the selected lines into comments, or out of them
  const toggleComment = el => {
    const c = o.lang?.comment;
    if (!c) return;
    const [a, b] = selectedLines(el);
    const block = el.value.slice(a, b).split('\n');
    const re = o.lang.commentRe ?? new RegExp(`^(\\s*)${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ?`);
    const all = block.every(l => !l.trim() || re.test(l));
    const next = block.map(l => (!l.trim() ? l : all ? l.replace(re, '$1') : (o.lang.commentLine ? o.lang.commentLine(l) : l.replace(/^(\s*)/, `$1${c} `)))).join('\n');
    replaceRange(el, next, a, b);
    el.setSelectionRange(a, a + next.length);
  };

  // copy and cut: the selection in the form of the file (lang.copyText)
  const clip = (e, cut) => {
    const el = e.target, a = el.selectionStart, b = el.selectionEnd;
    if (a === b || !e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', o.lang.copyText(el.value.slice(a, b)));
    if (cut) { replaceRange(el, '', a, b); emit(el); }
  };

  // Enter keeps the indent of the line (the language may add a line number: BASIC)
  const newline = el => {
    const v = el.value, a = v.lastIndexOf('\n', el.selectionStart - 1) + 1;
    const line = v.slice(a, el.selectionStart);
    const ins = o.lang?.newline ? o.lang.newline(v, el.selectionStart) : '\n' + /^[ \t]*/.exec(line)[0];
    replaceRange(el, ins, el.selectionStart, el.selectionEnd);
    emit(el);
  };

  return h('div', { class: `code-view code-view--grow ns-code ${o.cls || ''}`,
    onwheel: e => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();                            // not the zoom of the page
      close();
      setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), ta.current);
    } },
    // the line of the caret: across the gutter and the code
    h('div', { class: 'code-caret-line', ref: caretLine, 'aria-hidden': 'true' }),
    h('pre', { class: `code-gutter ${o.gutterText ? 'code-gutter--addr' : ''} ${o.gutterStale ? 'code-gutter--stale' : ''}`, ref: gutter, 'data-i18n': 'off', 'aria-hidden': 'true',
      onclick: o.onGutter ? e => { const line = Number(e.target.dataset?.line); if (line) o.onGutter(line); } : undefined }, numbers),
    h('div', { class: 'code-view__body' },
      h('pre', { class: 'code-highlight', ref: pre, 'data-i18n': 'off', 'aria-hidden': 'true' }, o.lang?.highlight ? o.lang.highlight(text, o) : text, '\n'),
      o.limit && h('div', { class: 'code-limit', ref: limitLine, 'aria-hidden': 'true', title: o.limit.hint }),
      h('textarea', {
        ref: ta, class: 'code-area code-view__input', spellcheck: false, wrap: 'off', value: text,
        autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', 'data-i18n': 'off',
        'data-form-type': 'other', 'data-1p-ignore': '', 'data-lpignore': 'true',
        // the limit of a line is a barrier for typing: a key that makes a line too long is not taken
        // (Enter, deleting, pasting are - a pasted line too long is marked, and the build warns)
        onbeforeinput: e => {
          if (!o.limit || !['insertText', 'insertCompositionText', 'insertReplacementText'].includes(e.inputType) || e.data == null) return;
          const el = e.target, v = el.value, a = el.selectionStart, b = el.selectionEnd;
          const next = v.slice(0, a) + e.data + v.slice(b);
          const lineOf = (text, at) => text.slice(text.lastIndexOf('\n', at - 1) + 1, (text.indexOf('\n', at) + 1 || text.length + 1) - 1);
          const before = lineOf(v, a), after = lineOf(next, a + e.data.length);
          if (o.limit.length(after) > o.limit.max && o.limit.length(after) > o.limit.length(before)) {
            e.preventDefault();
            o.onLimit?.();
          }
        },
        oninput: e => {
          const c = e.inputType?.startsWith('insert') && o.lang?.collapse?.(e.target.value, e.target.selectionStart);
          if (c) replaceRange(e.target, c.insert, c.from, c.to);
          emit(e.target);
          markCaretLine(e.target);
          const typed = e.data ?? '';
          suggest(e.target, !!(typed && o.lang?.autoTrigger?.(typed, e.target.value, e.target.selectionStart)));
        },
        onscroll: () => { sync(); if (list) close(); hideTip(); },
        onmousemove: e => {
          pointer.current = { x: e.clientX, y: e.clientY };
          if (e.buttons) markGutter(e.target);                            // a selection being dragged
          if (e.shiftKey && !e.buttons) showTip.current(); else if (tipKey.current) hideTip();
        },
        onmouseleave: () => { pointer.current = null; hideTip(); },
        onclick: e => {
          close();
          caretMoved(e.target);
          if ((e.ctrlKey || e.metaKey) && o.onDefinition) {
            const v = e.target.value, c = e.target.selectionStart;
            const m = /[.@]?[\w]+$/.exec(v.slice(0, c)), n = /^\w*/.exec(v.slice(c));
            const word = (m?.[0] ?? '') + (n?.[0] ?? '');
            if (word) o.onDefinition(word);
          }
        },
        onkeyup: e => { if (/^(Arrow|Home|End|Page)/.test(e.key)) caretMoved(e.target); else markCaretLine(e.target); },
        onfocus: e => markCaretLine(e.target),
        onselect: e => markCaretLine(e.target),
        onblur: () => { close(); o.onblur?.(); },
        oncopy: o.lang?.copyText ? e => clip(e, false) : undefined,
        oncut: o.lang?.copyText ? e => clip(e, true) : undefined,
        onpaste: o.lang?.pasteText ? e => {
          const el = e.target, pasted = e.clipboardData?.getData('text/plain');
          if (pasted == null) return;
          e.preventDefault();
          replaceRange(el, o.lang.pasteText(el.value, el.selectionStart, pasted.replace(/\r\n?/g, '\n')), el.selectionStart, el.selectionEnd);
          emit(el);
        } : undefined,
        oncontextmenu: o.onContext ? e => {
          const el = e.target, at = offsetAt(el, e.clientX, e.clientY);
          const insert = word => { const t = ta.current; if (!t) return; replaceRange(t, word, t.selectionStart, t.selectionEnd); emit(t); };
          // a click into the selection keeps it (Cut, Copy of the menu), else the caret goes there
          const inSel = el.selectionStart !== el.selectionEnd && at >= el.selectionStart && at <= el.selectionEnd;
          if (!o.onContext(at, insert, e, { inSelection: inSel })) return;
          e.preventDefault();
          close();
          el.focus({ preventScroll: true });
          if (!inSel) el.setSelectionRange(at, at);
          caretMoved(el);
        } : undefined,
        onkeydown: e => {
          if (list && shown.length) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              return setActive((at + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length);
            }
            if (e.key === 'PageDown' || e.key === 'PageUp') {
              e.preventDefault();
              return setActive(Math.max(0, Math.min(shown.length - 1, at + (e.key === 'PageDown' ? 10 : -10))));
            }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return pick(shown[at]); }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return close(); }
          }
          if (list && !shown.length) {
            // only the help: Escape closes it, the arrows leave it
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return close(); }
            if (/^Arrow(Up|Down)$|^Page/.test(e.key)) close();
          }
          if (list && /^Arrow(Left|Right)$|^Home$|^End$/.test(e.key)) close();
          if (e.key === ' ' && e.ctrlKey) { e.preventDefault(); return suggest(e.target, true); }
          if (e.key === '0' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) { e.preventDefault(); return setZoom(1, e.target); }
          if (o.onkeydown?.(e, e.target)) return;
          if ((e.ctrlKey || e.metaKey) && (e.key === '/' || e.key === '7' && e.shiftKey)) { e.preventDefault(); toggleComment(e.target); emit(e.target); return; }
          if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); newline(e.target); return; }
          if (e.key === 'Tab' && !e.altKey && !e.ctrlKey) { e.preventDefault(); indent(e.target, e.shiftKey); emit(e.target); }
        },
      })));
}

export const codeEditor = (o = {}) => h(CodeEditor, o);

// the details of a suggestion or of the caret's place (cpudocs.js): its syntax and parameters (the one
// at the caret marked), the addressing modes, the flags it changes, the bits of a register
const FLAG_MARK = { changed: '±', cleared: '0', set: '1', parity: 'P', overflow: 'V' };
function docView(d) {
  const flags = d.flags;
  return h('div', { class: 'ns-doc' },
    h('div', { class: 'ns-doc__head' }, h('span', { class: 'ns-doc__title' }, d.title), d.desc && h('span', { class: 'ns-doc__desc' }, d.desc)),
    d.syntax && h('code', { class: 'ns-doc__syntax' }, d.syntax),
    d.operation && h('div', { class: 'ns-doc__op' }, h('span', { class: 'ns-doc__flags-label' }, 'does'), h('code', {}, d.operation)),
    d.params?.length > 0 && h('div', { class: 'ns-doc__params' }, d.params.map((p, k) => h('div', { class: `ns-doc__param ${k === Math.min(d.active ?? -1, d.params.length - 1) ? 'ns-doc__param--on' : ''}` },
      h('code', {}, p.name), p.desc && h('span', {}, p.desc)))),
    d.modes?.length > 0 && h('table', { class: 'ns-doc__modes' },
      d.modes[0].op != null && h('thead', {}, h('tr', {}, h('th', {}, 'mode'), h('th', {}, 'opcode'), h('th', {}, 'bytes'), h('th', {}, d.modes.some(m => m.cycles !== '') ? 'cycles' : ''))),
      h('tbody', {}, d.modes.map(m => h('tr', {}, h('td', {}, h('code', {}, m.syntax)), m.op != null && [h('td', {}, m.op), h('td', {}, m.bytes), h('td', {}, m.cycles)])))),
    flags && h('div', { class: 'ns-doc__flags' },
      h('span', { class: 'ns-doc__flags-label' }, 'flags'),
      flags.names.map(n => {
        const e = flags.effects.find(x => x.name === n);
        return h('span', { class: `ns-doc__flag ${e ? 'ns-doc__flag--on' : ''}`, title: e ? `${e.flag}: ${e.effect}` : `${n}: kept` },
          n, h('small', {}, e ? FLAG_MARK[e.effect] ?? 'M' : '-'));
      }),
      h('span', { class: 'ns-doc__flags-text' }, flags.effects.length ? flags.effects.map(e => `${e.name} ${e.effect}`).join(' · ') : 'no flag changes')),
    d.bits?.length > 0 && h('table', { class: 'ns-doc__bits' }, h('tbody', {}, d.bits.map(b => h('tr', {}, h('td', {}, b.where), h('td', {}, b.what))))),
    d.notes?.filter(Boolean).map(n => h('div', { class: 'ns-doc__note' }, n)));
}

// --- helpers for the languages ----------------------------------------------------------------

// tokens [{ cls, text, show?, style? }] as the children of the <pre>: plain text where there is no
// class; show - what is drawn in place of the text (as many columns wide, app.css)
export function spans(tokens) {
  const out = [];
  let plain = '';
  for (const t of tokens) {
    if (!t.cls) { plain += t.text; continue; }
    if (plain) { out.push(plain); plain = ''; }
    out.push(h('span', { class: t.cls, title: t.title, style: t.style }, t.show ?? t.text));
  }
  if (plain) out.push(plain);
  return out;
}

// the items whose label starts with the prefix (case insensitive), the exact case first, then the
// ones that only contain it
export function filterItems(items, prefix) {
  const p = prefix.toLowerCase();
  if (!p) return items;
  const starts = [], has = [];
  for (const x of items) {
    const l = x.label.toLowerCase();
    if (l.startsWith(p)) starts.push(x);
    else if (p.length > 1 && l.includes(p)) has.push(x);
  }
  return [...starts, ...has];
}
