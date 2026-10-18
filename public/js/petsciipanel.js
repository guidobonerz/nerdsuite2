// petsciipanel.js - the PETSCII panel of the BASIC editor: a right click in a string of a Commodore
// dialect opens it at the pointer (codeview.js). A click writes at the caret what the tokenizer reads
// back as that byte (basic/basic.js charOut): the colours and the keys as their {control codes}, the
// characters as themselves or their {shift-x} / {cbm-x} names. It stays open for more; Escape or a
// click outside closes it.
//
// The characters are drawn with the C64 font (app.css): U+EE00 + screen code in the upper case /
// graphics set, U+EF00 + screen code in the lower / upper case set.

import { h, useState, floater } from './pui.js';
import { PALETTE } from './c64.js';
import { controlCodeName } from './basic/petscii.js';
import { charOut } from './basic/basic.js';
import { PETSCII_UPPER, PETSCII_LOWER } from './petscii.js';
import { petsciiCharset, setPetsciiCharset, editorChar, customCharsetPath } from './lang-basic.js';
import { allFiles } from './project.js';

// the charsets of the project (the char editor's .chr files): their glyphs can stand in for the ROM's
const projectCharsets = () => allFiles().filter(p => /\.chr$/i.test(p) && !p.startsWith('reference/'));

// the colour codes in the order of the C64 colours 0-15
const COLORS = [0x90, 0x05, 0x1c, 0x9f, 0x9c, 0x1e, 0x1f, 0x9e, 0x81, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0x9b];
// the keys: [code, label]
const KEYS = [
  [0x93, 'CLR'], [0x13, 'HOME'], [0x12, 'RVS'], [0x92, 'OFF'], [0x94, 'INST'], [0x14, 'DEL'],
  [0x91, '↑'], [0x11, '↓'], [0x9d, '←'], [0x1d, '→'], [0x0e, 'lo'], [0x8e, 'UP'], [0x08, 'lock'], [0x09, 'unlk'], [0x8d, 'S-RET'], [0x03, 'STOP'],
];
const FKEYS = [0x85, 0x89, 0x86, 0x8a, 0x87, 0x8b, 0x88, 0x8c];
// the printable characters are $20-$5F and $A0-$DF ($60-$7F, $E0-$FE and pi $FF are the same glyphs again)

// the screen code of a printable PETSCII byte: the glyph in the font
export const screenCode = c => (c === 0xff ? 0x5e : c < 0x40 ? c : c < 0x60 ? c - 0x40 : c < 0x80 ? c - 0x20 : c < 0xc0 ? c - 0x40 : c - 0x80);

// --- the orders of the grid -----------------------------------------------------------------------------
// natural: the order of the charset, screen codes 0-127 as the char editor shows them (@ A B ... space ! ...)
// organized: the text first ($20-$5F), then the 64 graphics in 4 rows where they make pictures - the
//   arrangement of the user's own editor (each graphic once; where the ROM has the same glyph twice, as
//   64 and 67, both codes are in it)
const PETSCII_OF = sc => (sc < 0x20 ? sc + 0x40 : sc < 0x40 ? sc : sc < 0x60 ? sc + 0x80 : sc + 0x40);
const NATURAL = Array.from({ length: 0x80 }, (_, sc) => PETSCII_OF(sc));
const TEXT = Array.from({ length: 0x40 }, (_, k) => 0x20 + k);
const ORGANIZED = {
  // upper case / graphics: the text, then the graphics as the user arranged them (screen codes, 16 a
  // row): the box of lines, the bars, the diamond, the circle, the quarters and the big frame side by side
  upper: [...TEXT, ...[
    112, 114, 110, 82, 70, 64, 67, 68, 69, 85, 73, 87, 81, 79, 119, 80,
    107, 91, 115, 78, 77, 86, 121, 120, 102, 74, 75, 108, 123, 101, 96, 103,
    109, 113, 125, 95, 105, 118, 117, 104, 92, 94, 97, 124, 126, 76, 111, 122,
    116, 84, 71, 66, 93, 72, 89, 106, 99, 100, 127, 98, 90, 65, 83, 88,
  ].map(PETSCII_OF)],
  // lower / upper case: the capitals follow the small letters, then the graphics, the box of lines first
  lower: [...TEXT, ...Array.from({ length: 0x20 }, (_, k) => 0xc0 + k),
    ...[0xb0, 0xb2, 0xae, 0xab, 0xb3, 0xad, 0xb1, 0xbd],
    ...Array.from({ length: 0x20 }, (_, k) => 0xa0 + k).filter(c => ![0xb0, 0xb2, 0xae, 0xab, 0xb3, 0xad, 0xb1, 0xbd].includes(c))],
};
const ORDER_KEY = 'ns-petscii-order';
const savedOrder = () => { try { return localStorage.getItem(ORDER_KEY) === 'natural' ? 'natural' : 'organized'; } catch { return 'organized'; } };
export const charsOf = (order, charset) => (order === 'natural' ? NATURAL : ORGANIZED[charset === 'lower' ? 'lower' : 'upper']);
const hex2 = c => c.toString(16).padStart(2, '0');

// what the source holds for a byte in a string: a quote would end it
const sourceOf = (c, dialect) => (c === 0x22 ? '{$22}' : charOut(c, dialect));
const tagOf = (c, dialect) => `{${controlCodeName(c, dialect) ?? '$' + hex2(c)}}`;

// the buttons of the two character sets, in their own glyphs: A and a spade, A and a
const CHARSET_LABEL = {
  upper: String.fromCharCode(PETSCII_UPPER + 0x01, PETSCII_UPPER + 0x41),
  lower: String.fromCharCode(PETSCII_LOWER + 0x41, PETSCII_LOWER + 0x01),
};

function Panel({ dialect, insert }) {
  const [charset, setCharset] = useState(petsciiCharset.value);
  const [hover, setHover] = useState(null);         // { code, text }
  const [order, setOrder] = useState(savedOrder);
  const pickOrder = o => { setOrder(o); try { localStorage.setItem(ORDER_KEY, o); } catch { /* private mode */ } };
  const base = charset === 'lower' ? PETSCII_LOWER : PETSCII_UPPER;     // a project's charset: where the upper case set is
  const custom = customCharsetPath(charset);
  const charsets = projectCharsets();
  if (custom && !charsets.includes(custom)) charsets.unshift(custom);
  const cell = (code, text, cls, content, style) => h('button', {
    class: `petscii-panel__cell ${cls}`, type: 'button', tabindex: -1, style,
    onpointerdown: e => e.preventDefault(),          // the caret stays in the source
    onclick: () => insert(editorChar(code, dialect)),   // one character per byte (lang-basic.js)
    onpointerenter: () => setHover({ code, text }),
    onpointerleave: () => setHover(null),
  }, content);
  const keys = KEYS.filter(([c]) => controlCodeName(c, dialect));
  const pick = cs => {
    setCharset(cs);
    setPetsciiCharset(cs);                           // the strings of the source follow (lang-basic.js)
  };
  return h('div', { class: 'petscii-panel', role: 'dialog', 'aria-label': 'PETSCII', 'data-i18n': 'off',
    onpointerdown: e => e.preventDefault() },
    // its title: dragged it moves the panel (which then stays open for clicks in the source), × closes it
    h('div', { class: 'petscii-panel__head', onpointerdown: startDrag, title: 'Drag to move the panel' },
      h('span', { class: 'petscii-panel__title' }, 'PETSCII'),
      h('button', { class: 'petscii-panel__close', type: 'button', tabindex: -1, 'aria-label': 'Close', title: 'Close (Esc)',
        onpointerdown: e => { e.preventDefault(); e.stopPropagation(); }, onclick: closePetsciiPanel }, '×')),
    // the character set of the glyphs: the panel and the strings of the source (C= + Shift on the machine)
    h('div', { class: 'petscii-panel__charsets', role: 'radiogroup', 'aria-label': 'Character set' },
      h('span', { class: 'petscii-panel__charsets-label' }, 'Charset'),
      ['upper', 'lower'].map(cs => h('button', {
        class: `petscii-panel__charset ${charset === cs ? 'petscii-panel__charset--on' : ''}`, type: 'button', tabindex: -1,
        role: 'radio', 'aria-checked': String(charset === cs), onclick: () => pick(cs),
      }, h('span', { class: 'petscii-panel__charset-glyphs' }, CHARSET_LABEL[cs]), cs === 'upper' ? 'Upper case / graphics' : 'Lower / upper case')),
      // a charset of the project: drawn with a font made of its characters (bitfont.js)
      charsets.length > 0 && h('select', {
        class: `petscii-panel__charset petscii-panel__custom ${custom ? 'petscii-panel__charset--on' : ''}`, tabindex: -1,
        'aria-label': 'A charset of the project', title: custom ? `the charset ${custom} of the project` : 'a charset of the project',
        onpointerdown: e => e.stopPropagation(),       // the list opens (the panel keeps the caret otherwise)
        onchange: e => { if (e.target.value) pick(`chr:${e.target.value}`); },
      }, h('option', { value: '', selected: !custom }, 'Project charset…'),
      charsets.map(p => h('option', { value: p, selected: p === custom }, p.split('/').pop())))),
    dialect !== 'v4' && h('div', { class: 'petscii-panel__row' },
      COLORS.map((c, k) => cell(c, tagOf(c, dialect), 'petscii-panel__color', null, { background: PALETTE[k] }))),
    h('div', { class: 'petscii-panel__row' }, keys.map(([c, label]) => cell(c, tagOf(c, dialect), 'petscii-panel__key', label))),
    h('div', { class: 'petscii-panel__row' },
      FKEYS.map((c, k) => cell(c, tagOf(c, dialect), 'petscii-panel__key', `f${k + 1}`)),
      h('span', { class: 'petscii-panel__spacer' }),
      // the order of the grid: as in the charset, or the graphics as pictures
      h('div', { class: 'petscii-panel__orders', role: 'radiogroup', 'aria-label': 'Order of the characters' },
        [['natural', 'Natural', 'the order of the charset: screen codes 0-127'], ['organized', 'Organized', 'the text first, then the graphics side by side where they make pictures']]
          .map(([o, label, tip]) => h('button', {
            class: `petscii-panel__order ${order === o ? 'petscii-panel__order--on' : ''}`, type: 'button', tabindex: -1, title: tip,
            role: 'radio', 'aria-checked': String(order === o), onclick: () => pickOrder(o),
          }, label)))),
    h('div', { class: `petscii-panel__grid ${custom ? 'petscii-panel__grid--custom' : ''}` }, charsOf(order, charset).map(c => cell(c, sourceOf(c, dialect), 'petscii-panel__char', String.fromCharCode(base + screenCode(c))))),
    h('div', { class: 'petscii-panel__status' },
      hover ? `$${hex2(hover.code)} (${hover.code})  ${hover.text}` : 'a click writes it at the caret'));
}

const pop = floater();
let off = null;
// where the panel was dragged to: it opens there again (this session), and stays open for clicks outside
let placed = null;

export function closePetsciiPanel() {
  off?.();
  off = null;
  pop.close();
}

// the panel within the window
const clampTo = (el, left, top) => ({
  left: Math.max(0, Math.min(left, innerWidth - el.offsetWidth)),
  top: Math.max(0, Math.min(top, innerHeight - el.offsetHeight)),
});
function startDrag(e) {
  if (e.button !== 0) return;
  e.preventDefault();                              // the caret stays in the source
  const el = e.currentTarget.closest('.petscii-panel');
  const r = el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
  const head = e.currentTarget;
  head.setPointerCapture(e.pointerId);
  el.classList.add('petscii-panel--dragging');
  const move = ev => {
    placed = clampTo(el, ev.clientX - dx, ev.clientY - dy);
    el.style.left = `${placed.left}px`;
    el.style.top = `${placed.top}px`;
  };
  const up = () => {
    head.removeEventListener('pointermove', move);
    head.removeEventListener('pointerup', up);
    head.removeEventListener('pointercancel', up);
    el.classList.remove('petscii-panel--dragging');
  };
  head.addEventListener('pointermove', move);
  head.addEventListener('pointerup', up);
  head.addEventListener('pointercancel', up);
}

// open the panel at a point of the window - or where it was dragged to: insert(text) writes at the caret
// of the source
export function openPetsciiPanel({ x, y, dialect, insert }) {
  closePetsciiPanel();
  pop.show(h(Panel, { dialect, insert }), { left: x, top: y, bottom: y, right: x, width: 0 });
  const el = document.querySelector('.petscii-panel');
  if (placed && el) {
    const p = clampTo(el, placed.left, placed.top);
    el.style.left = `${p.left}px`;
    el.style.top = `${p.top}px`;
  }
  // a click outside closes it - not once it was dragged somewhere: then × and Escape do
  const outside = e => { if (!placed && !e.target.closest?.('.petscii-panel')) closePetsciiPanel(); };
  const key = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePetsciiPanel(); } };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', key, true);
  const blur = () => { if (!placed) closePetsciiPanel(); };
  addEventListener('blur', blur);
  off = () => {
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', key, true);
    removeEventListener('blur', blur);
  };
}
