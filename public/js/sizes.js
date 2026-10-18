// sizes.js - a W x H size picker: 1x1, 1x2, 2x1, 2x2 or a custom size
//
// Used for the size of a costume in sprites and for brushes and tiles of chars.

import { h, useState, segmented, field } from './pui.js';

const PRESETS = [[1, 1], [1, 2], [2, 1], [2, 2]];

// onchange(w, h) gets numbers as typed; the caller checks the limits
function SizePicker({ w, h: height, onchange }) {
  const preset = PRESETS.some(([a, b]) => a === w && b === height);
  const [custom, setCustom] = useState(!preset);
  return h('div', { class: 'size-picker' },
    segmented([...PRESETS.map(([a, b]) => ({ value: `${a}x${b}`, label: `${a}×${b}` })), { value: 'custom', label: 'W×H' }],
      preset && !custom ? `${w}x${height}` : 'custom',
      v => { setCustom(v === 'custom'); if (v !== 'custom') onchange(...v.split('x').map(Number)); }),
    (custom || !preset) && h('div', { class: 'kv-row size-picker__custom' },
      field({ label: 'W', value: String(w), type: 'number', dense: true, mono: true, cls: 'w-sm', onchange: t => onchange(Math.round(Number(t)), height) }),
      h('span', { class: 'md-body-medium' }, '×'),
      field({ label: 'H', value: String(height), type: 'number', dense: true, mono: true, cls: 'w-sm', onchange: t => onchange(w, Math.round(Number(t))) })));
}
export const sizePicker = o => h(SizePicker, o);
