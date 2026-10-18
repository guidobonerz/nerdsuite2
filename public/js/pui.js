// pui.js - the UI of the editor on Preact: the components (shadcn/ui style, the classes of
// m3.css), the overlays (menus, dialogs, toasts, tooltips) and the bridge to the store.
//
// The helpers have the call signatures the editor always had - field({...}), select({...}),
// button(label, {...}), section(...) - but return virtual nodes: a panel is a function of the
// game that is rendered again after every change, and Preact moves only what differs. Inputs
// keep their focus and their text, a select shows what the model holds.
//
//   h, html            virtual nodes: h(tag, props, ...children) or html`<div>...</div>` (htm)
//   mount(el, view)    renders view() into el, again whenever a signal it reads changes
//   storeVersion(s)    a signal that counts the changes of a store (store.js): read it in a view
//
// Preact, htm and signals are the files of ../vendor - the editor has no build step.

import { h as element, render, Fragment, createRef } from '../vendor/preact.js';
import { t, tr, lang, TEXT_ATTRS, labelsOnly } from './i18n.js';
import { iconClass } from './icons.js';
import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from '../vendor/preact-hooks.js';
import { signal, computed, effect, batch, useSignal, useComputed } from '../vendor/signals.js';
import htm from '../vendor/htm.js';

// h of Preact, in the language of the editor (i18n.js): the texts of an element - its text
// children and the attributes that are texts - are translated here, where every panel, menu and
// dialog passes. Icons (their text is the name of the glyph), the tokens of the script and
// what is typed are not texts of the UI
const NO_TEXT = /(^|\s)(msr|tok-\S*|trk-(note|ins|cmd|val|num)|mono|code)(\s|$)/;
function h(type, props, ...children) {
  if (typeof type === 'string' && type !== 'textarea' && type !== 'input' && !(props?.class && NO_TEXT.test(props.class)) && props?.['data-i18n'] !== 'off') {
    for (let k = 0; k < children.length; k++) {
      const c = children[k];
      if (typeof c === 'string') children[k] = t(c);
      else if (Array.isArray(c) && c.some(x => typeof x === 'string')) children[k] = c.map(x => (typeof x === 'string' ? t(x) : x));
    }
    if (props) {
      let copy = null;
      for (const a of TEXT_ATTRS) {
        if (typeof props[a] === 'string') { copy ??= { ...props }; copy[a] = t(props[a]); }
      }
      if (copy) props = copy;
    }
  } else if ((type === 'input' || type === 'textarea') && typeof props?.placeholder === 'string' && props['data-i18n'] !== 'off') {
    props = { ...props, placeholder: t(props.placeholder), 'data-tip': t(props['data-tip']) };
  } else if (typeof type === 'string') {
    // not translated - an icon, a token of the script, what is typed - but a label is still its text
    for (let k = 0; k < children.length; k++) if (typeof children[k] === 'string') children[k] = labelsOnly(children[k]);
    if (props) {
      let copy = null;
      for (const a of TEXT_ATTRS) {
        if (typeof props[a] === 'string' && props[a].includes('§')) { copy ??= { ...props }; copy[a] = labelsOnly(props[a]); }
      }
      if (copy) props = copy;
    }
  }
  return element(type, props, ...children);
}

export const html = htm.bind(h);
export { h, render, Fragment, createRef, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, signal, computed, effect, batch, useSignal, useComputed };

// --- the store and the views ----------------------------------------------------------------------

// a signal that changes with every event of the store: a view that reads it is rendered again
const versions = new WeakMap();
export function storeVersion(store) {
  if (!versions.has(store)) {
    const v = signal(0);
    store.on(() => { v.value++; });
    versions.set(store, v);
  }
  return versions.get(store);
}

// renders view() into el and again when a signal it read changed; returns { update, dispose }.
// update() renders again at once - for state that is no signal (the st objects of the editors)
const mounted = new Set();
export function mount(el, view) {
  const tick = signal(0);
  const dispose = effect(() => { tick.value; render(view(), el); });   // eslint-disable-line no-unused-expressions
  const m = { el, view };
  mounted.add(m);
  return { update: () => { tick.value++; }, dispose: () => { mounted.delete(m); dispose(); render(null, el); } };
}

// the language of the editor changed (i18n.js): every view is made anew, in its texts. What a
// component kept for itself - an open section, a field being typed in - starts again; the game,
// the editors' state and unsaved work are not in the views
let shown = lang.peek();
lang.subscribe(code => {
  if (code === shown) return;
  shown = code;
  for (const m of mounted) { render(null, m.el); render(m.view(), m.el); }
});

// an element made outside Preact (a canvas an editor draws on, a legacy widget) inside a view
export function DomNode({ node, class: cls }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (node && node.parentNode !== host) host.replaceChildren(node);
    if (!node) host.replaceChildren();
  }, [node]);
  return h('div', { ref, class: cls, style: cls ? null : { display: 'contents' } });
}
export const dom = (node, cls) => h(DomNode, { node, class: cls });

// --- basics ----------------------------------------------------------------------------------------

export const icon = (name, cls = '') => h('i', { class: `msr ${iconClass(name)} ${cls}` });

// The fields hold names and values of the script, never addresses or passwords. Browsers
// and password managers ignore autocomplete=off and read the labels instead ("Name" looks
// like an identity field and gets offers of email aliases): these attributes tell the
// common ones to stay away.
export const NO_AUTOFILL = {
  'data-form-type': 'other', 'data-1p-ignore': '', 'data-lpignore': 'true', 'data-bwignore': '',
  'data-protonpass-ignore': 'true', 'data-ddg-inputtype': 'unknown', 'aria-autocomplete': 'none',
};

// the arrows of a number field, thin chevrons in place of the browser's: one step up or down of
// the number input in the same box (.num-spin-host) - stepUp/stepDown keep its min, max and step -
// then its input and change events, as if typed; held down they go on. Every field of type number
// has them (Field); a bare input is put in a host next to them (seqtext.js)
export function spinArrows() {
  const arrow = by => {
    let timer = 0;
    const stop = () => { clearTimeout(timer); timer = 0; };
    const step = btn => {
      const el = btn.closest('.num-spin-host')?.querySelector('input');
      if (!el || el.disabled) return;
      const before = el.value;
      try { if (by > 0) el.stepUp(); else el.stepDown(); } catch { return; }
      if (el.value === before) return;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    return h('button', { class: 'num-spin__arrow', type: 'button', tabindex: -1, 'data-spin': by > 0 ? 'up' : 'down', 'aria-label': by > 0 ? '§1665' : '§1666',
      onpointerdown: e => {
        if (e.button !== 0) return;
        e.preventDefault();                       // the field keeps the focus (and its text stays the one stepped)
        const btn = e.currentTarget;
        step(btn);
        // held down: again and again - until the button is let go anywhere, or a view drawn anew
        // took it away (the change of the step may draw the field again)
        const hold = delay => { timer = setTimeout(() => { if (!btn.isConnected) return stop(); step(btn); hold(60); }, delay); };
        addEventListener('pointerup', stop, { once: true });
        addEventListener('pointercancel', stop, { once: true });
        hold(400);
      },
      onpointerup: stop, onpointerleave: stop, onpointercancel: stop },
      icon(by > 0 ? 'expand_less' : 'expand_more'));
  };
  return h('span', { class: 'num-spin' }, arrow(1), arrow(-1));
}

export function iconButton(name, tip, onclick, cls = '', extra = {}) {
  return h('button', { class: `md-icon-button ${cls}`, 'data-tip': tip, 'aria-label': tip, type: 'button', ...extra,
    onclick: e => { e.stopPropagation(); onclick?.(e); } }, icon(name));
}

export function button(label, { variant = 'text', icon: ic, onclick, cls = '', tip, disabled } = {}) {
  return h('button', { class: `md-button md-button--${variant} ${cls}`, type: 'button', 'data-tip': tip, disabled,
    onclick: e => { e.stopPropagation(); onclick?.(e); } }, ic && icon(ic), h('span', {}, label));
}

let ids = 0;
const useId = () => useMemo(() => 'p' + (++ids), []);

// --- fields ------------------------------------------------------------------------------------------

// The floating label of a field: it rests inside the empty control and floats onto its border
// when the control has the focus or a value; the border leaves a notch for it (the legend, as wide
// as the label, never shown), so the label needs no background and fits any surface
const notch = label => h('fieldset', { class: 'md-field__outline', 'aria-hidden': 'true' }, h('legend', {}, label ? h('span', {}, label) : ''));
const floatLabel = (label, id) => label && h('label', { class: 'md-field__label', for: id }, label);

// An outlined text field. The text is the field's own while it is typed and follows the value
// of the model when that changes (undo, a rename somewhere else). oninput / onchange / onenter
// get (text, f), f.setError(msg) shows a message below the field; trailing: a node inside the
// field, behind the text (a button)
export function Field(o) {
  const id = useId();
  const [text, setText] = useState(o.value ?? '');
  const [ownError, setOwnError] = useState(undefined);
  const control = useRef(null);
  // the value of the model arrives while the field is not being typed in: a model that tidies the
  // text (trims it, makes '' of '0') must not take the space just typed away
  const focused = () => control.current && document.activeElement === control.current;
  useEffect(() => { if (!focused()) setText(o.value ?? ''); }, [o.value]);
  useEffect(() => { setOwnError(undefined); }, [o.error, o.value]);
  const error = ownError === undefined ? o.error : ownError;
  const f = { setError: msg => setOwnError(msg || null), get control() { return control.current; } };
  const tag = o.multiline ? 'textarea' : 'input';
  const support = error || o.support;
  // a placeholder of its own is shown in the field: the label floats above it from the start
  const number = !o.multiline && o.type === 'number';      // its arrows: spinArrows
  return h('div', { class: `md-field ${o.mono ? 'md-field--mono' : ''} ${o.dense ? 'md-field--dense' : ''} ${error ? 'md-field--error' : ''} ${o.placeholder ? 'md-field--float' : ''} ${number ? 'md-field--number' : ''} ${o.cls || ''}`, 'data-tip': o.tip },
    h('div', { class: `md-field__box ${number ? 'num-spin-host' : ''}` }, h(tag, {
      id, ref: control, class: `md-field__control ${o.controlClass || ''}`, type: o.multiline ? undefined : (o.type || 'text'),
      placeholder: o.placeholder || ' ', 'data-i18n': o.i18n === false ? 'off' : undefined, rows: o.rows, spellcheck: o.spellcheck ?? false, disabled: o.disabled,
      autocomplete: 'off', inputmode: o.inputmode, wrap: o.wrap, title: error || undefined, value: text, min: o.min, max: o.max, step: o.step, ...NO_AUTOFILL,
      oninput: e => { setText(e.target.value); o.oninput?.(e.target.value, f); },
      onchange: e => o.onchange?.(e.target.value, f),
      onblur: () => { if (o.oninput && !o.onchange) setText(o.value ?? ''); },     // typed live: now the text of the model
      onkeydown: e => { o.onkeydown?.(e, f); if (e.key === 'Enter' && !o.multiline && o.onenter) { e.preventDefault(); o.onenter(e.target.value, f); } },
    }),
    notch(o.label), floatLabel(o.label, id),
    o.list && !o.disabled && h('button', {
      class: 'md-field__list', type: 'button', tabindex: -1, 'aria-label': '§0414',
      onclick: e => listMenu(e.currentTarget, o.list, v => {   // as if it had been typed
        setText(v);
        if (o.oninput) o.oninput(v, f);
        else o.onchange?.(v, f);
      }),
    }),
    number && !o.disabled && spinArrows(),
    o.trailing),
    support && h('div', { class: 'md-field__support' }, support));
}
export const field = (o = {}) => h(Field, o);

// The suggestions of a field ('list': the id of a datalist in the page). The browser draws an
// arrow of its own into an input with a 'list' attribute, in its internal shadow DOM where no
// stylesheet reaches it - so the field has no attribute and opens the list itself, in the menu
// of the editor and with its own arrow
function listMenu(anchor, id, pick) {
  const dl = document.getElementById(id);
  const items = [...(dl?.options ?? [])].map(opt => ({ label: opt.value, hint: opt.label !== opt.value ? opt.label : undefined, onclick: () => pick(opt.value) }));
  openMenu(anchor, items.length ? items : [{ label: '§0415', disabled: true }]);
}

// An outlined select. options: strings, {value, label} or {group, options}; a value that is not
// among them is listed as unknown, so the select never shows something the model does not hold
export function Select(o) {
  const id = useId();
  const opts = (o.options || []).map(x => (typeof x === 'object' ? x : { value: x, label: x }));
  const flat = opts.flatMap(x => (x.group ? x.options : [x]));
  const value = o.value ?? flat[0]?.value ?? '';
  const unknown = o.value != null && !flat.some(x => String(x.value) === String(o.value));
  const option = x => h('option', { value: x.value, selected: String(x.value) === String(value) }, x.label ?? x.value);
  // hideLabel: the label is not shown - in a bar, next to the title of its view - but it is the tip and the name of the select
  const shown = o.label && !o.hideLabel;
  // a select always shows a value: its label floats
  return h('div', { class: `md-field md-field--float ${o.dense ? 'md-field--dense' : ''} ${o.cls || ''}`, 'data-tip': o.tip ?? (o.hideLabel ? o.label : undefined) },
    h('div', { class: 'md-field__box' }, h('select', { id, class: 'md-field__control', value: String(value), disabled: o.disabled, 'aria-label': o.hideLabel ? o.label : undefined,
      onchange: e => {
        const v = e.target.value;
        o.onchange?.(v);
        // the select shows what the model holds: after the change that is the choice - or, when the
        // model did not take it (a dialog was cancelled), the value before
        queueMicrotask(() => { if (e.target.isConnected && e.target.dataset.model != null) e.target.value = e.target.dataset.model; });
      }, 'data-model': String(value) },
    unknown && h('option', { value: o.value, selected: true }, tr('§0001', o.value)),
    opts.map(x => (x.group ? h('optgroup', { label: x.group }, x.options.map(option)) : option(x)))),
    notch(shown && o.label), floatLabel(shown && o.label, id)));
}
export const select = (o = {}) => h(Select, o);

// toggles: buttons after the choices, each on or off by itself ({ label, on, tip, onchange(on) }; with
// icon only the icon shows, the label is its name for a screen reader);
// cls 'md-segmented--fill': the bar is as wide as its column, its buttons narrow. The chosen button
// shows by its background, no check mark
export function Segmented({ options, value, onchange, toggles = [], cls = '' }) {
  const [own, setOwn] = useState(value);
  useEffect(() => { setOwn(value); }, [value]);
  return h('div', { class: `md-segmented ${cls}`, role: 'group' }, options.map(opt => {
    const o = typeof opt === 'object' ? opt : { value: opt, label: opt };
    const on = String(o.value) === String(own);
    return h('button', { type: 'button', 'aria-pressed': String(on), 'data-v': o.value, 'data-tip': o.tip,
      onclick: () => { setOwn(o.value); onchange(o.value); } }, o.label);
  }), toggles.map((t, k) => h('button', { type: 'button', class: `md-segmented__toggle${k ? '' : ' md-segmented__toggle--first'}`,
    'aria-pressed': String(!!t.on), 'aria-label': t.icon ? t.label : undefined, 'data-tip': t.tip, onclick: () => t.onchange(!t.on) },
    t.icon ? icon(t.icon, 'msr--sm') : t.label)));
}
export const segmented = (options, value, onchange, toggles, cls) => h(Segmented, { options, value, onchange, toggles, cls });

// a slider with its label and value above the track: oninput while dragging, onchange when let
// go; format(value) is the shown value
export function Slider(o) {
  const [own, setOwn] = useState(Number(o.value));
  useEffect(() => { setOwn(Number(o.value)); }, [o.value]);
  const show = v => (o.format ? o.format(v) : String(v));
  return h('div', { class: `md-slider ${o.cls || ''}`, 'data-tip': o.tip },
    h('div', { class: 'md-slider__head' }, o.label ? h('span', { class: 'md-slider__label' }, o.label) : '', h('span', { class: 'md-slider__value' }, show(own))),
    h('input', { type: 'range', class: 'md-slider__input', min: o.min ?? 0, max: o.max ?? 100, step: o.step ?? 1, value: own, disabled: o.disabled,
      oninput: e => { const v = Number(e.target.value); setOwn(v); o.oninput?.(v); },
      onchange: e => o.onchange?.(Number(e.target.value)) }));
}
export const slider = (o = {}) => h(Slider, o);

export function checkbox(label, checked, onchange, extra = {}) {
  return h('label', { class: 'md-checkbox', 'data-tip': extra.tip }, h('input', { type: 'checkbox', checked: !!checked, disabled: extra.disabled,
    onchange: e => onchange(e.target.checked) }), label);
}

// an accordion entry: the header opens and closes it (ontoggle(open)), its buttons
// (actions) stay clickable; lead is shown before the title
export function accordion({ title, sub, open, ontoggle, actions = [], content = [], lead, cls = '' }) {
  const toggle = () => ontoggle?.(!open);
  return h('div', { class: `md-accordion ${open ? 'md-accordion--open' : ''} ${cls}` },
    h('div', {
      class: 'md-accordion__head', role: 'button', tabindex: 0, 'aria-expanded': String(!!open),
      onclick: e => { if (!e.target.closest('button, input, select, label, .md-field')) toggle(); },
      onkeydown: e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); toggle(); } },
    },
    icon('expand_more', 'md-accordion__chevron'), lead ?? '',
    h('div', { class: 'md-accordion__text' }, h('span', { class: 'md-label-large' }, title), sub ? h('span', { class: 'md-body-small' }, sub) : ''),
    ...actions),
    open ? h('div', { class: 'md-accordion__body' }, content) : '');
}

// a combobox of chips: the chosen values as chips with a remove button, and an input that
// lists the other options (typing filters them). options: {value, label, chip, hint, warn};
// onchange(values) with the new list; at least `min` values stay, at most `max` (then the input
// goes until a chip is removed). repeat: a value may be chosen more than once (the frames of an
// animation) - the list offers every option, and a chip goes by its place in the list
export function ChipSelect(o) {
  const id = useId();
  const min = o.min ?? 0, values = o.values || [], full = o.max != null && values.length >= o.max;
  const byValue = new Map((o.options || []).map(x => [x.value, x]));
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef(null), input = useRef(null);
  const q = query.trim().toLowerCase();
  const shown = full ? [] : (o.options || []).filter(x => (o.repeat || !values.includes(x.value)) && (!q || `${x.value} ${x.label} ${x.hint ?? ''}`.toLowerCase().includes(q)));
  const at = Math.min(active, Math.max(0, shown.length - 1));
  const set = next => o.onchange?.(next);
  const add = opt => { setQuery(''); setActive(0); set([...values, opt.value]); };
  // the list floats over the page, below the box (above it near the bottom of the window); one
  // list while it is open, updated in place as the typing filters it (floater)
  const pop = useRef(null);
  pop.current ??= floater();
  useLayoutEffect(() => () => pop.current.close(), []);
  useLayoutEffect(() => {
    if (!open || !shown.length) { pop.current.close(); return; }
    const r = box.current.getBoundingClientRect();
    pop.current.show(h('div', { class: 'md-menu md-chips__list', role: 'listbox', style: { minWidth: r.width + 'px' } },
      shown.map((x, k) => h('button', { class: `md-menu__item ${k === at ? 'md-menu__item--active' : ''}`, role: 'option', type: 'button', tabindex: -1,
        onpointerdown: e => e.preventDefault(),               // the input keeps the focus
        onclick: () => add(x) }, icon(x.warn ? 'warning' : 'add'), h('span', {}, x.label), x.hint && h('kbd', {}, x.hint)))), r);
  });
  return h('div', { class: `md-field md-field--float md-chips ${o.dense ? 'md-field--dense' : ''} ${o.cls || ''}` },
    h('div', { class: 'md-field__box' }, h('div', { class: 'md-chips__box', ref: box, onpointerdown: e => { if (e.target === box.current && input.current) { e.preventDefault(); input.current.focus(); } } },
      values.map((v, k) => {
        const opt = byValue.get(v) ?? { value: v, label: tr('§0001', v), warn: true };
        return h('span', { key: o.repeat ? `${k}:${v}` : v, class: 'md-chip md-chip--selected md-chip--sm md-chips__chip', 'data-tip': opt.hint ? tr('§1083', opt.label, opt.hint) : opt.label },
          opt.warn && icon('warning'), opt.chip ?? opt.label,
          h('button', { class: 'md-chips__remove', type: 'button', 'aria-label': tr('§0002', opt.label), disabled: values.length <= min,
            onclick: e => { e.stopPropagation(); set(values.filter((x, i) => (o.repeat ? i !== k : x !== v))); } }, icon('close')));
      }),
      full ? '' : h('input', { id, ref: input, class: 'md-chips__input', placeholder: o.placeholder || '§0003', autocomplete: 'off', spellcheck: false, value: query, ...NO_AUTOFILL,
        onfocus: () => setOpen(true), onblur: () => setOpen(false),
        oninput: e => { setQuery(e.target.value); setActive(0); setOpen(true); },
        onkeydown: e => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!open) return setOpen(true);
            if (shown.length) setActive((at + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (open && shown[at]) add(shown[at]);
          } else if (e.key === 'Escape' && open) {
            e.stopPropagation();
            setOpen(false);
          } else if (e.key === 'Backspace' && !query && values.length > min) set(values.slice(0, -1));
        } })),
    notch(o.label), floatLabel(o.label, id)));
}
export const chipSelect = (o = {}) => h(ChipSelect, o);

// a node that floats over the page next to the rectangle r, until the returned function is called
export function floating(vnode, r) {
  const f = floater();
  f.show(vnode, r);
  return f.close;
}

// a floating element that stays while it is shown: show() renders into the same host again and
// moves it, so a list that changes with every key (the suggestions of the code area) is updated
// in place and does not play its opening animation again; close() takes it away
export function floater() {
  let host = null;
  return {
    show(vnode, r) {
      if (!host) {
        host = document.createElement('div');
        host.style.cssText = 'position:fixed;z-index:1000;left:0;top:0';
        (document.getElementById('overlay-root') || document.body).append(host);
      }
      render(vnode, host);
      const el = host.firstElementChild;
      if (el) {
        el.style.position = 'fixed';
        el.style.left = Math.max(8, Math.min(r.left, innerWidth - el.offsetWidth - 8)) + 'px';
        const below = r.bottom + 4;
        el.style.top = (below + el.offsetHeight > innerHeight - 8 ? Math.max(8, r.top - el.offsetHeight - 4) : below) + 'px';
      }
    },
    close() {
      if (!host) return;
      render(null, host);
      host.remove();
      host = null;
    },
  };
}

// --- sections and the side panel -------------------------------------------------------------------------

// the closed sections of a panel, remembered by title under a key of the local storage
const closedSets = new Map();
function closedSections(storageKey) {
  if (!closedSets.has(storageKey)) {
    let list = [];
    try { list = JSON.parse(localStorage.getItem(storageKey) ?? '[]'); } catch { /* private mode */ }
    const s = signal(new Set(list));
    effect(() => { try { localStorage.setItem(storageKey, JSON.stringify([...s.value])); } catch { /* private mode */ } });
    closedSets.set(storageKey, s);
  }
  return closedSets.get(storageKey);
}

// A section of a panel: a title, an action in its head, the content. With storageKey it opens
// and closes with a click on its head; "Chapters (2)" is remembered as "Chapters"
export function Section({ title, action, storageKey, cls = '', children }) {
  const closed = storageKey ? closedSections(storageKey) : null;
  const name = String(title).replace(/\s*\(\d+\)$/, '');
  const isClosed = !!closed?.value.has(name);
  const set = on => { const next = new Set(closed.value); if (on) next.add(name); else next.delete(name); closed.value = next; };
  return h('div', { class: `section ${closed ? 'section--collapsible' : ''} ${isClosed ? 'section--collapsed' : ''} ${cls}` },
    h('div', { class: 'section__head',
      // a button of the head opens the section first: what it adds is seen
      onclickcapture: e => { if (closed && isClosed && e.target.closest('button')) set(false); },
      onclick: e => { if (closed && !e.target.closest('button, input, select, textarea, label, a')) set(!isClosed); } },
    closed && icon('expand_more', 'section__chevron'), h('span', { class: 'section__title' }, title), action),
    children);
}
export const section = (title, content, action, storageKey = null) => h(Section, { title, action, storageKey }, content);

// One panel on the right per view (the inspector of the storyboard, the tools of the editors);
// it folds to a narrow strip and unfolds again, and every view shares the state.
const SIDE_KEY = 'side.collapsed';
export const sideCollapsed = signal((() => { try { return localStorage.getItem(SIDE_KEY) === '1'; } catch { return false; } })());
export function setSideCollapsed(on) {
  try { localStorage.setItem(SIDE_KEY, on ? '1' : '0'); } catch { /* private mode */ }
  sideCollapsed.value = on;
  document.querySelectorAll('.side').forEach(el => el.classList.toggle('side--collapsed', on));   // the panels not rendered here yet
}
if (typeof window !== 'undefined') addEventListener('side-collapsed', e => { sideCollapsed.value = !!e.detail; });

// its width, shared by every view like the folded state: dragged at the left edge of the panel
// (sideGrip), null - the width of the panel of the view (app.css). Kept in the browser; the width
// the inspector had is taken over
const WIDTH_KEY = 'side.width', MIN_SIDE = 280, MAX_SIDE = 0.75;
const clampSide = w => Math.round(Math.max(MIN_SIDE, Math.min(w, (typeof innerWidth === 'number' ? innerWidth : 1600) * MAX_SIDE)));
export const sideWidth = signal((() => {
  try { const w = Number(localStorage.getItem(WIDTH_KEY) ?? localStorage.getItem('inspector.width')); return w > 0 ? w : null; } catch { return null; }
})());
export function setSideWidth(w) {
  sideWidth.value = w == null ? null : clampSide(w);
  try { if (w == null) localStorage.removeItem(WIDTH_KEY); else localStorage.setItem(WIDTH_KEY, String(sideWidth.value)); } catch { /* private mode */ }
}
// the width of a side panel as its style: null - its own
export const sideWidthPx = () => (sideWidth.value ? `${clampSide(sideWidth.value)}px` : '');
// every side panel follows at once - also those not rendered again now (like setSideCollapsed)
if (typeof document !== 'undefined') effect(() => { const w = sideWidthPx(); document.querySelectorAll('.side').forEach(el => { el.style.width = w; }); });

// the left edge of a side panel: dragged it resizes the panel (it grows to the left), a double
// click gives it its own width again, the arrow keys move it
export const sideGrip = () => h('div', { class: 'sheet__resize', tabindex: '0', role: 'separator', 'aria-orientation': 'vertical',
  'aria-label': '§0402', 'data-tip': '§0403',
  onpointerdown: e => {
    e.preventDefault();
    const g = e.currentTarget, x0 = e.clientX, w0 = g.closest('.side').getBoundingClientRect().width;
    g.setPointerCapture(e.pointerId);
    document.body.classList.add('col-resizing');
    const move = ev => { sideWidth.value = clampSide(w0 + (x0 - ev.clientX)); };
    const stop = () => {
      g.removeEventListener('pointermove', move);
      g.removeEventListener('pointerup', stop);
      g.removeEventListener('pointercancel', stop);
      document.body.classList.remove('col-resizing');
      setSideWidth(sideWidth.value);
    };
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', stop);
    g.addEventListener('pointercancel', stop);
  },
  ondblclick: () => setSideWidth(null),
  onkeydown: e => {
    const step = { ArrowLeft: 24, ArrowRight: -24 }[e.key];
    if (!step) return;
    e.preventDefault();
    setSideWidth(e.currentTarget.closest('.side').getBoundingClientRect().width + step);
  } });

export const sideStrip = (label = '') => h('div', { class: 'side__strip' },
  iconButton('right_panel_open', '§0004', () => setSideCollapsed(false)),
  h('span', { class: 'side__strip-label' }, label));
export const sideCollapseButton = () => iconButton('right_panel_close', '§0005', () => setSideCollapsed(true));

// the panel of a view on the right: what the view shows settings of - a head with the title and the
// content; it folds to a strip and is resized at its left edge, both shared by every view
export function SidePanel({ label, cls = 'screen-side', children }) {
  return h('aside', { class: `${cls} side ${sideCollapsed.value ? 'side--collapsed' : ''}`, style: { width: sideWidthPx() } },
    sideStrip(label),
    sideGrip(),
    h('div', { class: 'side__head' }, h('span', { class: 'side__head-title' }, label), sideCollapseButton()),
    h('div', { class: 'side__content' }, children));
}
export const sidePanel = (label, content, cls) => h(SidePanel, { label, cls }, content);

// --- overlays: menus, dialogs, toasts -------------------------------------------------------------------------

const overlay = { menu: signal(null), dialogs: signal([]), toasts: signal([]) };
let overlayHost = null;
function ensureOverlays() {
  if (overlayHost || typeof document === 'undefined') return;
  overlayHost = document.createElement('div');
  overlayHost.id = 'pui-overlays';
  document.body.append(overlayHost);
  render(h(Overlays, {}), overlayHost);
  addEventListener('pointerdown', e => { if (overlay.menu.value && !e.target.closest?.('.md-menu')) closeMenu(); }, true);
  addEventListener('keydown', e => {
    if (overlay.menu.value) return menuKey(e);
    const top = overlay.dialogs.value.at(-1);
    if (top) dialogKey(e, top);
  }, true);
  addEventListener('resize', closeMenu);
}

function Overlays() {
  return h(Fragment, {},
    overlay.dialogs.value.map(d => h(DialogBox, { key: d.id, d })),
    overlay.menu.value && h(MenuBox, { key: overlay.menu.value.id, m: overlay.menu.value }),
    h('div', { id: 'pui-toasts', class: 'md-toasts' }, overlay.toasts.value.map(t => h(Toast, { key: t.id, t }))));
}

// items: {label, icon, onclick, disabled, danger, kbd, checked} | {divider: true} | {header: '...'};
// content: a node below the items (a picker) - it closes the menu itself (closeMenu)
export function openMenu(anchor, items, content = null) {
  ensureOverlays();
  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  overlay.menu.value = { id: ++ids, r, items: items.filter(Boolean), content };
}
export function closeMenu() { if (overlay.menu.value) overlay.menu.value = null; }

function MenuBox({ m }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current, { r } = m;
    let x = r.left, y = r.bottom + 4;
    if (x + el.offsetWidth > innerWidth - 8) x = Math.max(8, r.right - el.offsetWidth);
    if (y + el.offsetHeight > innerHeight - 8) y = Math.max(8, r.top - el.offsetHeight - 4);
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    (el.querySelector('[data-autofocus]') ?? el.querySelector('button:not([disabled])'))?.focus({ preventScroll: true });
  }, [m.id]);
  const item = it => h('button', { class: `md-menu__item ${it.danger ? 'md-menu__item--danger' : ''} ${it.checked ? 'md-menu__item--checked' : ''}`,
    role: 'menuitem', type: 'button', disabled: it.disabled, 'data-tip': it.tip,
    onclick: e => { e.stopPropagation(); closeMenu(); it.onclick?.(); } },
  // checkbox: true/false - the item is a checkbox (its onclick turns it over), else an icon
  it.checkbox != null ? h('span', { class: 'md-checkbox md-menu__checkbox' }, h('input', { type: 'checkbox', checked: !!it.checkbox, tabindex: -1 }))
    : it.icon ? icon(it.icon) : h('span', { class: 'msr' }),
  h('span', {}, it.label), it.kbd && h('kbd', {}, it.kbd));
  // trailing: { icon, tip, onclick } - a button of its own at the right end of the item (a button
  // cannot hold another one: the two side by side in a row)
  const trailing = t => h('button', { class: 'md-icon-button md-icon-button--sm md-menu__trailing', role: 'menuitem', type: 'button',
    'data-tip': t.tip, 'aria-label': t.tip, onclick: e => { e.stopPropagation(); closeMenu(); t.onclick(); } }, icon(t.icon));
  return h('div', { class: 'md-menu', role: 'menu', ref },
    m.items.map(it => (it.divider ? h('div', { class: 'md-menu__divider' })
      : it.header ? h('div', { class: 'md-menu__header' }, it.header)
        : it.trailing ? h('div', { class: 'md-menu__row' }, item(it), trailing(it.trailing))
          : item(it))),
    m.content);
}

function menuKey(e) {
  if (e.key === 'Escape') { closeMenu(); e.stopPropagation(); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const items = [...document.querySelectorAll('.md-menu button:not([disabled])')];
  const k = items.indexOf(document.activeElement);
  items[(k + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  e.preventDefault();
}

// A dialog. content: nodes; actions: {label, value, variant, danger, icon, onclick} - onclick may
// return false to keep it open; onclose(value) with the value of the action, null when dismissed
// outside: false - a click beside the dialog does not close it (the wizard: its steps would be lost)
export function dialog({ title, content, actions = [], onclose, wide, outside = true }) {
  ensureOverlays();
  const d = { id: ++ids, title, content, actions, wide, outside, close: value => {
    if (!overlay.dialogs.value.includes(d)) return;
    overlay.dialogs.value = overlay.dialogs.value.filter(x => x !== d);
    onclose?.(value);
  } };
  overlay.dialogs.value = [...overlay.dialogs.value, d];
  return d;
}

// actions: a list, or a function that gives it - a dialog of steps (wizard.js) shows other
// buttons on each step; the signals it reads render them again
const actionsOf = d => (typeof d.actions === 'function' ? d.actions() : d.actions).filter(Boolean);
const runAction = async (d, a) => { if ((await a.onclick?.()) !== false) d.close(a.value); };
function dialogKey(e, d) {
  if (e.key === 'Escape') { e.stopPropagation(); d.close(null); }
  const acts = actionsOf(d);
  // Enter: the last button - not in a content that keeps Enter for its fields ([data-keep-enter], the settings)
  if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && !e.target.closest?.('[data-keep-enter]') && acts.length) { e.preventDefault(); runAction(d, acts.at(-1)); }
}

function DialogBox({ d }) {
  const box = useRef(null);
  useEffect(() => { setTimeout(() => (box.current?.querySelector('input, select, textarea') ?? box.current?.querySelector('.md-dialog__actions button:last-child'))?.focus(), 30); }, []);
  return h('div', { class: 'md-dialog-scrim', onpointerdown: e => { if (e.target === e.currentTarget && d.outside) d.close(null); } },
    h('div', { class: 'md-dialog', role: 'dialog', 'aria-modal': 'true', ref: box, style: d.wide ? { width: 'min(760px, 100%)' } : null },
      h('h2', { class: 'md-dialog__title' }, d.title),
      h('div', { class: 'md-dialog__content' }, d.content),
      h('div', { class: 'md-dialog__actions' }, actionsOf(d).map(a => button(a.label, {
        variant: a.variant || (a.danger ? 'filled' : 'outlined'), icon: a.icon, cls: a.danger ? 'md-button--danger' : '',   // shadcn: outline, or destructive
        onclick: () => runAction(d, a) })))));
}

// fields: {name, label, value, options?, radios?, onchange?(value, dlg), validate?(value, values) -> msg, mono, support, placeholder,
//   when?(values) -> false: the field is not shown (and not validated) while the other values say so,
//   spin?(values) -> {min, max}: a number field with the arrows of the browser, in these bounds,
//   row: fields next to each other that have the same row}
// resolves to the values by name, or null. dlg: { values(), set(name, value) }
export function promptDialog({ title, text, fields, ok = 'OK' }) {
  return new Promise(resolve => {
    const values = signal(Object.fromEntries(fields.map(f => [f.name, String(f.value ?? (f.radios ? f.radios[0]?.value : f.options ? (typeof f.options[0] === 'object' ? f.options[0]?.value : f.options[0]) : '') ?? '')])));
    const errors = signal({});
    const dlg = { values: () => trimmed(), set: (name, v) => { values.value = { ...values.value, [name]: v }; errors.value = { ...errors.value, [name]: null }; } };
    const trimmed = () => Object.fromEntries(Object.entries(values.value).map(([k, v]) => [k, String(v).trim()]));
    const change = (f, v) => { values.value = { ...values.value, [f.name]: v }; f.onchange?.(v, dlg); };
    const one = f => (
      f.radios ? h('div', { key: f.name, class: 'md-radio-group', role: 'radiogroup', 'aria-label': f.label }, f.label && h('div', { class: 'md-label-large' }, f.label),
        f.radios.map(r => h('label', { class: 'md-radio' }, h('input', { type: 'radio', name: 'r-' + f.name, value: r.value, checked: values.value[f.name] === r.value, onchange: () => change(f, r.value) }), r.label)))
        : f.options ? h(Fragment, { key: f.name }, select({ label: f.label, value: values.value[f.name], options: f.options, onchange: v => change(f, v) }))
          : h(Fragment, { key: f.name }, field({ label: f.label, value: values.value[f.name], mono: f.mono, support: f.support, placeholder: f.placeholder, error: errors.value[f.name] || undefined,
            oninput: v => change(f, v), ...(f.spin ? { type: 'number', ...f.spin(trimmed()) } : {}) })));
    // keyed: a field shown later (when) is not given the input of another; the fields of a row side by side
    const Form = () => {
      const shown = fields.filter(f => f.when?.(trimmed()) ?? true), out = [];
      for (const f of shown) {
        const last = out.at(-1);
        if (f.row && last?.row === f.row) last.fields.push(f);
        else out.push({ row: f.row, fields: [f] });
      }
      return h(Fragment, {}, text && h('div', { class: 'md-body-medium' }, text),
        out.map(g => (g.row ? h('div', { key: 'row:' + g.row, class: 'grid2 md-dialog__row' }, g.fields.map(one)) : one(g.fields[0]))));
    };
    dialog({
      title, content: h(Form, {}),
      actions: [
        { label: '§0006', value: null },
        { label: ok, variant: 'filled', onclick: () => {
          const v = trimmed(), found = {};
          for (const f of fields) { const msg = (f.when?.(v) ?? true) && f.validate?.(v[f.name], v); if (msg) found[f.name] = msg; }
          errors.value = found;
          if (Object.keys(found).length) return false;
          resolve(v);
          return true;
        } },
      ],
      onclose: value => { if (value == null) resolve(null); },
    });
  });
}

export function confirmDialog({ title, text, ok = 'OK', danger }) {
  return new Promise(resolve => {
    dialog({ title, content: h('div', { class: 'md-body-medium' }, text),
      actions: [{ label: '§0006', value: false }, { label: ok, value: true, variant: 'filled', danger }], onclose: v => resolve(!!v) });
  });
}

// Before anything is deleted, removed or cleared - one dialog for the whole editor, its text
// told by the place it is asked from. what: the thing in words ("the place 'hall'"); detail: what
// goes with it, or what stays; kind: the sort of thing - "Don't ask again" stops the questions
// for that kind until the editor is loaded again; verb: 'delete' | 'remove' | 'clear' (the
// button); undo: false when the undo cannot bring it back. Resolves true to go on
const unasked = new Set();
export function confirmRemove({ what, detail = null, kind = null, verb = 'delete', undo = true }) {
  if (kind && unasked.has(kind)) return Promise.resolve(true);
  const title = { delete: '§1425', remove: '§1426', clear: '§1427', reset: '§1518' }[verb] ?? '§1425';
  const ok = { delete: '§1428', remove: '§1429', clear: '§1430', reset: '§1519' }[verb] ?? '§1428';
  let again = false;
  return new Promise(resolve => {
    dialog({ title: tr(title, what),
      content: h('div', { class: 'confirm-remove' },
        detail && h('div', { class: 'md-body-medium' }, detail),
        h('div', { class: 'md-body-medium confirm-remove__undo' }, undo ? '§1431' : '§1432'),
        kind && h('div', { style: { marginTop: '12px' } }, checkbox('§1433', false, v => { again = v; }))),
      actions: [{ label: '§0006', value: false }, { label: ok, value: true, variant: 'filled', danger: true, icon: verb === 'clear' ? 'delete_sweep' : verb === 'reset' ? 'restart_alt' : 'delete' }],
      onclose: v => { if (v && again && kind) unasked.add(kind); resolve(!!v); } });
  });
}

// a toast at the bottom right; several stack, the oldest goes when there are more than three
const MAX_TOASTS = 3;
export function snackbar(text, { action, onaction, timeout = 4000, error } = {}) {
  ensureOverlays();
  const t = { id: ++ids, text, action, onaction, error };
  overlay.toasts.value = [...overlay.toasts.value, t].slice(-MAX_TOASTS);
  if (timeout) setTimeout(() => dropToast(t), timeout);
  return t;
}
const dropToast = t => { overlay.toasts.value = overlay.toasts.value.filter(x => x !== t); };

function Toast({ t }) {
  return h('div', { class: `md-toast ${t.error ? 'md-toast--error' : ''}`, role: 'status' },
    t.error && icon('error', 'msr--sm'),
    h('div', { class: 'md-toast__text' }, t.text),
    t.action && button(t.action, { variant: 'outlined', cls: 'md-button--small', onclick: () => { dropToast(t); t.onaction?.(); } }),
    iconButton('close', '§0007', () => dropToast(t), 'md-icon-button--xs md-toast__close'));
}

// --- tooltips: every element with data-tip ------------------------------------------------------------------

export function initTooltips() {
  let tip = null, timer = null, target = null;
  const hide = () => { clearTimeout(timer); tip?.remove(); tip = null; target = null; };
  document.addEventListener('pointerover', e => {
    const t = e.target.closest?.('[data-tip]');
    if (t === target) return;
    hide();
    if (!t || !t.dataset.tip || e.pointerType === 'touch') return;
    target = t;
    timer = setTimeout(() => {
      if (!t.isConnected) return;
      tip = document.createElement('div');
      tip.className = 'md-tooltip';
      tip.textContent = t.dataset.tip;
      document.body.append(tip);
      const r = t.getBoundingClientRect();
      const x = Math.max(8, Math.min(r.left + r.width / 2 - tip.offsetWidth / 2, innerWidth - tip.offsetWidth - 8));
      let y = r.bottom + 6;
      if (y + tip.offsetHeight > innerHeight - 8) y = r.top - tip.offsetHeight - 6;
      tip.style.left = x + 'px';
      tip.style.top = y + 'px';
    }, 500);
  });
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('wheel', hide, { passive: true, capture: true });
}

// --- elements made by hand ------------------------------------------------------------------------------
// dh(tag, props, ...children): a real element, for what an editor draws on and keeps - a canvas
// with its pointer handlers, a grid of 256 little canvases. A view shows it with dom(node).
export function dh(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = list => { for (const c of list) { if (c == null || c === false) continue; if (Array.isArray(c)) add(c); else el.append(c instanceof Node ? c : document.createTextNode(String(c))); } };
  add(children);
  return el;
}
