// adv.js - the model of the graphics of a project (assets.json, see assets.js) and of the
// adventure language it comes from: its nodes, constants and helpers, the traversal and the symbols.

export class AdvError extends Error {
  constructor(msg, line) {
    super(line ? `line ${line}: ${msg}` : msg);
    this.line = line;
    this.plain = msg;
  }
}

// the name of a handler from its words: onName('look') 'onLook', onName('pre', 'enter') 'onPreEnter'
export const onName = (...words) => 'on' + words.map(w => w[0].toUpperCase() + w.slice(1)).join('');


// --- helpers -------------------------------------------------------------------------

export const newId = () => 'n' + Math.random().toString(36).slice(2, 10);

const FP_SKIP = new Set(['id', 'src', 'fp', 'line']);
export function fingerprint(node) {
  return JSON.stringify(node, (k, v) => (FP_SKIP.has(k) || k.startsWith('_') ? undefined : v));
}

export const COLOR_NAMES = ['black', 'white', 'red', 'cyan', 'purple', 'green', 'blue', 'yellow',
  'orange', 'brown', 'lightred', 'darkgrey', 'grey', 'lightgreen', 'lightblue', 'lightgrey'];
export const UI_COLORS = ['cursor', 'actor', 'verb', 'highlight', 'inventory', 'sentence', 'message'];
export const UI_DEFAULTS = { cursor: 1, actor: 7, verb: 5, highlight: 13, inventory: 14, sentence: 3, message: 1 };
// color panel: the background of the verb panel, the sentence and the message line of every place
// without panelcolor; unset, a place's panel has its background
export const PANEL_COLOR = 'panel';
export const SPRITE_COLORS = ['sprite1', 'sprite2'];            // $d025 / $d026, shared by the multicolor sprites
export const SPRITE_DEFAULTS = { sprite1: 0, sprite2: 1 };
export const PLACE_ATTRS = ['chapter', 'bgcolor', 'panelcolor', 'border', 'textcolor', 'width', 'walkbox', 'walkarea', 'blockarea', 'behind', 'behindpoly', 'behindpx', 'multicolor', 'ecm', 'charset', 'tiles', 'screen', 'colormap'];
export const PLACE_ATTR_ARITY = { bgcolor: 1, panelcolor: 1, border: 1, textcolor: 1, width: 1, walkbox: 4, multicolor: 2, ecm: 3 };
export const PLACE_COLS = 40;
export const MAX_PLACE_COLS = 120;
export const PLACE_ROWS = 25;          // nerdsuite: a screen is the whole C64 screen, 25 rows
export const FULL_ROWS = 25;          // a fullscreen place covers the sentence line and the panels
export const MAX_FULL_COLS = 120;     // a fullscreen place does not scroll: only a place in the rows of the game is wider
export const SYMBOL_ROWS = 19;        // 'verbs symbol': no verbs in the panel - the places are 2 rows higher
export const PLACE_BUF = 3000;        // the engine's buffer of a place's chars (and of its colors): width x rows
// the rows of a place that is not fullscreen: 17, 21 in a game with the verb coin (advc: gameRows)
export const gameRows = game => (game?.items?.some(x => x.kind === 'verbstyle' && x.value === 'symbol') ? SYMBOL_ROWS : PLACE_ROWS);
export const placeRows = (place, game) => (place?.canvas ? place.canvas.rows : place?.fullscreen ? FULL_ROWS : gameRows(game));
// the widest place of the game: 120 columns, 107 with the verb coin (the buffer holds width x rows)
export const maxPlaceCols = game => Math.min(MAX_PLACE_COLS, Math.floor(PLACE_BUF / gameRows(game)));
// a canvas: a screen of a size of its own (1-255 x 1-255), painted and saved as a file of the screen
// folder - no place of the game, the compiler never sees it (gfxfile.js: canvasesFrom)
export const MAX_CANVAS = 255;
export const FILE_ATTRS = ['charset', 'tiles', 'screen', 'colormap'];
// screens chars | tiles: what the places of a game are made of
export const SCREEN_MODES = ['chars', 'tiles'];
export const tileGame = game => game?.items.some(x => x.kind === 'screens' && x.value === 'tiles') ?? false;

// 'on click' is a pseudo verb: the object acts on a plain click, whatever verb is
// selected - for puzzle screens (keypads, levers, buttons). It never takes a second
// object and has no default handler.
export const CLICK_VERB = 'click';
export const CLICK_VERB_INFO = { name: CLICK_VERB, text: 'Click', prep: null };
export const verbInfo = (verbs, name) =>
  (name === CLICK_VERB ? CLICK_VERB_INFO : verbs.find(v => v.name === name) ?? null);

// --- target platform, media and deployment ------------------------------------------
// Only the C64 is implemented. Another platform adds an entry to PLATFORMS here and in
// advc/adv/parse.go; `media` lists the files it can be built as, `devices` the input devices its
// games can be played with (DEVICES), `deploy` where the editor can send a built game to run it
// (DEPLOY_TARGETS). 'ready' media and targets are the ones the editor can do today.
export const MEDIA = {
  prg:       { label: '§0049',        ext: '.prg', ready: true,  hint: '§0050' },
  d64:       { label: '§0051',           ext: '.d64', ready: true,  hint: '§0052' },
  d71:       { label: '§0053',           ext: '.d71', ready: true,  hint: '§0054' },
  d81:       { label: '§0055',           ext: '.d81', ready: true,  hint: '§0056' },
  crt:       { label: '§0057',           ext: '.crt', ready: true,  hint: '§1118' },
  easyflash: { label: '§0058', ext: '.crt', ready: false, hint: '§0059' },
  kungfu:    { label: 'KungFu Flash',        ext: '.crt', ready: false, hint: '§0060' },
};

// where a built game is sent to run - the settings of a target belong to the editor, not to the
// game (settings.js)
export const DEPLOY_TARGETS = {
  ultimate64: { label: 'Ultimate 64', ready: true, hint: '§1279' },
  vice:       { label: 'VICE', ready: false, hint: '§1280' },
};

export const PLATFORMS = {
  c64: { label: '§1111', media: ['prg', 'd64', 'd71', 'd81', 'crt', 'easyflash', 'kungfu'], defaultMedia: 'prg',
    devices: ['joystick', 'mouse', 'keyboard'], deploy: ['ultimate64', 'vice'] },
};

// input devices the player controls the cursor with
// 'control' names one or more of them. The game reads one device at a time: it starts with the
// first one named, with more than one the player chooses in the F1 menu
export const DEVICES = {
  joystick: { label: 'Joystick', hint: '§0061' },
  mouse:    { label: '§0062', hint: '§0063' },
  keyboard: { label: '§0064', hint: '§0065' },
};
// the words of 'control': the devices, 'both' for joystick and mouse, 'all' for the three
export const CONTROLS = {
  joystick: ['joystick'], mouse: ['mouse'], keyboard: ['keyboard'],
  both: ['joystick', 'mouse'], all: ['joystick', 'mouse', 'keyboard'],
};
export const DEFAULT_CONTROL = 'joystick';
// the devices of a 'control' value ('mouse keyboard') in the order they are named - the first is
// the one the game starts with -, and back: the value as 'control' writes it
export function controlDevices(value) {
  return [...new Set(String(value || DEFAULT_CONTROL).split(' ').flatMap(w => CONTROLS[w] || []))];
}
export function controlValue(devices) {
  const list = [...new Set(devices)].filter(d => DEVICES[d]);
  if (!list.length) return DEFAULT_CONTROL;
  const value = list.join(' ');           // in the order of the list: the first is the one the game starts with
  return value === 'joystick mouse' ? 'both' : value === 'joystick mouse keyboard' ? 'all' : value;
}

// The F1 menu in the game: 'savegames N' save slots (0 = no menu) and its texts, each
// one replaceable with 'menutext KEY "text"'. max: the characters the menu shows.
// The order is the T_* order in engine/constants.s.
export const MAX_SAVES = 20;
// the directory art of a .d64 (dirart): a file name has 16 characters; the 1541 directory holds
// 144 entries, BOOT and the art among them (advc/adv/dirart.go)
export const DIRART_COLS = 16, MAX_DIRART_ROWS = 128;
export const MENU_TEXTS = {
  save:      { text: 'Save',                      label: '§0066',          max: 7 },    // the tabs of the top row: Load, Save, Resume, Restart, Exit
  load:      { text: 'Load',                      label: '§0067',          max: 7 },
  resume:    { text: 'Resume',                    label: '§0068',        max: 7 },
  autosave:  { text: 'Autosave',                  label: '§0456',      max: 12 },
  empty:     { text: 'empty',                     label: '§0069',         max: 15 },
  saved:     { text: 'Game saved.',               label: '§0070',       max: 40 },
  loaded:    { text: 'Game loaded.',              label: '§0071',      max: 40 },
  error:     { text: 'Disk error.',               label: '§0072',         max: 40 },
  overwrite: { text: 'Click again to overwrite.', label: '§0073',        max: 40 },
  wait:      { text: 'One moment...',             label: '§0074', max: 40 },
  insert:    { text: 'Insert disk',               label: '§0075',        max: 38 },   // shown with the disk number
  musicon:   { text: 'Music: on',                 label: '§0076',   max: 15 },
  musicoff:  { text: 'Music: off',                label: '§0077',  max: 15 },
  soundon:   { text: 'Sounds: on',                label: '§0078',  max: 15 },
  soundoff:  { text: 'Sounds: off',               label: '§0079', max: 15 },
  ctrljoy:   { text: 'Input: joystick',           label: '§1091',   max: 15 },
  ctrlmouse: { text: 'Input: mouse',              label: '§1092',      max: 15 },
  ctrlkeys:  { text: 'Input: keyboard',           label: '§1093',   max: 15 },
  exit:      { text: 'Exit',                      label: '§1680',   max: 7 },
  exitask:   { text: 'Click again to exit.',      label: '§1681',   max: 40 },
  restart:   { text: 'Restart',                   label: '§1682',   max: 7 },
  restartask: { text: 'Click again to restart.',  label: '§1683',   max: 40 },
  talkon:    { text: 'Talk: on',                  label: '§1708',          max: 15 },   // the talk sounds of the actors (talksound)
  talkoff:   { text: 'Talk: off',                 label: '§1709',          max: 15 },
};

// Chapters group the places that share a file on disk: 'chapter NAME "title" [disk N]' at the
// top level, 'chapter NAME' in a place (the places inside it inherit it). On disk the code of a
// chapter is a file of its own, on disk N. Limits as in advc.
export const MAX_CHAPTERS = 50, MAX_DISKS = 9, CHAPTER_TITLE = 40;

// The cursor sprite points with one pixel, its hot spot: what the sprite draws around
// it is what the hit test picks. Without a declared 'hotspot' it is the middle of the
// drawn pixels, which is the center of a crosshair.
// the size of a sprite of the machine of the project (video.js sprite, set by c64.js): the C64's 24 x 21 in
// blocks of 64 bytes (3 a row and a pad byte), a player of the Atari 8 x 16 in 16 bytes (one a row)
export let SPRITE_COLS = 24, SPRITE_ROWS = 21, SPRITE_BLOCK = 64;
export function setSpriteGeometry({ cols = 24, rows = 21, block = 64 } = {}) {
  SPRITE_COLS = cols; SPRITE_ROWS = rows; SPRITE_BLOCK = block;
}
export const spriteRowBytes = () => SPRITE_COLS >> 3;
// multicolor art has 12 double wide pixels; the hot spot still counts hires pixels
export function cursorHotspot(lines = [], multicolor = false) {
  const w = spriteWidth(multicolor), k = multicolor ? 2 : 1;
  const art = lines.slice(0, SPRITE_ROWS).map(l => l.slice(0, w));
  const on = (l, x) => l[x] && l[x] !== '.' && l[x] !== ' ';
  const cols = art.flatMap(l => [...Array(w).keys()].filter(x => on(l, x)));
  const rows = [...art.keys()].filter(y => [...Array(w).keys()].some(x => on(art[y], x)));
  if (!cols.length || !rows.length) return [0, 0];
  return [Math.floor((Math.min(...cols) * k + Math.max(...cols) * k + k - 1) / 2),
          Math.floor((Math.min(...rows) + Math.max(...rows)) / 2)];
}

// Sprite pixels are the multicolor bit pairs: 0 clear, 1 shared color 1 ('1', $d025),
// 2 the sprite color ('X'), 3 shared color 2 ('2', $d026). Hires pixels are 0 or 2.
export const MC_PIXELS = { '.': 0, ' ': 0, 1: 1, X: 2, x: 2, 2: 3 };
export const spriteWidth = multicolor => (multicolor ? SPRITE_COLS / 2 : SPRITE_COLS);

export function decodeSprite(lines = [], multicolor = false, sw = 1, sh = 1) {
  const w = spriteWidth(multicolor) * sw;
  return Array.from({ length: SPRITE_ROWS * sh }, (_, y) => {
    const l = (lines[y] ?? '').padEnd(w, '.');
    return Array.from({ length: w }, (_, x) => (multicolor ? (MC_PIXELS[l[x]] ?? 0) : (l[x] === '.' || l[x] === ' ' ? 0 : 2)));
  });
}

export const encodeSprite = (grid, multicolor) =>
  grid.map(row => row.map(v => (multicolor ? '.1X2'[v] : v ? 'X' : '.')).join(''));

// hires <-> multicolor like the VIC's multicolor bit: the sprite's bits stay and are read the other
// way. A multicolor pixel is the two hires pixels of its bits - 11 two set pixels, 10 set and clear,
// 01 clear and set, 00 two clear ones; a set hires pixel is the sprite color (value 2, multicolor 10)
export const convertSprite = (grid, toMulticolor) => (toMulticolor
  ? grid.map(row => Array.from({ length: row.length / 2 }, (_, x) => (row[2 * x] ? 2 : 0) | (row[2 * x + 1] ? 1 : 0)))
  : grid.map(row => row.flatMap(v => [v & 2 ? 2 : 0, v & 1 ? 2 : 0])));

// the compiler's built-in sprites
// the built-in cursors of 'cursor NAME' (as defaultSprites and cursorHotspots in compile.go):
// their art and the pixel that points (null: the middle of the art)
export const CURSORS = {
  cross: { hotspot: null, lines: [
    '...........X............', '...........X............', '...........X............', '...........X............',
    '........................', '....XXXX.......XXXX.....', '........................', '...........X............',
    '...........X............', '...........X............', '...........X............',
  ] },
  arrow: { hotspot: [0, 0], lines: [
    'X...........', 'XX..........', 'XXX.........', 'XXXX........', 'XXXXX.......', 'XXXXXX......', 'XXXXXXX.....',
    'XXXXXXXX....', 'XXXXX.......', 'XX.XX.......', 'X...XX......', '....XX......', '.....XX.....',
  ] },
  hand: { hotspot: [5, 0], lines: [
    '.....XX.........', '....X..X........', '....X..X........', '....X..X........', '....X..XXX......',
    '....X..X..XXX...', '.XX.X..X..X..XX.', 'X..XX..........X', 'X...X..........X', '.X.............X',
    '..X............X', '...X..........X.', '....X.........X.', '.....XXXXXXXXX..',
  ] },
};
// the built-in cursor the game picked ('cursor NAME' - symbols().cursorstyle)
export const builtinCursor = S => CURSORS[S?.cursorstyle] ?? CURSORS.cross;
// symbol mode ('verbs symbol', advc/adv/verbcoin.go): the verbs of the cursor icons, in the order
// a right click turns through them after the pointer; the pointer walks, so the game has walk too
export const SYMBOL_VERBS = ['look', 'hand', 'talk'];
// the verbs a handler or a default can be for: in symbol mode ('verbs symbol') walk and the three of
// the icons - the other verbs of the script have no icon, the player cannot pick them -, in text mode
// the verbs of the panel. Each as the script declares it ({name, text, prep}), one it lacks by its name
export function actionVerbs(S) {
  const verbs = S?.verbs ?? [];
  if (S?.verbstyle !== 'symbol') return verbs;
  // symbol mode: walk and the three of the icons, then the extra verbs the hand stands for over an
  // object with a hand rule ('hand push if ...', advc/adv/verbcoin.go)
  return [...['walk', ...SYMBOL_VERBS].map(name => verbs.find(v => v.name === name) ?? { name, text: name }),
    ...verbs.filter(v => !['walk', ...SYMBOL_VERBS].includes(v.name))];
}

export const DEFAULT_SPRITES = {
  cursor: CURSORS.cross.lines,
  stand: [
    '..........XXXX..........', '.........XXXXXX.........', '.........XX.X.X.........', '.........XXXXXX.........',
    '..........XXXX..........', '...........XX...........', '.........XXXXXX.........', '........XXXXXXXX........',
    '.......XX.XXXX.XX.......', '.......XX.XXXX.XX.......', '.......XX.XXXX.XX.......', '.........XXXXXX.........',
    '.........XXXXXX.........', '.........XX..XX.........', '.........XX..XX.........', '.........XX..XX.........',
    '.........XX..XX.........', '.........XX..XX.........', '.........XX..XX.........', '........XXX..XXX........',
    '........................',
  ],
  walk: [
    '..........XXXX..........', '.........XXXXXX.........', '.........XX.X.X.........', '.........XXXXXX.........',
    '..........XXXX..........', '...........XX...........', '.........XXXXXX.........', '........XXXXXXXX........',
    '.......XX.XXXX.XX.......', '......XX..XXXX..XX......', '......X...XXXX...X......', '.........XXXXXX.........',
    '.........XXXXXX.........', '........XX....XX........', '........XX....XX........', '.......XX......XX.......',
    '.......XX......XX.......', '......XX........XX......', '......XX........XX......', '.....XXX........XXX.....',
    '........................',
  ],
};

// --- animations -------------------------------------------------------------------------
// A costume has named frames, layers (each a sprite of its own, engine/layers.s) and animations. Places animate chars
// ('charanim') and patches ('patchanim'). Limits as in advc/adv/compile.go.
export const DEFAULT_ANIM_SPEED = 8;          // frames per step when there is no 'speed'
// 'idle N': an actor that stood still for N seconds plays its costume's animation 'idle'
// (0: never); without the line DEFAULT_IDLE seconds. Up to MAX_IDLE (the engine counts in
// steps of 16 frames, 255 at most)
export const DEFAULT_IDLE = 10, MAX_IDLE = 80;
export const MAX_BLOCKS = 254, MAX_ANIM_FRAMES = 32, MAX_CHARANIMS = 8, MAX_PATCHANIMS = 32;
// the behind areas of a place (maxBehind in compile.go): its rectangles and the strips of its
// polygons, a strip for every run of columns of the same height (behindStrips in advgen.js)
export const MAX_BEHIND = 16;

// the art of a costume frame by name, null when the costume has no such frame
export const costumeFrame = (c, name) => c?.frames.find(f => f.name === name)?.lines ?? null;

// the frame an actor shows while standing: the one marked 'default', else the frame 'stand'
// (null when a costume has neither). The default costume (null) has 'stand'.
export function defaultFrame(c) {
  if (!c) return 'stand';
  return c.frames.find(f => f.default)?.name ?? (c.frames.some(f => f.name === 'stand') ? 'stand' : null);
}

// the animations a costume plays: its own, plus 'stand' and 'walk' when it lacks them
// (implicit). The default costume (null) has only those two.
export function costumeAnims(c) {
  const anims = [...(c?.anims ?? [])];
  const names = new Set(anims.map(a => a.name));
  const hasWalk = !c || c.frames.some(f => f.name === 'walk');
  const standing = defaultFrame(c) ?? c.frames[0]?.name ?? 'stand';   // without a default frame: the first one
  if (!names.has('walk')) anims.unshift({ name: 'walk', frames: hasWalk ? [standing, 'walk'] : [standing], speed: null, implicit: true });
  if (!names.has('stand')) anims.unshift({ name: 'stand', frames: [standing], speed: null, implicit: true });
  return anims;
}

// the directions an actor faces. 'walk_front' is the walk animation facing front; an
// animation without a suffix is drawn facing right and mirrored facing left.
export const DIRECTIONS = ['right', 'left', 'front', 'back'];
// the seconds costume c stands before its animation 'idle' starts, 0 when it has none
export function idleSeconds(c) {
  if (!c?.anims.some(a => animView(a.name).base === 'idle')) return 0;
  return c.idle != null && /^\d+$/.test(String(c.idle)) ? Number(c.idle) : DEFAULT_IDLE;
}
// the frames an actor wearing c stands before 'idle' plays, 0: never (the engine counts steps
// of 16 frames, 50 a second: idleSteps in compile.go)
export function idleFrames(c) {
  const secs = idleSeconds(c);
  return secs ? 16 * Math.min(255, Math.max(1, Math.floor((secs * 50 + 8) / 16))) : 0;
}
export function animView(name) {
  const m = /^(.+)_(right|left|front|back)$/.exec(name);
  return m ? { base: m[1], view: m[2] } : { base: name, view: null };
}

// the orders 'play' gives the frames of an animation (forward without the line)
export const ANIM_PLAYS = ['forward', 'backward', 'pingpong'];
// 'vary N': a step of the animation shows its speed +- up to N frames at random (bits 4-7 of its view)
export const MAX_VARY = 15;
// the frames animation a shows in turn: 'play backward' from the last one, 'pingpong' there and
// back without showing the ends twice (a b c: a b c b, then a again) - AnimSequence in parse.go
export function animSequence(a) {
  const f = a?.frames ?? [];
  if (a?.play === 'backward') return [...f].reverse();
  if (a?.play === 'pingpong') return [...f, ...f.slice(1, -1).reverse()];
  return f;
}

// the animation a 'mirror' animation plays mirrored: walk_left -> walk_right, walk_right ->
// walk_left; null for a name without one of these suffixes (MirrorPartner in parse.go)
export function mirrorPartner(name) {
  const m = /^(.+)_(left|right)$/.exec(name ?? '');
  return m ? `${m[1]}_${m[2] === 'left' ? 'right' : 'left'}` : null;
}

// the animation whose frames and speed a plays, and whether mirrored: a 'mirror' animation
// plays its partner's (anim: null when the costume has none)
export function animPlays(c, a) {
  if (!a?.mirror) return { anim: a, mirror: false };
  const name = mirrorPartner(a.name);
  return { anim: (c?.anims ?? []).find(x => x.name === name && !x.mirror) ?? null, mirror: true };
}

// what costume c shows of animation base facing dir: its animation for that direction (a
// 'mirror' one: its partner mirrored), else the animation itself (mirrored facing left); null
// when it has neither
export function viewAnim(c, base, dir) {
  const anims = costumeAnims(c);
  const own = anims.find(a => a.name === `${base}_${dir}`);
  if (own) {
    const p = animPlays(c, own);
    if (p.anim) return p;
  }
  const any = anims.find(a => a.name === base);
  return any ? { anim: any, mirror: dir === 'left' } : null;
}

// a costume's size in sprites [W, H] ('size W H'); its frames are 24 W x 21 H pixels.
// The default costume (null) is one sprite.
export const MAX_ACTOR_SPRITES = 7;
export const MAX_LAYERS = 6;          // layers of a costume: the bits of a frame's layer byte (engine/layers.s)
// a costume layer's mode: its own, else the costume's
export const layerMulticolor = (c, l) => (l.multicolor != null ? !!l.multicolor : !!c?.multicolor);

// the most layers a frame of the costume has: each is a sprite group of its own
export const mostLayers = c => Math.max(0, ...(c?.frames ?? []).map(f => c.layers.filter(l => l.frames.some(x => x.name === f.name)).length));

export function costumeSize(c) {
  const n = v => (/^\d+$/.test(String(v ?? '')) ? Math.max(1, Number(v)) : 1);
  return c?.size ? [n(c.size[0]), n(c.size[1])] : [1, 1];
}

// the sprite blocks (64 bytes) costume c takes from block start on, as sprites() in compile.go
// lays them out: the engine shows a frame at b, b + 2, ... and facing left at b + 1, b + 3, ...
// A frame of an animation for all directions fills both lanes; one only shown in one facing (an
// animation for a direction, or a 'mirror' one) shares them with another; a frame of one sprite
// shown in one facing takes a single block. With sprite colors that differ left and right a
// frame as drawn needs an even lane, mirrored an odd one. Frames no animation shows take none.
export function costumeBlocks(c, start = 0) {
  if (!c) return 4;                                     // the default costume: stand and walk, both facings
  const [w, h] = costumeSize(c);
  const color = i => (i < (c.colors?.length ?? 0) ? String(c.colors[i]) : null);
  let symmetric = true;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (color(j * w + i) !== color(j * w + w - 1 - i)) symmetric = false;
  const parity = w * h > 1 && !symmetric;
  const both = new Set(), one = new Map();
  for (const a of costumeAnims(c)) {
    const { anim, mirror } = animPlays(c, a);
    for (const f of anim?.frames ?? []) {
      if (!animView(a.name).view) both.add(f);
      else {
        if (!one.has(f)) one.set(f, [false, false]);
        one.get(f)[mirror ? 1 : 0] = true;
      }
    }
  }
  const blocks = [];                                    // true: used, false: a gap
  const grow = (n, even) => {
    if (even && (start + blocks.length) % 2) blocks.push(false);
    const at = blocks.length;
    for (let i = 0; i < n; i++) blocks.push(false);
    return at;
  };
  const open = [];
  for (const f of c.frames) {
    if (!both.has(f.name) && !one.has(f.name)) continue;
    const r = w * h * (1 + c.layers.filter(l => l.frames.some(x => x.name === f.name)).length);
    if (both.has(f.name)) {
      const at = grow(2 * r, parity);
      for (let j = 0; j < 2 * r; j++) blocks[at + j] = true;
      continue;
    }
    one.get(f.name).forEach((want, m) => {
      if (!want) return;
      let at = -1, step = 2;
      if (r === 1 && !parity) { at = grow(1, false); step = 1; }
      else {
        const i = open.findIndex(s => s.r === r && (!parity || s.free === m));
        if (i >= 0) { at = open[i].at + open[i].free; open.splice(i, 1); }
        else {
          const lane = parity ? m : 0, s = grow(2 * r, parity);
          open.push({ at: s, r, free: 1 - lane });
          at = s + lane;
        }
      }
      for (let j = 0; j < r; j++) blocks[at + step * j] = true;
    });
  }
  while (blocks.length && !blocks.at(-1)) blocks.pop();
  return blocks.length;
}

// the animation names an actor can play with 'animate ACTOR NAME'
export function actorAnims(S, actor) {
  const name = actor.attrs.find(x => x.key === 'costume')?.values[0];
  const anims = costumeAnims(name && name !== 'default' ? S.costumes.find(c => c.name === name) ?? null : null);
  return [...new Set(anims.map(a => animView(a.name).base))];
}

export const DEFAULT_PLATFORM = 'c64';
export const platformMedia = p => PLATFORMS[p]?.media ?? [];
export const platformDeploy = p => PLATFORMS[p]?.deploy ?? [];
export const platformDevices = p => PLATFORMS[p]?.devices ?? [];
export const defaultMedia = p => PLATFORMS[p]?.defaultMedia ?? 'prg';

// statement schema: field name + type. Types drive the inspector and the validator.
export const OPS = {
  // say with a secret: 'secret' names it and 'text' is null
  say:      { label: '§0080',          icon: 'chat',            group: 'Dialog',   fields: [['actor', 'actor?'], ['secret', 'secret?'], ['text', 'string']] },
  choose:   { label: '§0081', icon: 'forum',          group: 'Dialog',   fields: [] },
  clearmsg: { label: '§0082', icon: 'speaker_notes_off', group: 'Dialog', fields: [] },
  walk:     { label: '§0083', icon: 'directions_walk', group: 'Actor',    fields: [['x', 'x'], ['y', 'num']] },
  walkto:   { label: '§0084', icon: 'directions_walk', group: 'Actor',   fields: [['obj', 'object']] },
  // goto PLACE (X, Y) puts the actor there; goto PLACE, x and y empty, shows the place without actors
  goto:     { label: '§0085',   icon: 'meeting_room',    group: 'Actor',    fields: [['place', 'place'], ['x', 'x'], ['y', 'num']] },
  back:     { label: '§0087', icon: 'undo', group: '§0086',   fields: [] },
  print:    { label: '§0088',   icon: 'text_fields',     group: '§0086',   fields: [['col', 'num'], ['row', 'num'], ['text', 'string'], ['color', 'color?']] },
  // 'var' is a variable (a number) or a secret (its text)
  printvar: { label: '§0089', icon: 'pin',             group: '§0086',   fields: [['col', 'num'], ['row', 'num'], ['var', 'var'], ['digits', 'num?'], ['color', 'color?']] },
  entryadd: { label: '§0090', icon: 'dialpad',      group: '§0086',   fields: [['ch', 'string']] },
  entryclear: { label: '§0091', icon: 'backspace', group: '§0086',  fields: [] },
  entryshow: { label: '§0092', icon: 'password',   group: '§0086',   fields: [['col', 'num'], ['row', 'num'], ['width', 'num?'], ['color', 'color?']] },
  setpos:   { label: '§0093', icon: 'my_location',     group: 'Actor',    fields: [['x', 'x'], ['y', 'num']] },
  face:     { label: '§0094',         icon: 'swap_horiz',      group: 'Actor',    fields: [['dir', DIRECTIONS]] },
  actor:    { label: '§0095', icon: 'visibility',     group: 'Actor',    fields: [['mode', ['on', 'off']]] },
  pickup:   { label: 'Pick up',      icon: 'backpack',        group: '§0096',  fields: [['obj', 'object']] },
  drop:     { label: '§0097',         icon: 'delete_sweep',    group: '§0096',  fields: [['obj', 'object']] },
  place:    { label: '§0098', icon: 'place_item',     group: '§0096',  fields: [['obj', 'object'], ['place', 'place']] },
  draw:     { label: '§0099',   icon: 'brush',           group: '§0096',  fields: [['patch', 'patch']] },
  if:       { label: '§0100',    icon: 'call_split',      group: '§0101',    fields: [] },
  while:    { label: '§0102',        icon: 'repeat',          group: '§0101',    fields: [['cond', 'expr']] },
  // cutscene [FRAMES] [skip] { }: no cursor and no panels, ends after FRAMES, RUN/STOP skips it
  cutscene: { label: '§1159',     icon: 'movie',           group: '§0101',    fields: [['frames', 'num?'], ['skip', ['skip', 'no skip']]] },
  assign:   { label: '§0103',    icon: 'edit_note',       group: '§0101',    fields: [['target', 'target'], ['aop', ['=', '+=', '-=']], ['expr', 'expr']] },
  call:     { label: '§0104',     icon: 'subdirectory_arrow_right', group: '§0101', fields: [['sub', 'sub']] },
  // run SUB: the sub runs in a background thread next to everything else; stop SUB ends it
  run:      { label: '§0773', icon: 'rocket_launch', group: '§0101', fields: [['sub', 'sub']] },
  stopsub:  { label: '§0774', icon: 'stop_circle', group: '§0101', fields: [['sub', 'sub']] },
  wait:     { label: '§0105',  icon: 'hourglass_empty', group: '§0101',    fields: [['n', 'num']] },
  return:   { label: '§0106',       icon: 'keyboard_return', group: '§0101',    fields: [] },
  stop:     { label: '§0107', icon: 'block',           group: '§0101',    fields: [] },
  // end NAME: the game is over, its epilog NAME follows (advc/adv/endgame.go)
  end:      { label: '§1564', icon: 'flag',            group: '§0101',    fields: [['epilog', 'epilog']] },
  autosave: { label: 'Autosave',     icon: 'save',            group: '§0101',    fields: [] },
  give:     { label: '§0108', icon: 'redeem',         group: '§0096',  fields: [['obj', 'object'], ['actor', 'actor']] },
  walkactor:   { label: '§0109', icon: 'directions_walk', group: '§1256', fields: [['actor', 'actor'], ['x', 'x'], ['y', 'num']] },
  walkactorto: { label: '§0110', icon: 'directions_walk', group: '§1256', fields: [['actor', 'actor'], ['obj', 'object']] },
  put:      { label: '§0111', icon: 'person_pin_circle', group: '§1256', fields: [['actor', 'actor'], ['place', 'place'], ['x', 'x'], ['y', 'num']] },
  select:   { label: '§0112', icon: 'switch_account', group: '§1256', fields: [['actor', 'actor']] },
  // follow ACTOR LEADER | follow ACTOR off: it walks after the leader (engine/follow.s)
  follow:   { label: '§1587', icon: 'group',          group: '§1256', fields: [['actor', 'actor'], ['leader', 'leader']] },
  faceactor: { label: '§0113', icon: 'swap_horiz',      group: '§1256',   fields: [['actor', 'actor'], ['dir', DIRECTIONS]] },
  show:     { label: '§0114',   icon: 'visibility',      group: '§1256',   fields: [['actor', 'actor']] },
  hide:     { label: '§0115',   icon: 'visibility_off',  group: '§1256',   fields: [['actor', 'actor']] },
  animate:  { label: '§0116',      icon: 'animation',       group: '§1256',   fields: [['target', 'animtarget'], ['anim', 'anim?'], ['mode', ['loop', 'once', 'off']]] },
  // music NAME | music off: the music changes; sound NAME: a sound over the music (the songs of the Sound view)
  music:    { label: '§0117',   icon: 'music_note',      group: 'Sound',    fields: [['song', 'music']] },
  sound:    { label: '§0118',   icon: 'volume_up',       group: 'Sound',    fields: [['song', 'sound']] },
};

export const SIMPLE_KW = ['say', 'walk', 'goto', 'wait', 'draw', 'pickup', 'drop', 'place', 'setpos',
  'face', 'actor', 'call', 'stop', 'return', 'clearmsg', 'put', 'select', 'give', 'show', 'hide', 'choose',
  'back', 'print', 'entry', 'autosave', 'animate', 'music', 'sound', 'run', 'end', 'follow'];
export const ACTOR_ATTRS = ['in', 'at', 'costume', 'color', 'talkcolor', 'talksound', 'face', 'state', 'playable', 'strength'];
// every screen is a place and places nest; 'place', 'map' and 'closeup' are places with a screen
export const PLACE_KEYWORDS = ['place'];

// every word the language itself uses, for the code areas: what is not one of these and not a
// number or a text is a name of the game (codearea.js, highlight)
export const KEYWORDS = new Set([...SIMPLE_KW, ...PLACE_KEYWORDS,
  'on', 'enter', 'exit', 'sub', 'object', 'actor', 'location', 'default', 'start',
  'if', 'else', 'while', 'cutscene', 'option', 'skip',
  'and', 'or', 'not', 'has', 'strength', 'random', 'shl', 'shr', 'xor', 'mod', 'loaded', 'true', 'false',
  'at', 'to', 'in', 'with', 'every', 'width', 'color', 'digits', 'once', 'auto', 'off', 'size',
  'needs', 'layer', 'pickable', 'walkto', 'state', 'playable', 'inventory', 'nowhere', 'player', 'entry',
  'name', 'title', 'when', 'unless', 'dirart', 'verbs', 'layers', 'screen', 'var', 'patch', 'patchanim', 'frames', 'speed', 'data', 'colors', 'gfx', 'import',
  'verb', 'secret', 'costume', 'sprite', 'frame', 'anim', 'charanim', 'char', 'text', 'hotspot', 'chapter', 'pre', 'post',
  'charset', 'tiles', 'screens', 'steps', 'global', 'prolog', 'epilog', 'outro', 'author', 'year', 'writer', 'scroller', 'picture', 'rows', 'music', 'typesound', 'fadeout']);

// what 'screen { ... }' of a place holds: the picture, and what is drawn and walked on (the other
// members of a place are its logic)
export const SCREEN_KEYS = new Set(['width', 'bgcolor', 'panelcolor', 'border', 'textcolor', 'charset', 'tiles', 'multicolor', 'ecm',
  'walkbox', 'walkarea', 'blockarea', 'behind', 'behindpoly', 'behindpx', 'screen', 'colormap']);
export const isScreenMember = m => m.kind === 'background' || m.kind === 'charanim' ||
  (m.kind === 'attr' && SCREEN_KEYS.has(m.key));
// secret NAME = "text": stored encrypted by the compiler, for the editor a named text
export const SECRET_TEXT = 40, ENTRY_CODE = 8;


// --- expressions ---------------------------------------------------------------------

// what the travel of an exit says while its rule does not hold (actions.js: a travel made in the editor)
export const LOCKED_TEXT = "You can't go there yet.";

// the tokens of an expression: strings, numbers, names and operators
const EXPR_TOKEN = /("(?:[^"\\\n]|\\.)*")|(\$[0-9a-fA-F]+|%[01]+|\d+)|([A-Za-z_][A-Za-z0-9_]*)|(==|!=|<=|>=|\S)/g;
const exprTokens = text => [...String(text ?? '').matchAll(EXPR_TOKEN)]
  .map(m => ({ kind: m[1] ? 'str' : m[2] ? 'num' : m[3] ? 'ident' : 'op', raw: m[0] }));

// the names an expression reads (not the fields after a dot)
export function exprNames(text) {
  const toks = exprTokens(text);
  return toks.filter((t, k) => t.kind === 'ident' && toks[k - 1]?.raw !== '.').map(t => t.raw);
}

// the names the code entry is compared with: entry == NAME, entry != NAME (not the strings)
export function entryNames(text) {
  const toks = exprTokens(text);
  return toks.flatMap((t, k) => (t.kind === 'ident' && t.raw === 'entry' && toks[k - 1]?.raw !== '.' &&
    ['==', '!='].includes(toks[k + 1]?.raw) && toks[k + 2] && toks[k + 2].kind !== 'str' ? [toks[k + 2].raw] : []));
}


// --- traversal -----------------------------------------------------------------------

export function walkBody(body, fn, parent = null) {
  if (!body) return;
  for (const s of body.stmts) {
    fn(s, parent);
    if (s.op === 'if') {
      s.branches.forEach(b => walkBody(b.body, fn, s));
      walkBody(s.else, fn, s);
    } else if (s.op === 'while' || s.op === 'cutscene') {
      walkBody(s.body, fn, s);
    } else if (s.op === 'choose') {
      s.options.forEach(o => walkBody(o.body, fn, s));
    }
  }
}

export function bodiesOf(node) {
  if (!node) return [];
  if (node.kind === 'stmt') {
    if (node.op === 'if') return [...node.branches.map(b => b.body), ...(node.else ? [node.else] : [])];
    if (node.op === 'while' || node.op === 'cutscene') return [node.body];
    if (node.op === 'choose') return node.options.map(o => o.body);
    return [];
  }
  return node.body ? [node.body] : [];
}

// every node with an id, depth first, with its parent node
export function walk(game, fn) {
  const visitBody = (body, parent) => {
    if (!body) return;
    for (const s of body.stmts) {
      fn(s, parent);
      bodiesOf(s).forEach(b => visitBody(b, s));
    }
  };
  const visit = (n, parent) => {
    fn(n, parent);
    if (n.kind === 'place') (n.members || []).forEach(m => visit(m, n));
    if (n.kind === 'object' || n.kind === 'actor') (n.handlers || []).forEach(h => visit(h, n));
    if (n.body) visitBody(n.body, n);
  };
  game.items.forEach(n => visit(n, game));
}

// placeAround(node): the innermost place a node is written in (a variable, a statement, an object ...),
// null at the top level; placeAround(place) is the place around that place
export function placesAround(game) {
  const parent = new Map();
  walk(game, (n, p) => parent.set(n, p));
  return n => {
    for (let p = parent.get(n); p; p = parent.get(p)) if (p.kind === 'place') return p;
    return null;
  };
}

export function findById(game, id) {
  let found = null, parent = null;
  walk(game, (n, p) => { if (!found && n.id === id) { found = n; parent = p; } });
  return found ? { node: found, parent } : null;
}

// objects, places, ... by name
export function symbols(game) {
  const s = { places: [], objects: [], actors: [], costumes: [], verbs: [], vars: [], consts: [], secrets: [], subs: [], patches: [], patchanims: [], chapters: [], songs: [],
              defaults: [], sprites: [], colors: [], start: null, charset: 'lower', textfont: null, allPlaces: [],
              platform: DEFAULT_PLATFORM, media: null, control: DEFAULT_CONTROL, mousespeed: null, cursorflash: false, cursorstill: false, cursoranim: 3, cursorstyle: 'cross', verbstyle: 'text', messagerows: null, savegames: null, autosave: false, menutexts: [], steps: null, screens: 'chars',
              prolog: null, epilogs: [], outro: null, gametitle: null, author: null, year: null, dirart: null };
  const visit = items => items.forEach(it => {
    switch (it.kind) {
      case 'place':
        // places: all of them; places: the ones with a screen (the engine's places)
        s.allPlaces.push(it);
        if (hasScreen(it)) s.places.push(it);
        visit(it.members.filter(m => ['place', 'object', 'actor', 'patch', 'sub', 'patchanim', 'var', 'song'].includes(m.kind)));
        break;
      case 'patchanim': s.patchanims.push(it); break;
      case 'object': s.objects.push(it); break;
      case 'actor': s.actors.push(it); break;
      case 'costume': s.costumes.push(it); break;
      case 'verb': s.verbs.push(it); break;
      case 'var': s.vars.push(it); break;
      case 'song': s.songs.push(it); break;
      case 'steps': s.steps = it; break;
      case 'const': s.consts.push(it); break;
      case 'secret': s.secrets.push(it); break;
      case 'sub': s.subs.push(it); break;
      case 'patch': s.patches.push(it); break;
      case 'default': s.defaults.push(it); break;
      case 'sprite': s.sprites.push(it); break;
      case 'color': s.colors.push(it); break;
      case 'start': s.start = it; break;
      case 'charset': s.charset = it.value; break;
      case 'textfont': s.textfont = it.str != null ? { file: it.str } : { rom: it.value }; break;
      case 'screens': s.screens = it.value; break;
      case 'platform': s.platform = it.value; break;
      case 'media': s.media = it.values; break;
      case 'control': s.control = it.value; break;
      case 'mousespeed': s.mousespeed = it.value; break;
      case 'cursorflash': s.cursorflash = true; break;
      case 'cursorstill': s.cursorstill = true; break;
      case 'cursoranim': s.cursoranim = it.value; break;
      case 'cursorstyle': s.cursorstyle = it.value; break;
      case 'verbstyle': s.verbstyle = it.value; break;
      case 'gametitle': s.gametitle = it.str; break;
      case 'author': s.author = it.str; break;
      case 'dirart': s.dirart = it.str; break;
      case 'year': s.year = it.value; break;
      case 'messagerows': s.messagerows = it.value; break;
      case 'intro': s.intro = it; break;
      case 'prolog': s.prolog = it; break;
      case 'outro': s.outro = it; break;
      case 'epilog': s.epilogs.push(it); break;
      case 'savegames': s.savegames = it.value; s.autosave = !!it.autosave; break;
      case 'menutext': s.menutexts.push(it); break;
      case 'chapter':
        s.chapters.push(it);
        visit((it.members || []).filter(m => m.kind === 'var' || m.kind === 'sub'));    // (its default handlers are its own)
        break;
    }
  });
  visit(game.items);
  s.media = s.media ?? [defaultMedia(s.platform)];   // the media to build, declared or not
  // the places shown without actors: entered with 'goto PLACE' without a position (a map, a device
  // seen up close) - nobody is drawn there, a click does not walk. Marked on the place as _noActors
  s.noActors = new Set();
  walk(game, n => { if (n.kind === 'stmt' && n.op === 'goto' && !hasPos(n)) s.noActors.add(n.place); });
  for (const p of s.allPlaces) {
    if (s.noActors.has(p.name)) p._noActors = true;
    else delete p._noActors;
  }
  return s;
}

// a goto with a position: the actor is put there. Without one (goto PLACE) the place is shown without actors
export const hasPos = s => s.x != null && s.x !== '';

// a 'place' without background or screen file only groups its children;
// the older 'map' and 'closeup' always had a screen
export function hasScreen(place) {
  return place.keyword !== 'place' || place.members.some(m => m.kind === 'background' || (m.kind === 'attr' && m.key === 'screen'));
}

// the chapter of every place: Map place -> { name, place }, where place is the one that names
// it - the place itself or the nearest enclosing place with a 'chapter' attribute (an inner
// place naming another chapter does not change it). A chapter is the file group of a disk build
export function chapterMap(game) {
  const map = new Map();
  const visit = (items, outer) => items.forEach(it => {
    if (it.kind !== 'place') return;
    const own = it.members.find(m => m.kind === 'attr' && m.key === 'chapter')?.values[0];
    const c = outer ?? (own ? { name: own, place: it } : null);
    if (c) map.set(it, c);
    visit(it.members, c);
  });
  visit(game.items, null);
  return map;
}

// the chapter name of a place, null when it is in none
export const placeChapter = (game, place) => chapterMap(game).get(place)?.name ?? null;

// place an object is declared in (or null for top level objects)
export function objectHome(game, obj) {
  const find = items => {
    for (const it of items) {
      if (it.kind !== 'place') continue;
      if (it.members.includes(obj)) return it;
      const r = find(it.members);
      if (r) return r;
    }
    return null;
  };
  return find(game.items);
}

// the 'in' attribute or the declaring place
export function objectStartPlace(game, obj) {
  const inAttr = obj.attrs.find(a => a.key === 'in');
  if (inAttr) return inAttr.values[0];
  return objectHome(game, obj)?.name ?? 'nowhere';
}

export function getAttr(node, key) {
  if (node.kind === 'object') return node.attrs.find(a => a.key === key)?.values ?? null;
  const m = node.members.find(x => x.kind === 'attr' && x.key === key);
  return m ? (m.str ?? m.values) : null;
}

// the screens of a nerdsuite project: its canvases - every screen is a file of its own (gfxfile.js),
// nerdsuite has no places
export const screensOf = game => game?.canvases ?? [];
