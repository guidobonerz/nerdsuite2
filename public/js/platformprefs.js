// platformprefs.js - the BASIC and assembler properties of each platform as the Settings set them (Editor ›
// BASIC per platform): kept in this browser, over the defaults of platforms.js. No UI here: the build
// (nsbuild.js) reads them too.
//
//   basicLine  the longest BASIC line (as typed in, with its line number); 0: no limit

import { platformOf } from './platforms.js';

const KEY = 'ns-platform-prefs';
const DEFAULTS = { basicLine: 0 };

let prefs = {};
try { prefs = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '{}') ?? {}; } catch { prefs = {}; }

// the value of a property of a platform: the setting, else the default of the platform
export function platformPref(id, key) {
  const v = prefs[id]?.[key];
  return v ?? platformOf(id)[key] ?? DEFAULTS[key];
}

// whether a property has a setting of its own (not the default of the platform)
export const isPlatformPrefSet = (id, key) => prefs[id]?.[key] != null;

// set a property (null: back to the default of the platform)
export function setPlatformPref(id, key, value) {
  const p = { ...prefs[id] };
  if (value == null) delete p[key]; else p[key] = value;
  prefs = { ...prefs, [id]: p };
  if (!Object.keys(p).length) delete prefs[id];
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
}

// every setting back to the defaults of the platforms
export function resetPlatformPrefs() {
  prefs = {};
  try { globalThis.localStorage?.removeItem(KEY); } catch { /* private mode */ }
}
