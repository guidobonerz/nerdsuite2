// colorchooser.js - pens and their colors in one list
//
// Every row is a pen: its name, ':' and the name of its color, and a swatch. Clicking the
// row makes it the pen, clicking the swatch opens the palette of the machine (video.js: 4 x 4 the
// C64's, 16 hues x 8 luminances the TED's). A
// disabled row (a multicolor pen in hires mode) is greyed and cannot be the pen, but its
// color can still be set.

import { h, render, useState } from './pui.js';
import { PALETTE } from './c64.js';
import { tr } from './i18n.js';
import { colorName as nameOf, colorChoices, colorMask } from './video.js';

const colorName = k => { const n = nameOf(k); return n[0].toUpperCase() + n.slice(1); };
export const colorLabel = k => tr('§1097', String(k).padStart(2, '0'), colorName(k));

let popup = null;                 // the host of the open palette, its owner in dataset.owner

export function closeColorPopup() {
  if (!popup) return;
  render(null, popup);
  popup.remove();
  popup = null;
}

// the colours a count stands for: 16 the palette, 8 the colour of a multicolor cell (video.js colorChoices)
const choicesOf = count => colorChoices(count === 8 || count === 'mc' ? 'mc' : typeof count === 'string' ? count : 'all');

// the colors of the machine; the footer names the color under the pointer
function Palette({ value, count, onpick }) {
  const [hover, setHover] = useState(null);
  const { list, cols } = choicesOf(count), cell = cols > 8 ? 22 : 44;
  return h('div', { class: 'cc-popup', role: 'dialog', style: { position: 'static' } },
    h('div', { class: 'cc-popup__grid', style: { gridTemplateColumns: `repeat(${cols}, ${cell}px)`, gridAutoRows: `${cell}px` } }, list.map(k => h('button', {
      class: `cc-popup__color ${k === value ? 'cc-popup__color--selected' : ''}`, type: 'button',
      style: { background: PALETTE[k] }, 'aria-label': colorLabel(k),
      onpointerenter: () => setHover(k), onpointerleave: () => setHover(null),
      onclick: e => { e.stopPropagation(); closeColorPopup(); onpick(k); },
    }))),
    h('div', { class: 'cc-popup__footer' }, colorLabel(hover ?? value)));
}

// the palette below the anchor: count colors (16 the palette, 8 the char color of multicolor
// chars, or a kind of video.js colorChoices), value outlined; onpick(k). owner: who opened it - its swatch closes it again
export function openColorPopup(anchor, value, onpick, count = 16, owner = '') {
  closeColorPopup();
  popup = document.createElement('div');
  popup.style.cssText = 'position:fixed;z-index:1000';
  popup.dataset.owner = owner;
  document.body.append(popup);
  render(h(Palette, { value, count, onpick }), popup);
  const r = anchor.getBoundingClientRect();
  const w = popup.offsetWidth, ht = popup.offsetHeight;
  let x = r.left, y = r.bottom;
  if (x + w > innerWidth - 8) x = Math.max(8, r.right - w);
  if (y + ht > innerHeight - 8) y = Math.max(8, r.top - ht);
  popup.style.left = `${x}px`;
  popup.style.top = `${y}px`;
  popup.querySelector('.cc-popup__color--selected, .cc-popup__color')?.focus({ preventScroll: true });
}

if (typeof window !== 'undefined') {
  addEventListener('pointerdown', e => { if (popup && !popup.contains(e.target) && !e.target.closest?.('.cc-row__swatch')) closeColorPopup(); }, true);
  addEventListener('keydown', e => { if (popup && e.key === 'Escape') { closeColorPopup(); e.stopPropagation(); } }, true);
  addEventListener('resize', closeColorPopup);
}

// rows: [{ label, color, active, disabled, tip, count, onselect, onpick(k) }]
export function colorChooser(rows) {
  return h('div', { class: 'cc' }, rows.map(r => h('div', {
    class: `cc-row ${r.active ? 'cc-row--active' : ''} ${r.disabled ? 'cc-row--disabled' : ''}`,
    role: 'button', tabindex: r.disabled ? -1 : 0, 'aria-pressed': String(!!r.active), 'data-tip': r.tip,
    onclick: () => { if (!r.disabled) r.onselect?.(); },
    onkeydown: e => { if ((e.key === 'Enter' || e.key === ' ') && !r.disabled && e.target === e.currentTarget) { e.preventDefault(); r.onselect?.(); } },
  },
  h('span', { class: 'cc-row__label' }, r.label),
  h('span', { class: 'cc-row__value' }, `:${colorName(r.color & colorMask())}`),
  h('button', {
    class: 'cc-row__swatch', type: 'button', style: { background: PALETTE[r.color & colorMask()] },
    'data-tip': tr('§0405', r.label.toLowerCase()),
    onclick: e => {
      e.stopPropagation();
      if (popup && popup.dataset.owner === r.label) return closeColorPopup();
      openColorPopup(e.currentTarget, r.color & colorMask(), r.onpick, r.count ?? 16, r.label);
    },
  }))));
}
