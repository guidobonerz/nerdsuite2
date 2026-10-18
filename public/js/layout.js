// layout.js - where the files of a project live (project format 2, migrate.js):
//   NAME.adv, PLACE.adv ...   every script at the top level
//   gfx/screen/   the screens of the places (.scr; .gfx before format 2, renamed)
//   gfx/sprite/   the costumes and the sprites (.spr)
//   gfx/charset/  the charsets (.chr, .bin, .raw)
//   gfx/tiles/    the tilesets (.til)
//   gfx/bitmap/   the pictures (.kla, .koa, .art)
//   audio/music/  the music of the Composer (.sng)
//   audio/effects/ its sound effects (.sng)
//   reference/    the images the sprite and bitmap editors trace (not a part of the game)
// The editor proposes these folders for the files it makes; relayout() moves the files of an older
// project into them and rewrites the paths that name them.

export const LAYOUT = {
  screen: 'gfx/screen', sprite: 'gfx/sprite', charset: 'gfx/charset', tiles: 'gfx/tiles', bitmap: 'gfx/bitmap',
  music: 'audio/music', effects: 'audio/effects',
};

const extOf = p => (/\.[^./]*$/.exec(p)?.[0] ?? '').toLowerCase();
const baseOf = p => p.split('/').pop();
const dirOf = p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');

// a path with ./ and ../ resolved; null when it leaves the project
export function normalizePath(p) {
  const out = [];
  for (const s of p.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') { if (!out.length) return null; out.pop(); } else out.push(s);
  }
  return out.join('/');
}
// the path of `to` seen from the folder `from` ('gfx/tiles/' -> 'gfx/charset/a.chr': '../charset/a.chr')
export function relativeFrom(from, to) {
  const a = from.split('/').filter(Boolean), b = to.split('/');
  let k = 0;
  while (k < a.length && k < b.length - 1 && a[k] === b[k]) k++;
  return [...a.slice(k).map(() => '..'), ...b.slice(k)].join('/');
}

// the folder of a file of a game by its kind; song: 'music' or 'effects'; raw: a .bin/.raw file the
// script names as 'screen' or 'colormap' (screen codes, colors) goes with the screens, else with the charsets
export function layoutFolder(path, song = 'music', raw = 'charset') {
  const ext = extOf(path);
  if (ext === '.adv') return '';
  if (ext === '.scr' || ext === '.gfx') return LAYOUT.screen;
  if (ext === '.spr') return LAYOUT.sprite;
  if (['.bin', '.raw'].includes(ext)) return raw === 'screen' ? LAYOUT.screen : LAYOUT.charset;
  if (ext === '.chr') return LAYOUT.charset;
  if (ext === '.til') return LAYOUT.tiles;
  if (['.kla', '.koa', '.art'].includes(ext)) return LAYOUT.bitmap;
  if (ext === '.sng') return song === 'effects' ? LAYOUT.effects : LAYOUT.music;
  return null;
}

const dec = new TextDecoder(), enc = new TextEncoder();
const STRING = /"([^"\n]*)"/g;

// the scripts that no other one imports: the game (a project holds one); its folder is the base of
// every path in the scripts (advc/adv/import.go: they count from the main script)
function mainScript(files) {
  const scripts = [...files.keys()].filter(p => extOf(p) === '.adv').sort();
  const imported = new Set();
  for (const s of scripts) {
    for (const m of dec.decode(files.get(s)).matchAll(/^[ \t]*import[ \t]+"([^"\n]+)"/gm)) {
      for (const base of ['', dirOf(s)]) { const k = normalizePath(base + m[1]); if (k) imported.add(k); }
    }
  }
  return scripts.find(s => !imported.has(s)) ?? scripts[0] ?? null;
}

// the keyword of the first script line that names the file ('sound x "a.sng"': sound), or null
function usedAs(path, scriptTexts, base) {
  for (const text of scriptTexts) {
    for (const m of text.matchAll(/^[ \t]*([a-z]+)\b[^"\n]*"([^"\n]+)"/gm)) {
      if (normalizePath(base + m[2]) === path) return m[1];
    }
  }
  return null;
}

// music or effects for a song: its old folder (music/, sounds/), else how a script names it
// ('music ... "x.sng"' or 'sound ... "x.sng"'), else music
function songKind(path, scriptTexts, base) {
  if (/(^|\/)(sounds?|effects|sfx)\//i.test(path)) return 'effects';
  if (/(^|\/)music\//i.test(path)) return 'music';
  return usedAs(path, scriptTexts, base) === 'sound' ? 'effects' : 'music';
}

// the files of a project moved into the layout, and the paths that name them rewritten:
// { files, moved } - moved: [old, new] of every file that moved. Files of other kinds (reference/,
// others) stay where they are
export function relayout(files) {
  const main = mainScript(files);
  const base = main ? dirOf(main) : '';
  const texts = [...files].filter(([p]) => extOf(p) === '.adv').map(([, d]) => dec.decode(d));
  const map = new Map(), taken = new Set([...files.keys()].filter(p => layoutFolder(p) === null));
  const free = (folder, name) => {
    const dot = name.lastIndexOf('.'), stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
    let p = (folder ? `${folder}/` : '') + name;
    for (let k = 2; taken.has(p.toLowerCase()); k++) p = (folder ? `${folder}/` : '') + `${stem}-${k}${ext}`;
    taken.add(p.toLowerCase());
    return p;
  };
  // the main script first: it keeps its name at the top level
  const order = [...files.keys()].sort((a, b) => (a === main ? -1 : b === main ? 1 : a < b ? -1 : 1));
  for (const p of order) {
    const use = usedAs(p, texts, base);
    const folder = layoutFolder(p, extOf(p) === '.sng' ? songKind(p, texts, base) : 'music', use === 'screen' || use === 'colormap' ? 'screen' : 'charset');
    if (folder === null) continue;
    map.set(p, free(folder, baseOf(p).replace(/\.gfx$/i, '.scr')));   // a screen is .scr now
  }
  const moved = [...map].filter(([a, b]) => a !== b);
  const out = new Map();
  // a string of a script that names a file of the project: the new path, from the top level where
  // the main script is now
  const rewrite = text => text.replace(STRING, (s, q) => {
    const k = /^[a-z]+:|^\//i.test(q) ? null : normalizePath(base + q);
    return k != null && map.has(k) ? `"${map.get(k)}"` : s;
  });
  for (const [p, d] of files) {
    const to = map.get(p) ?? p;
    if (extOf(p) === '.adv') out.set(to, enc.encode(rewrite(dec.decode(d))));
    else if (extOf(p) === '.til') out.set(to, retargetTileset(d, dirOf(p), dirOf(to), map));
    else if (p.startsWith('reference/') && extOf(p) === '.json') out.set(to, retargetJson(d, map));
    else out.set(to, d);
  }
  return { files: out, moved };
}

// a tileset of version 2 names its charset relative to its own folder: from the new folder to the
// charset's new place (byte 5: size, 6: flags, 7: the length of the path, then the path)
function retargetTileset(bytes, fromDir, toDir, map) {
  if (bytes.length < 8 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'YTIL' || bytes[4] < 2) return bytes;
  const len = bytes[7], old = String.fromCharCode(...bytes.subarray(8, 8 + len));
  const key = normalizePath(fromDir + old);
  const target = key != null ? map.get(key) ?? key : null;
  if (target == null) return bytes;
  const now = relativeFrom(toDir, target);
  if (now === old || now.length > 255) return bytes;
  const path = [...now].map(c => c.charCodeAt(0) & 0xff);
  const out = new Uint8Array(bytes.length - len + path.length);
  out.set(bytes.subarray(0, 7));
  out[7] = path.length;
  out.set(path, 8);
  out.set(bytes.subarray(8 + len), 8 + path.length);
  return out;
}

// the places of the tracing references (reference/references.json): keys and values that are
// paths of moved files, as plain paths or after a 'kind:' prefix
function retargetJson(bytes, map) {
  let data;
  try { data = JSON.parse(dec.decode(bytes)); } catch { return bytes; }
  const fix = s => {
    if (typeof s !== 'string') return s;
    if (map.has(s)) return map.get(s);
    const at = s.indexOf(':');
    return at > 0 && map.has(s.slice(at + 1)) ? s.slice(0, at + 1) + map.get(s.slice(at + 1)) : s;
  };
  const walk = v => (Array.isArray(v) ? v.map(walk)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [fix(k), walk(x)])) : fix(v));
  return enc.encode(JSON.stringify(walk(data), null, 1));
}
