// animui.js - the timing slider of sprite, char and patch animations
//
// The speed of an animation is the number of frames (50 per second, PAL) each of its
// steps is shown; without one the engine uses DEFAULT_ANIM_SPEED.

import { DEFAULT_ANIM_SPEED } from './adv.js';
import { numValue } from './advgen.js';
import { slider } from './pui.js';
import { tr } from './i18n.js';

const SLIDER_MAX = 50;                   // one step per second; typed speeds up to 255 stay

export const speedOf = (speed, consts) => numValue(speed ?? String(DEFAULT_ANIM_SPEED), consts) || DEFAULT_ANIM_SPEED;

const steps = v => {
  const fps = 50 / v;
  return tr('§1071', v, v > 1 ? 's' : '', fps >= 10 ? Math.round(fps) : fps.toFixed(1));
};

// oninput(speed string) while dragging, onchange(speed string) when let go
export function speedSlider({ speed, consts, oninput, onchange }) {
  const v = speedOf(speed, consts);
  return slider({
    label: speed == null ? '§0024' : '§0025', min: 1, max: Math.max(SLIDER_MAX, v), value: v, format: steps,
    tip: '§0026', cls: 'anim-speed',
    oninput: n => oninput?.(String(n)), onchange: n => onchange?.(String(n)),
  });
}
