// adv.js - parser, model and serializer for the adventure script language (.adv)
//
// The model mirrors advc/adv/parse.go but keeps everything needed to write the
// file back: declaration order, comments, blank lines and the original source text
// of every node. Nodes that were not edited are written back verbatim, so a
// load/save cycle does not reformat the file.

export class AdvError extends Error {
  constructor(msg, line) {
    super(line ? `line ${line}: ${msg}` : msg);
    this.line = line;
    this.plain = msg;
  }
}

// --- tokenizer ---------------------------------------------------------------------

const TOKEN_RE = /([ \t\r]+)|(\n)|(\/\/[^\n]*)|("""[\s\S]*?""")|("(?:[^"\\\n]|\\.)*")|(\$[0-9a-fA-F]+|%[01]+|\d+)|([A-Za-z_][A-Za-z0-9_]*)|(==|!=|<=|>=|\+=|-=|[{}()\[\].,;<>=+\-|])/y;
const KINDS = [null, 'ws', 'nl', 'comment', 'tstr', 'str', 'num', 'ident', 'op'];

// scan: every token of the source, whitespace, newlines and comments included, each with its
// offsets - what the highlighter needs. Unlike tokenize it never throws: a character the language
// does not know is one token of kind 'bad', so a half typed string highlights instead of dying
// bracketLists: the text of a script with its lists in brackets - frames A, B (of an anim, a
// patchanim, a charanim), layer(s) A, B, strength A, B and needs A as frames [A, B] ... - the only form
// the language takes since project format 3 (migrate.js). Lists in brackets already, strength(...) in a
// condition, strings and comments stay; so do the older one line forms that list frames without
// commas (patchanim NAME frames A B speed N) - the parser refuses them
const LIST_WORDS = new Set(['frames', 'layer', 'layers', 'strength', 'needs']);
const lineHas = (toks, k, text) => { for (; toks[k] && toks[k].kind !== 'nl'; k++) if (toks[k].text === text) return true; return false; };
export function bracketLists(src) {
  const toks = scan(src).filter(t => t.kind !== 'ws' && t.kind !== 'comment');
  const edits = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind !== 'ident' || !LIST_WORDS.has(t.text) || toks[i - 1]?.text === '.') continue;
    const item = k => toks[k] && (toks[k].kind === 'ident' || toks[k].kind === 'num');
    if (!item(i + 1)) continue;                              // [ already, strength( in a condition, a word at its line end
    let j = i + 1;
    while (toks[j + 1]?.text === ',' && item(j + 2)) j += 2;
    const next = toks[j + 1];
    // frames A B: a one line form of a patchanim or a charanim
    if (t.text === 'frames' && j === i + 1 && next && next.kind !== 'nl' && item(j + 1)) continue;
    // layer NAME [overlay] ... { at the start of a line: a layer of a costume, no list
    if (t.text === 'layer' && (i === 0 || toks[i - 1].kind === 'nl') && lineHas(toks, j + 1, '{')) continue;
    edits.push([toks[i + 1].start, toks[j].end]);
  }
  let out = '', at = 0;
  for (const [a, b] of edits) { out += src.slice(at, a) + '[' + src.slice(a, b) + ']'; at = b; }
  return out + src.slice(at);
}

export function scan(src) {
  const out = [];
  let pos = 0;
  while (pos < src.length) {
    TOKEN_RE.lastIndex = pos;
    const m = TOKEN_RE.exec(src);
    if (!m) {
      out.push({ kind: 'bad', start: pos, end: pos + 1, text: src[pos] });
      pos += 1;
      continue;
    }
    const kind = KINDS[m.slice(1).findIndex(g => g !== undefined) + 1];
    out.push({ kind, start: pos, end: pos + m[0].length, text: m[0] });
    pos += m[0].length;
  }
  return out;
}

// a handler is named 'on' and its verb in one word - onLook, onUse(key), onEnter, onPreExit -, split
// into its words for the parser ('on look' in two words is refused): the words, or null for any
// other word (onion is none - the letter after 'on' is a capital)
const PRE_POST = /^(Pre|Post)(Enter|Exit)$/;
export function handlerWords(w) {
  if (!/^on[A-Z]/.test(w)) return null;
  const rest = w.slice(2), pp = PRE_POST.exec(rest);
  return pp ? ['on', pp[1].toLowerCase(), pp[2].toLowerCase()] : ['on', rest[0].toLowerCase() + rest.slice(1)];
}
// the name of a handler from its words: onName('look') 'onLook', onName('pre', 'enter') 'onPreEnter'
export const onName = (...words) => 'on' + words.map(w => w[0].toUpperCase() + w.slice(1)).join('');

export function tokenize(src) {
  const toks = [];
  let pos = 0, line = 1, prevEnd = 0, pending = [], last = null;
  while (pos < src.length) {
    TOKEN_RE.lastIndex = pos;
    const m = TOKEN_RE.exec(src);
    if (!m) throw new AdvError(`unexpected character '${src[pos]}'`, line);
    const kind = KINDS[m.slice(1).findIndex(g => g !== undefined) + 1];
    const text = m[0];
    const endLine = line + (text.match(/\n/g)?.length ?? 0);
    if (kind === 'comment') {
      if (last && last.endLine === line && !last.trail) {
        last.trail = { text, end: pos + text.length };
      } else {
        pending.push({ text, blank: line - prevEnd > 1 });
      }
      prevEnd = line;
    } else if (kind !== 'ws' && kind !== 'nl') {
      let value = text;
      if (kind === 'tstr') {
        let body = text.slice(3, -3);
        if (body.startsWith('\n')) body = body.slice(1);
        if (body.endsWith('\n')) body = body.slice(0, -1);
        value = body.split('\n');
      } else if (kind === 'str') {
        value = text.slice(1, -1).replace(/\\(.)/g, '$1');
      }
      const words = kind === 'ident' ? handlerWords(text) : null;
      if (words) {                               // onLook: the tokens 'on' and 'look', 'on' marked joined
        const [first, ...more] = words;
        toks.push({ kind, value: first, raw: 'on', line, endLine, start: pos, end: pos + 2,
                    blank: line - prevEnd > 1, lead: pending, trail: null, joined: true });
        for (const w of more) {
          last = { kind, value: w, raw: w, line, endLine, start: pos + 2, end: pos + text.length, blank: false, lead: [], trail: null };
          toks.push(last);
        }
      } else {
        last = { kind, value, raw: text, line, endLine, start: pos, end: pos + text.length,
                 blank: line - prevEnd > 1, lead: pending, trail: null };
        toks.push(last);
      }
      pending = [];
      prevEnd = endLine;
    }
    line = endLine;
    pos += text.length;
  }
  toks.push({ kind: 'eof', value: null, raw: '', line, endLine: line, start: pos, end: pos,
              blank: false, lead: pending, trail: null });
  return toks;
}

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
export const SPRITE_COLS = 24, SPRITE_ROWS = 21;
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


// --- parser --------------------------------------------------------------------------

class Parser {
  constructor(src) {
    this.src = src;
    this.toks = tokenize(src);
    this.i = 0;
  }

  peek(ofs = 0) { return this.toks[Math.min(this.i + ofs, this.toks.length - 1)]; }
  next() { return this.toks[this.i++]; }
  at(v, ofs = 0) { const t = this.peek(ofs); return (t.kind === 'ident' || t.kind === 'op') && t.value === v; }
  accept(v) { return this.at(v) ? this.next() : null; }
  expect(v) {
    const t = this.next();
    if ((t.kind !== 'ident' && t.kind !== 'op') || t.value !== v) {
      throw new AdvError(`expected '${v}', got ${show(t)}`, t.line);
    }
    return t;
  }
  expectKind(kind, what) {
    const t = this.next();
    if (t.kind !== kind) throw new AdvError(`expected ${what}, got ${show(t)}`, t.line);
    return t;
  }
  ident() { return this.expectKind('ident', 'name').value; }
  string() { return this.expectKind('str', 'string').value; }
  value() {
    const t = this.next();
    if (t.kind === 'num' || t.kind === 'ident') return t.raw;
    if (t.kind === 'op' && t.value === '-' && this.peek().kind === 'num') return '-' + this.next().raw;
    throw new AdvError(`expected value, got ${show(t)}`, t.line);
  }
  skipSeparators() { while (this.accept(';')); }

  // start/finish a node: comments, blank lines and original source text
  begin(fields) {
    const t = this.peek();
    return { node: { id: newId(), ...fields, line: t.line, blank: t.blank, lead: t.lead.length ? t.lead : undefined }, tok: t };
  }
  finish({ node, tok }) {
    const last = this.toks[this.i - 1];
    if (last.trail) node.trail = last.trail.text;
    node.src = this.src.slice(tok.start, last.trail ? last.trail.end : last.end);
    node.fp = fingerprint(node);
    return node;
  }

  parse() {
    const game = { id: newId(), kind: 'game', items: [] };
    for (;;) {
      this.skipSeparators();
      const t = this.peek();
      if (t.kind === 'eof') {
        if (t.lead.length) game.tail = t.lead;
        return game;
      }
      const it = this.topLevel();
      if (it) game.items.push(it);            // (null: a line that is dropped, an old 'bitmap')
    }
  }

  topLevel() {
    const t = this.peek();
    const b = this.begin({});
    const kw = this.ident();
    const n = b.node;
    switch (kw) {
      case 'import': Object.assign(n, { kind: 'import', path: this.string() }); break;   // import "FILE": imports.js
      case 'charset':
        Object.assign(n, { kind: 'charset', value: this.ident() });
        if (!['upper', 'lower'].includes(n.value)) throw new AdvError("charset must be 'upper' or 'lower'", t.line);
        break;
      case 'textfont':   // the font of the message line, the sentence line, the panels and the menu (engine/textfont.s)
        if (this.peek().kind === 'str') Object.assign(n, { kind: 'textfont', str: this.string() });
        else {
          Object.assign(n, { kind: 'textfont', value: this.ident() });
          if (!['upper', 'lower'].includes(n.value)) throw new AdvError("textfont must be 'upper', 'lower' or a charset file (\"FILE.chr\")", t.line);
        }
        break;
      // screens chars | tiles: the places of the game are made of chars or painted with tiles
      // (tileset.js); a game of tiles has the tile expander in its engine (engine/tiles.s)
      case 'screens':
        Object.assign(n, { kind: 'screens', value: this.ident() });
        if (!SCREEN_MODES.includes(n.value)) throw new AdvError("screens must be 'chars' or 'tiles'", t.line);
        break;
      case 'platform':
        Object.assign(n, { kind: 'platform', value: this.ident() });
        if (!PLATFORMS[n.value]) throw new AdvError(`unknown platform '${n.value}' (${Object.keys(PLATFORMS).join(', ')})`, t.line);
        break;
      case 'media': {
        // the media of the game, a list: media [prg, d64]
        const values = this.list(() => {
          const m = this.peek();
          const name = this.ident();
          if (!MEDIA[name]) throw new AdvError(`unknown media '${name}' (${Object.keys(MEDIA).join(', ')})`, m.line);
          return name;
        });
        Object.assign(n, { kind: 'media', values });
        break;
      }
      case 'control': {
        // the devices, a list: control [joystick, keyboard] - the first one is the one the game starts with
        const words = this.list(() => {
          const w = this.ident();
          if (!CONTROLS[w]) throw new AdvError(`control must be ${Object.keys(CONTROLS).join(', ')}`, t.line);
          return w;
        });
        Object.assign(n, { kind: 'control', value: controlValue(controlDevices(words.join(' '))) });
        break;
      }
      // title "NAME", author "NAME": the game and who made it, in the directory art of a .d64
      case 'gametitle': case 'title': Object.assign(n, { kind: 'gametitle', str: this.string() }); break;
      case 'author': Object.assign(n, { kind: 'author', str: this.string() }); break;
      // dirart "gfx/screen/NAME.scr": the directory art of a .d64, drawn on a canvas of 16 columns
      case 'dirart': Object.assign(n, { kind: 'dirart', str: this.string() }); break;
      case 'year': Object.assign(n, { kind: 'year', value: this.value() }); break;                // year N: the directory art too
      case 'mousespeed': Object.assign(n, { kind: 'mousespeed', value: this.value() }); break;
      // cursor flash: the cross goes from black to white and back (not the hourglass of a cutscene)
      // cursor still: the icons of symbol mode stand still (only with 'verbs symbol')
      // cursor cross|arrow|hand: the built-in cursor (CURSORS) - 'sprite cursor' wins
      case 'cursor': {
        const w = this.ident();
        if (w === 'flash') n.kind = 'cursorflash';
        else if (w === 'still') n.kind = 'cursorstill';
        else if (w === 'anim') {                          // cursor anim 1-5: the speed of the coin's icons, 3 normal
          const v = this.value();
          if (!/^[1-5]$/.test(v)) throw new AdvError(`cursor anim: 1 (slow) to 5 (fast), 3 is normal - not ${v}`, t.line);
          Object.assign(n, { kind: 'cursoranim', value: Number(v) });
        }
        else if (CURSORS[w]) Object.assign(n, { kind: 'cursorstyle', value: w });
        else throw new AdvError(`cursor: 'cursor flash', 'cursor still', 'cursor anim' or 'cursor ${Object.keys(CURSORS).join('|')}', not '${w}'`, t.line);
        break;
      }
      case 'messagerows': Object.assign(n, { kind: 'messagerows', value: this.value() }); break;    // rows of a message, 1-3
      // verbs text | symbol: text mode, the verbs as text in the panel, or symbol mode, the cursor is
      // the verb (SYMBOL_VERBS); the words before them, panel and coin, are gone
      case 'verbs': {
        const w = this.ident();
        if (w !== 'text' && w !== 'symbol') throw new AdvError(`verbs: 'verbs text' or 'verbs symbol', not '${w}'`, t.line);
        Object.assign(n, { kind: 'verbstyle', value: w });
        break;
      }
      // the startup picture that was: read and dropped (the intro shows a picture now); a
      // script saved again is without it
      case 'bitmap': this.string(); return null;
      // intro { picture "F.kla"  music "F.sng"  loadgame  text """...""" }: the program before the game
      case 'intro': {
        Object.assign(n, { kind: 'intro', picture: '', music: null, loadgame: false, text: '' });
        this.expect('{');
        while (!this.accept('}')) {
          const k = this.next();
          if (k.value === 'picture') n.picture = this.string();
          else if (k.value === 'music') n.music = this.string();
          else if (k.value === 'loadgame') n.loadgame = true;
          else if (k.value === 'text') n.text = this.peek().kind === 'tstr' ? this.next().value.join('\n') : this.string();
          else throw new AdvError(`intro: picture, music, text or loadgame, not ${show(k)}`, k.line);
        }
        break;
      }
      // prolog { writer { ... } } or { scroller { ... } }: a text sequence after the intro; epilog NAME
      // { ... }: an ending of the game, 'end NAME' shows it; outro { ... }: after every epilog, then
      // the game starts again (advc/adv/sequence.go, seqtags.js). One writer or one scroller -
      // another kind: delete it, make it anew
      case 'prolog': case 'epilog': case 'outro': {
        Object.assign(n, { kind: kw, ...(kw === 'epilog' ? { name: this.ident() } : {}), seqs: [] });
        this.expect('{');
        while (!this.accept('}')) {
          const k = this.next();
          if (k.value !== 'writer' && k.value !== 'scroller') throw new AdvError(`${kw}: 'writer' or 'scroller', not ${show(k)}`, k.line);
          if (n.seqs.length) throw new AdvError(`${kw}: it is one writer or one scroller - another one is an epilog of its own`, k.line);
          n.seqs.push(this.sequence(k.value));
        }
        if (!n.seqs.length) throw new AdvError(`${kw}: it has no writer { ... } or scroller { ... }`, t.line);
        break;
      }
      case 'steps': Object.assign(n, { kind: 'steps', values: this.stepsValues() }); break;   // the step sound of every place without its own
      case 'music': case 'sound':                                                           // a song of the whole game
        Object.assign(n, { kind: 'song', songKind: kw, name: this.ident(), file: this.string() }); break;
      case 'savegames':
        Object.assign(n, { kind: 'savegames', value: this.value() });
        if (this.accept('autosave')) n.autosave = true;      // the autosave slot is on
        break;
      case 'menutext':
        Object.assign(n, { kind: 'menutext', key: this.ident(), text: this.string() });
        if (!MENU_TEXTS[n.key]) throw new AdvError(`unknown menu text '${n.key}' (${Object.keys(MENU_TEXTS).join(', ')})`, t.line);
        break;
      case 'color': Object.assign(n, { kind: 'color', key: this.ident(), value: this.value() }); break;
      case 'legend': throw new AdvError(LEGEND_GONE, t.line);
      case 'verb': {
        Object.assign(n, { kind: 'verb', name: this.ident(), text: this.string(), prep: null });
        if (this.peek().kind === 'str') n.prep = this.string();
        this.accept('switch');                         // old switch verb flag, S switches now
        for (;;) {                                     // free: ignores strengths
          if (this.accept('free')) n.free = true;      // pickup: this verb takes 'pickable' objects
          else if (this.accept('pickup')) n.pickup = true;
          else break;
        }
        break;
      }
      case 'costume': {
        Object.assign(n, { kind: 'costume', name: this.ident(), frames: [], layers: [], anims: [] });
        if (this.peek().kind === 'str') {                // costume NAME "FILE" [{ anims }]: the art is in the file (gfxfile.js)
          Object.assign(n, { file: this.string(), _form: 'file' });
          if (this.at('{')) this.framesBlock(n, true);
          break;
        }
        n._form = 'inline';
        for (;;) {
          if (this.accept('multicolor')) n.multicolor = true;
          else if (this.accept('size')) n.size = [this.value(), this.value()];     // every frame is W x H sprites
          else if (this.accept('colors')) {                                          // the sprite color of each part, row by row
            n.colors = [];
            while ((this.peek().kind === 'num' || this.peek().kind === 'ident') && !this.at('multicolor') && !this.at('size')) n.colors.push(this.value());
            if (!n.colors.length) throw new AdvError('colors needs at least one color', this.peek().line);
          } else break;
        }
        this.framesBlock(n, true);
        // a costume without a default frame is a problem (validate), the file still opens
        break;
      }
      case 'actor': {
        this.actorDecl(n);
        break;
      }
      case 'chapter':
        // chapter NAME "title" [disk N]: the places that share a file on disk (advc/adv/disks.go)
        Object.assign(n, { kind: 'chapter', name: this.ident(), title: this.string(), disk: null, members: [] });
        if (this.accept('disk')) n.disk = this.value();
        if (this.at('{')) throw new AdvError("a chapter is the group of places that share a file on disk, it has no scripts (use 'onEnter' and 'onExit' of a place)", t.line);
        break;
      case 'var':
        Object.assign(n, { kind: 'var', name: this.ident(), init: null });
        if (this.accept('=')) n.init = this.value();
        break;
      case 'secret':
        Object.assign(n, { kind: 'secret', name: this.ident() });
        this.expect('=');
        n.text = this.string();
        break;
      case 'const':
        Object.assign(n, { kind: 'const', name: this.ident() });
        this.expect('=');
        n.value = this.value();
        break;
      case 'sprite': {
        Object.assign(n, { kind: 'sprite', name: this.ident() });
        if (this.accept('multicolor')) n.multicolor = true;
        if (this.peek().kind === 'str') Object.assign(n, { file: this.string(), lines: [], _form: 'file' });   // the art in a file (gfxfile.js)
        else Object.assign(n, { lines: this.expectKind('tstr', 'sprite data').value, _form: 'inline' });
        if (this.accept('hotspot')) {
          if (n.name !== 'cursor') throw new AdvError("only 'sprite cursor' has a hotspot", t.line);
          n.hotspot = this.pair();
        }
        break;
      }
      // start [PLACE X Y] { ... }: the place the game starts in, then what runs when it is there
      case 'start': {
        Object.assign(n, { kind: 'start', place: null, at: null });
        if (!this.at('{')) {
          n.place = this.ident();
          n.at = this.pair();
        }
        n.body = this.block();
        break;
      }
      // on pre|post enter|exit { ... }: the scripts that run around those of every place
      case 'on': {
        if (!t.joined) throw new AdvError(`a handler is one word: '${onName(this.peek().value, this.peek(1).value)}', not 'on ${this.peek().value} ${this.peek(1).value}'`, t.line);
        const when = this.ident();
        if (when !== 'pre' && when !== 'post') throw new AdvError(`'onPreEnter', 'onPostEnter', 'onPreExit' or 'onPostExit', not '${onName(when)}'`, t.line);
        const what = this.ident();
        if (what !== 'enter' && what !== 'exit') throw new AdvError(`'${onName(when, 'enter')}' or '${onName(when, 'exit')}', not '${onName(when, what)}'`, t.line);
        Object.assign(n, { kind: 'global', when, what, body: this.block() });
        break;
      }
      case 'default': Object.assign(n, { kind: 'default', verb: this.ident(), body: this.block() }); break;
      case 'sub': Object.assign(n, { kind: 'sub', name: this.ident(), body: this.block() }); break;
      case 'patch': Object.assign(n, { kind: 'patch' }, this.patch()); break;
      case 'place': this.place(n, kw); break;
      case 'room': case 'map': case 'closeup': throw new AdvError(`'${kw}' is 'place' now`, t.line);
      case 'object': this.object(n); break;
      default: throw new AdvError(`unknown statement '${kw}'`, t.line);
    }
    return this.finish(b);
  }

  // { frames, layers, anims } of a costume, or { frames } of a layer:
  // stand """..."""  walk """..."""  frame NAME [default] """...""" (default: the frame shown while standing)
  // layer NAME [multicolor | hires] [color C] { frames }
  // anim NAME { frames [FRAME, FRAME]  speed N }
  // idle N   (the seconds the actor stands before its animation 'idle' starts)
  // writer { ... } / scroller { ... } of a prolog or an epilog: charset, the screen or picture behind
  // the text, the rows of the text area, music and the text with its tags
  sequence(kind) {
    const s = { kind, charset: null, screen: null, picture: null, rows: null, music: null, typesound: null, fadeout: null, text: '' };
    this.expect('{');
    while (!this.accept('}')) {
      const k = this.next();
      switch (k.value) {
        case 'charset':
          if (this.peek().kind === 'str') s.charset = { file: this.string() };
          else {
            s.charset = this.ident();
            if (s.charset !== 'upper' && s.charset !== 'lower') throw new AdvError(`${kind}: charset must be 'upper', 'lower' or a charset file ("FILE.chr")`, k.line);
          }
          break;
        case 'screen': s.screen = this.string(); break;
        case 'picture': s.picture = this.string(); break;
        case 'rows': {
          const a = +this.expectKind('num', 'first row').value, b = +this.expectKind('num', 'last row').value;
          if (a < 0 || b > 24 || a > b) throw new AdvError(`${kind}: rows FIRST LAST, 0 to 24, not ${a} ${b}`, k.line);
          s.rows = [a, b];
          break;
        }
        case 'music': s.music = this.string(); break;
        case 'fadeout': {                                  // the scroller: its lines fade out at the top, in at the bottom
          if (kind !== 'scroller') throw new AdvError(`${kind}: fadeout is for a scroller (its lines leave at the top)`, k.line);
          s.fadeout = { top: false, bottom: false, fade: 'grey' };
          const FADE_NAMES = ['grey', 'red', 'blue', 'green', 'gold', 'purple', 'rainbow'];
          while (this.peek().kind === 'ident' && this.peek().line === k.line) {
            const w = this.peek().value;
            if (w === 'top') s.fadeout.top = true;
            else if (w === 'bottom') s.fadeout.bottom = true;
            else if (FADE_NAMES.includes(w)) s.fadeout.fade = w;
            else break;                                    // (the next setting on the line)
            this.next();
          }
          if (!s.fadeout.top && !s.fadeout.bottom) throw new AdvError('fadeout: top, bottom or both', k.line);
          break;
        }
        case 'typesound':                                  // a sound of the game for every char the writer types
          if (kind !== 'writer') throw new AdvError(`${kind}: typesound is for a writer (it types its text)`, k.line);
          s.typesound = this.ident();
          break;
        case 'text': s.text = this.peek().kind === 'tstr' ? this.next().value.join('\n') : this.string(); break;
        default: throw new AdvError(`${kind}: charset, screen, picture, rows, music, typesound, fadeout or text, not ${show(k)}`, k.line);
      }
    }
    return s;
  }

  framesBlock(owner, costume) {
    this.expect('{');
    for (;;) {
      this.skipSeparators();
      if (this.accept('}')) return;
      const kw = this.peek();
      const word = this.ident();
      if (owner.file && word !== 'anim' && word !== 'idle') throw new AdvError(`costume '${owner.name}' has its frames and layers in '${owner.file}': here only anims`, kw.line);
      if (word === 'stand' || word === 'walk' || word === 'frame') {
        const name = word === 'frame' ? this.ident() : word;
        if (owner.frames.some(f => f.name === name)) throw new AdvError(`frame '${name}' defined twice`, kw.line);
        // the id stays with the frame when it is renamed or moved; it is not written
        const isDefault = costume && this.accept('default');
        owner.frames.push({ id: newId(), name, ...(isDefault ? { default: true } : {}), lines: this.expectKind('tstr', 'sprite data').value });
      } else if (costume && word === 'layer') {
        // every layer is a sprite of its own (engine/layers.s): its mode ('multicolor', 'hires',
        // else the costume's - layerMulticolor) and its color; the older 'overlay' is refused
        const layer = { name: this.ident(), frames: [] };
        for (;;) {
          if (this.at('overlay')) throw new AdvError("'overlay' is gone: a layer is 'hires' or 'multicolor'", this.peek().line);
          else if (this.accept('multicolor')) layer.multicolor = true;
          else if (this.accept('hires')) layer.multicolor = false;
          else if (this.accept('color')) layer.color = this.value();
          else break;
        }
        this.framesBlock(layer, false);
        owner.layers.push(layer);
      } else if (costume && word === 'idle') {
        owner.idle = this.value();
      } else if (costume && word === 'anim' && this.at('{', 1)) {
        const anim = { name: this.ident(), frames: [], speed: null };
        this.expect('{');
        for (;;) {
          this.skipSeparators();
          if (this.accept('}')) break;
          const a = this.peek();
          const w = this.ident();
          if (w === 'frames') anim.frames = this.nameList();
          else if (w === 'speed') anim.speed = this.value();
          else if (w === 'mirror') anim.mirror = true;      // walk_left plays walk_right mirrored (and the other way)
          else if (w === 'vary') anim.vary = this.value();   // a step shows speed +- up to vary frames at random
          else if (w === 'play') {                          // the order of the frames
            const v = this.peek(), how = this.ident();
            if (!ANIM_PLAYS.includes(how)) throw new AdvError(`anim '${anim.name}': play is ${ANIM_PLAYS.join(', ')}, not '${how}'`, v.line);
            if (how !== 'forward') anim.play = how;
          } else throw new AdvError(`anim '${anim.name}' has no attribute '${w}' (frames, speed, vary, play, mirror)`, a.line);
        }
        if (anim.mirror && (anim.frames.length || anim.speed != null || anim.play || anim.vary != null))
          throw new AdvError(`anim '${anim.name}' is 'mirror': it plays '${mirrorPartner(anim.name)}' mirrored, with its frames, speed, vary and order, and has none of its own`, kw.line);
        if (!anim.mirror && !anim.frames.length) throw new AdvError(`anim '${anim.name}' needs frames`, kw.line);
        owner.anims.push(anim);
      } else if (costume && word === 'anim') {
        throw new AdvError("an anim is a block: anim NAME { frames [A, B]  speed N }", kw.line);
      } else {
        throw new AdvError(costume ? `a costume holds frames (stand, walk, frame NAME), layers, anims and idle, not '${word}'`
          : `a layer holds frames (stand, walk, frame NAME), not '${word}'`, kw.line);
      }
    }
  }

  // inPlace: without data the patch is in the graphics file of the place ('gfx', gfxfile.js)
  // patch NAME { at (C, R)  when EXPR  data """...""" [colors """..."""] }
  patch(inPlace = false) {
    const name = this.ident();
    if (this.accept('{')) {
      const n = { name, col: null, row: null, lines: null, colors: null };
      for (;;) {
        this.skipSeparators();
        if (this.accept('}')) break;
        const t = this.peek();
        const kw = this.ident();
        if (kw === 'at') [n.col, n.row] = this.pair();
        else if (kw === 'when') n.cond = this.expr();
        else if (kw === 'data') { n.lines = this.expectKind('tstr', 'patch data').value; n.colors = this.colorMap(); }
        else throw new AdvError(`patch '${name}' has no attribute '${kw}' (at, when, data)`, t.line);
      }
      if (n.col == null) throw new AdvError(`patch '${name}' needs 'at (COL, ROW)'`, this.peek().line);
      if (n.lines) return inPlace ? { ...n, _form: 'inline' } : n;
      if (!inPlace) throw new AdvError(`patch '${name}' is in no place: it needs 'data'`, this.peek().line);
      return { ...n, lines: [], _form: 'file' };
    }
    throw new AdvError(`a patch is a block: patch ${name} { at (COL, ROW)  when COND  data """...""" }`, this.peek().line);
  }

  // optional 'colors """..."""' right after a map block
  colorMap() {
    return this.accept('colors') ? this.expectKind('tstr', 'color map').value : null;
  }

  // steps NAME [every N] | steps off: the sound of the steps of the character the player walks with
  stepsValues() {
    const values = [this.ident()];
    if (this.accept('every')) values.push('every', this.value());
    return values;
  }

  // place NAME { title "Hall"  fullscreen  screen { ... }  the rest }. What makes the screen stands in
  // 'screen { ... }'; the older form - title and kind in the head, the screen's lines among the
  // others - is _old and written anew. There are no kinds of places any more: a place entered with
  // 'goto PLACE' without a position is shown without actors (noActors). The older 'map' and
  // 'closeup' - a keyword, a word of the head, a line - are read and left out
  place(n, keyword = 'place') {
    Object.assign(n, { kind: 'place', keyword: 'place', name: this.ident(), members: [] });
    if (this.peek().kind === 'str') throw new AdvError(`the title of a place is a line of it: title "${this.peek().value}"`, this.peek().line);
    if (this.at('map') || this.at('closeup') || this.at('fullscreen')) {
      throw new AdvError(this.at('fullscreen') ? "'fullscreen' is a line of the place" : `'${this.peek().value}' is gone: a place entered with 'goto PLACE' is shown without actors`, this.peek().line);
    }
    const open = this.expect('{');
    if (open.trail) n.openTrail = open.trail.text;
    let screen = 0;                          // inside 'screen { ... }': its lines are members of the place
    for (;;) {
      this.skipSeparators();
      if (this.at('}')) {
        const close = this.next();
        if (screen) { screen = 0; continue; }
        if (close.lead.length) n.closeLead = close.lead;
        return;
      }
      const t = this.peek();
      if (!screen && this.at('screen') && this.at('{', 1)) {
        this.next(); this.next();
        screen = 1;
        continue;
      }
      if (!screen && this.at('title') && this.peek(1).kind === 'str') { this.next(); n.title = this.string(); continue; }
      if (!screen && t.value === 'fullscreen' && t.kind === 'ident' && this.peek(1).line !== t.line) {
        this.next();                          // a line of its own: fullscreen
        n.fullscreen = true;
        continue;
      }
      if (!screen && ['closeup', 'map'].includes(t.value) && t.kind === 'ident' && this.peek(1).line !== t.line) {
        throw new AdvError(`'${t.value}' is gone: a place entered with 'goto PLACE' is shown without actors`, t.line);
      }
      const b = this.begin({});
      const kw = this.ident();
      const m = b.node;
      if (kw === 'background' || kw === 'gfx') {
        if (n._form) throw new AdvError(`place '${n.name}' has two screens`, t.line);
        if (kw === 'gfx') Object.assign(m, { kind: 'background', file: this.string(), lines: [], colors: null, _form: 'file' });   // gfx "FILE": screen and patches
        else {
          Object.assign(m, { kind: 'background', lines: this.expectKind('tstr', 'background map').value, _form: 'inline' });
          m.colors = this.colorMap();
        }
        n._form = m._form;
      }
      else if (FILE_ATTRS.includes(kw)) Object.assign(m, { kind: 'attr', key: kw, str: this.string() });
      else if (kw === 'chapter') Object.assign(m, { kind: 'attr', key: kw, values: [this.ident()] });
      // music NAME "file.sng" / sound NAME "file.sng": a song of this place; music NAME: what plays when it is entered
      else if ((kw === 'music' || kw === 'sound') && this.peek(1).kind === 'str') Object.assign(m, { kind: 'song', songKind: kw, name: this.ident(), file: this.string() });
      else if (kw === 'music') Object.assign(m, { kind: 'attr', key: kw, values: [this.ident()] });
      else if (kw === 'steps') Object.assign(m, { kind: 'attr', key: kw, values: this.stepsValues() });   // the step sound of the place
      else if (kw === 'walk_area') {                                                                       // walk_area (X, Y) (X, Y) ...: the corners, flat
        Object.assign(m, { kind: 'attr', key: 'walkarea', values: this.pair() });
        while (this.at('(')) m.values.push(...this.pair());
      }
      else if (kw === 'walkarea') throw new AdvError("'walkarea' is 'walk_area' now", t.line);
      else if (kw === 'block_area') {                                                                      // block_area (X, Y) (X, Y) ... [unless COND]: not walked on
        Object.assign(m, { kind: 'attr', key: 'blockarea', values: this.pair() });                         // (unless COND holds)
        while (this.at('(')) m.values.push(...this.pair());
        if (this.at('unless')) { this.ident(); m.cond = this.expr(); }
      }
      else if (kw === 'behind_area' && this.at('pixels')) {   // behind_area pixels (X, Y) (X, Y) ...: a polygon in the
        this.ident();                                           // units of walk_area - x in walk units, y the feet pixel row
        Object.assign(m, { kind: 'attr', key: 'behindpx', values: this.pair() });
        while (this.at('(')) m.values.push(...this.pair());
      }
      else if (kw === 'behind_area') throw new AdvError("a behind area is a polygon in pixels: behind_area pixels (X, Y) (X, Y) ...", t.line);
      else if (kw === 'behind') throw new AdvError("a behind area is a polygon in pixels: behind_area pixels (X, Y) (X, Y) ...", t.line);
      else if (kw === 'walkbox') Object.assign(m, { kind: 'attr', key: kw, values: [...this.pair(), ...this.pair()] });   // walkbox (X1, Y1) (X2, Y2)
      else if (kw in PLACE_ATTR_ARITY) {
        Object.assign(m, { kind: 'attr', key: kw, values: [] });
        for (let k = 0; k < PLACE_ATTR_ARITY[kw]; k++) m.values.push(this.value());
      } else if (kw === 'legend') throw new AdvError(LEGEND_GONE, t.line);
      else if (kw === 'patch') Object.assign(m, { kind: 'patch' }, this.patch(true));
      else if (kw === 'object') this.object(m);
      else if (kw === 'location') throw new AdvError("'location' is gone: an object whose handler for the first verb travels (onWalk { goto PLACE (X, Y) })", t.line);
      else if (kw === 'actor') this.actorDecl(m);
      else if (kw === 'charanim' && (this.at('{') || this.at('{', 1))) {
        // charanim [NAME] { char CODE  frames [CODE, CODE]  speed N }  (the name is for the editor)
        Object.assign(m, { kind: 'charanim', code: null, frames: [], speed: null });
        if (!this.at('{')) m.name = this.ident();
        this.expect('{');
        for (;;) {
          this.skipSeparators();
          if (this.accept('}')) break;
          const a = this.peek();
          const w = this.ident();
          if (w === 'char') m.code = this.value();
          else if (w === 'frames') m.frames = this.list(() => this.value());
          else if (w === 'speed') m.speed = this.value();
          else throw new AdvError(`charanim has no attribute '${w}' (char, frames, speed)`, a.line);
        }
        if (m.code == null || !m.frames.length) throw new AdvError("charanim needs 'char CODE' and 'frames'", t.line);
      }
      else if (kw === 'charanim') throw new AdvError("a charanim is a block: charanim [NAME] { char CODE  frames [CODE, CODE]  speed N }", t.line); else if (kw === 'patchanim' && this.at('{', 1)) {
        // patchanim NAME { frames [A, B]  speed N  once  auto | when COND }
        Object.assign(m, { kind: 'patchanim', name: this.ident(), frames: [], speed: null });
        this.expect('{');
        for (;;) {
          this.skipSeparators();
          if (this.accept('}')) break;
          const l = this.peek();
          const w = this.ident();
          if (w === 'frames') m.frames = this.nameList();
          else if (w === 'speed') m.speed = this.value();
          else if (w === 'once') m.once = true;
          else if (w === 'auto') m.auto = true;
          else if (w === 'when') m.cond = this.expr();
          else throw new AdvError(`patchanim '${m.name}' has no attribute '${w}' (frames, speed, once, auto, when)`, l.line);
        }
      } else if (kw === 'patchanim') {
        throw new AdvError("a patchanim is a block: patchanim NAME { frames [A, B]  speed N  once  auto | when COND }", t.line);
      }
      else if (kw === 'place') this.place(m, kw);
      else if (['room', 'map', 'closeup'].includes(kw)) throw new AdvError(`'${kw}' is 'place' now`, t.line);
      else if (kw === 'var' || kw === 'global') {                  // local to this place; 'global var': declared here, every place uses it
        if (kw === 'global') this.expect('var');
        Object.assign(m, { kind: 'var', name: this.ident(), init: null });
        if (kw === 'global') m.global = true;
        if (this.accept('=')) m.init = this.value();
      }
      else if (kw === 'sub') Object.assign(m, { kind: 'sub', name: this.ident(), body: this.block() });
      else if (kw === 'on') {
        const ev = this.ident();
        if (ev !== 'enter' && ev !== 'exit') throw new AdvError(`places support 'onEnter' and 'onExit', not '${onName(ev)}'`, t.line);
        if (!t.joined) throw new AdvError(`a handler is one word: '${onName(ev)}', not 'on ${ev}'`, t.line);
        Object.assign(m, { kind: ev === 'enter' ? 'enter' : 'exit', body: this.block() });
      } else throw new AdvError(`unknown place attribute '${kw}'`, t.line);
      if (screen && !isScreenMember(m)) throw new AdvError(`'${kw}' belongs to the place, not to its screen`, t.line);
      if (!screen && isScreenMember(m)) throw new AdvError(`'${kw}' belongs to the screen of the place: screen { ${kw} ... }`, t.line);
      n.members.push(this.finish(b));
    }
  }

  // object NAME { attrs, var NAME = V, handlers }
  // actor NAME { in PLACE  at (X, Y)  costume C  color c  talkcolor c  talksound s  face d  state n  playable  strength [A, B] ... }
  // The attributes are lines of the block. 'name "title"' there is the title; without one the object is
  // called by its name.
  object(n, kind = 'object') {
    Object.assign(n, { kind, name: this.ident(), title: null, attrs: [], handlers: null, elseText: null });
    if (this.peek().kind === 'str') throw new AdvError(`the title of '${n.name}' is a line of its block: name "${this.peek().value}"`, this.peek().line);
    const head = this.peek();
    if (this.objectAttr(n)) throw new AdvError(`the attributes of '${n.name}' are lines of its block: ${n.kind} ${n.name} { ${head.value} ... }`, head.line);
    this.objectBlock(n);
    n.title ??= n.name;
  }

  // one attribute of an object or actor; false when there is none
  objectAttr(n) {
    const actor = n.kind === 'actor';
    const push = (key, values, extra = {}) => { n.attrs.push({ key, values, ...extra }); return true; };
    if (this.at('name') && this.peek(1).kind === 'str') { this.next(); n.title = this.string(); return true; }
    if (this.accept('else')) { n.elseText = this.string(); return true; }
    if (this.at('needs') || (!actor && (this.at('layer') || this.at('layers'))) || (actor && this.at('strength'))) {
      const key = this.next().value;
      return push(key === 'layers' ? 'layer' : key, this.nameList());
    }
    if (!actor && this.accept('pickable')) return push('pickable', []);   // the verb pickup takes it
    if (actor && this.accept('playable')) return push('playable', []);
    if (this.accept('at')) return push('at', this.pair());
    if (!actor && this.accept('size')) return push('size', this.size());
    if (!actor && this.accept('walkto')) return push('walkto', this.pair());
    if (this.accept('in')) return push('in', [this.ident()]);
    // hand VERB [if EXPR]: in symbol mode the hand over it is that verb while the condition holds -
    // its sentence, its click (the icon stays the hand); the first rule that holds wins, one without
    // 'if' comes last
    if (this.accept('hand')) {
      const verb = this.ident();
      return push('hand', [verb], this.accept('if') ? { cond: this.expr() } : {});
    }
    if (this.accept('state')) {
      // state N | state [NAME, NAME, ...] [= NAME]: the names of the states, 0, 1, ... and the first one
      if (this.peek().kind === 'ident' && this.at('|', 1)) {
        const name = this.peek().value;
        throw new AdvError(`state: the names of the states are a list - state [${name}, ...], not '${name} | ...'`, this.peek().line);
      }
      if (this.at('[')) {
        const names = this.nameList();
        const first = this.accept('=') ? this.ident() : names[0];
        if (!names.includes(first)) throw new AdvError(`'${n.name}' starts in state '${first}', which is not one of [${names.join(', ')}]`, this.peek().line);
        return push('state', [first], { names });
      }
      return push('state', [this.value()]);
    }
    if (actor && (this.at('costume') || this.at('face'))) { const key = this.next().value; return push(key, [this.ident()]); }
    if (actor && this.at('color') && !(this.peek(1).kind === 'ident' && [...UI_COLORS, PANEL_COLOR, ...SPRITE_COLORS].includes(this.peek(1).value))) {
      this.next();
      return push('color', [this.value()]);
    }
    if (actor && this.accept('talkcolor')) return push('talkcolor', [this.value()]);
    if (actor && this.accept('talksound')) return push('talksound', [this.ident()]);   // a global sound, played at every say of the actor
    return false;
  }

  // { attributes, variables of its own, handlers 'on VERB [OTHER]' or 'on VERB(OTHER)' }. The comments
  // above an attribute line and behind it are kept with it (notes), for when the object is written anew
  objectBlock(n) {
    if (!this.at('{')) return;
    const open = this.next();
    if (open.trail) n.openTrail = open.trail.text;
    n.handlers = [];
    for (;;) {
      this.skipSeparators();
      if (this.at('}')) {
        const close = this.next();
        if (close.lead.length) n.closeLead = close.lead;
        return;
      }
      const t = this.peek();
      const note = () => {
        const last = this.toks[this.i - 1];
        const x = {};
        if (t.lead.length) x.lead = t.lead;
        if (t.blank) x.blank = true;
        if (last.trail) x.trail = last.trail.text;
        return Object.keys(x).length ? x : null;
      };
      if (this.accept('var')) {                   // its own variable: OBJ.NAME for the code outside it
        const v = { name: this.ident(), init: null };
        if (this.accept('=')) v.init = this.value();
        if ((n.vars ??= []).some(x => x.name === v.name)) throw new AdvError(`'${n.name}' has the variable '${v.name}' twice`, t.line);
        const x = note();
        if (x) v.note = x;
        n.vars.push(v);
        continue;
      }
      if (!this.at('on')) {
        const before = n.attrs.length, key = t.value;
        if (!this.objectAttr(n)) throw new AdvError(`'${n.name}' has no attribute '${t.raw}'`, t.line);
        const x = note();
        if (x) {
          if (n.attrs.length > before) n.attrs[n.attrs.length - 1].note = x;
          else (n.notes ??= {})[key === 'when' ? 'if' : key] = x;
        }
        continue;
      }
      const b = this.begin({ kind: 'handler' });
      if (!this.peek().joined) throw new AdvError(`a handler is one word: '${onName(this.peek(1).value)}', not 'on ${this.peek(1).value}'`, this.peek().line);
      this.expect('on');
      b.node.verb = this.ident();
      b.node.other = null;
      if (this.accept('(')) {
        b.node.other = this.ident();
        this.expect(')');
      } else if (this.peek().kind === 'ident') {
        throw new AdvError(`the second object is in brackets: '${onName(b.node.verb)}(${this.peek().value})'`, this.peek().line);
      }
      b.node.body = this.block();
      n.handlers.push(this.finish(b));
    }
  }

  // (X, Y): a position, always in brackets
  pair() {
    if (!this.at('(')) throw new AdvError(`a position is written in brackets: (X, Y), not ${show(this.peek())}`, this.peek().line);
    this.next();
    const a = this.value();
    this.expect(',');
    const b = this.value();
    this.expect(')');
    return [a, b];
  }

  // (W, H): a size, always in brackets
  size() {
    if (!this.at('(')) throw new AdvError(`a size is written in brackets: (W, H), not ${show(this.peek())}`, this.peek().line);
    return this.pair();
  }

  // actor NAME ["title"] [attrs] [{ attrs, var, handlers }]: see object
  actorDecl(n) {
    this.object(n, 'actor');
  }

  // a list - frames, layers, strengths: [NAME, NAME, ...], always in brackets (also one name)
  nameList() {
    return this.list(() => this.ident());
  }
  list(item) {
    const open = this.peek();
    if (!this.accept('[')) throw new AdvError(`a list is written in brackets: [A, B], not '${open.value ?? ''}'`, open.line);
    const items = [item()];
    while (this.accept(',')) items.push(item());
    this.expect(']');
    return items;
  }

  // choose { option "text" [if EXPR] { ... } }
  options() {
    this.expect('{');
    const options = [];
    for (;;) {
      this.skipSeparators();
      if (this.accept('}')) return options;
      const t = this.peek();
      this.expect('option');
      const opt = { text: this.string(), cond: null, body: null };
      if (t.lead.length) opt.lead = t.lead;
      if (this.accept('if')) opt.cond = this.expr();
      opt.body = this.block();
      options.push(opt);
    }
  }

  // statements ------------------------------------------------------------------------
  block() {
    const open = this.expect('{');
    const body = { stmts: [] };
    if (open.trail) body.openTrail = open.trail.text;
    for (;;) {
      this.skipSeparators();
      if (this.at('}')) {
        const close = this.next();
        if (close.lead.length) body.tail = close.lead;
        body.inline = close.line === open.line;
        return body;
      }
      body.stmts.push(this.statement());
    }
  }

  statement() {
    const t = this.peek();
    if (t.kind !== 'ident') throw new AdvError(`statement expected, got ${show(t)}`, t.line);
    const b = this.begin({ kind: 'stmt' });
    const s = b.node;
    const kw = t.value;
    const nx = this.peek(1);
    const assignLike = nx.kind === 'op' && ['=', '+=', '-=', '.'].includes(nx.value);
    if ((kw === 'showmap' || kw === 'view') && !assignLike) throw new AdvError(`'${kw}' is 'goto PLACE' now`, t.line);
    if (SIMPLE_KW.includes(kw) && !assignLike) {
      this.next();
      s.op = kw;
      switch (kw) {
        case 'say': {
          // say "text" | say ACTOR "text" | say ACTOR SECRET | say SECRET (the second name on the same line)
          Object.assign(s, { actor: null, secret: null, text: null });
          if (this.peek().kind !== 'ident') { s.text = this.string(); break; }
          const name = this.ident();
          if (this.peek().kind === 'str') { s.actor = name; s.text = this.string(); }
          else if (this.peek().kind === 'ident' && this.peek().line === this.toks[this.i - 1].line) { s.actor = name; s.secret = this.ident(); }
          else s.secret = name;
          break;
        }
        case 'walk':
          if (this.accept('to')) { s.op = 'walkto'; s.obj = this.ident(); }
          else if (this.peek().kind === 'ident' && (this.at('to', 1) || this.at('at', 1))) {
            s.actor = this.ident();
            if (this.accept('to')) { s.op = 'walkactorto'; s.obj = this.ident(); }
            else { this.expect('at'); s.op = 'walkactor'; [s.x, s.y] = this.pair(); }
          } else [s.x, s.y] = this.pair();
          break;
        case 'put':
          s.actor = this.ident();
          this.expect('in');
          s.place = this.ident();
          this.expect('at');
          [s.x, s.y] = this.pair();
          break;
        case 'select': case 'show': case 'hide': s.actor = this.ident(); break;
        case 'print': {
          // print { at (COL, ROW)  text "..." | var NAME  digits N  color C }
          s.color = null;
          if (!this.at('{')) throw new AdvError('print is a block: print { at (COL, ROW)  text "..." }', t.line);
          if (this.accept('{')) {
            let text = null, name = null, digits = null;
            for (;;) {
              this.skipSeparators();
              if (this.accept('}')) break;
              const a = this.peek();
              const kw2 = this.ident();
              if (kw2 === 'at') [s.col, s.row] = this.pair();
              else if (kw2 === 'text') text = this.string();
              else if (kw2 === 'var') name = this.ident();
              else if (kw2 === 'digits') digits = this.value();
              else if (kw2 === 'color') s.color = this.value();
              else throw new AdvError(`print has no attribute '${kw2}' (at, text, var, digits, color)`, a.line);
            }
            if (s.col == null || (text == null && name == null)) throw new AdvError("print needs 'at (COL, ROW)' and a 'text' or a 'var'", t.line);
            if (text != null) s.text = text;
            else Object.assign(s, { op: 'printvar', var: name, digits });
            break;
          }
          break;
        }
        case 'entry': {
          const sub = this.ident();
          if (sub === 'add') { s.op = 'entryadd'; s.ch = this.string(); }
          else if (sub === 'clear') s.op = 'entryclear';
          else if (sub === 'show') {
            // entry show { at (COL, ROW)  width N  color C }
            Object.assign(s, { op: 'entryshow', col: null, row: null, width: null, color: null });
            if (this.accept('{')) {
              for (;;) {
                this.skipSeparators();
                if (this.accept('}')) break;
                const a = this.peek();
                const kw = this.ident();
                if (kw === 'at') [s.col, s.row] = this.pair();
                else if (kw === 'width' || kw === 'color') s[kw] = this.value();
                else throw new AdvError(`entry show has no attribute '${kw}' (at, width, color)`, a.line);
              }
              if (s.col == null) throw new AdvError("entry show needs 'at (COL, ROW)'", t.line);
            } else throw new AdvError('entry show is a block: entry show { at (COL, ROW)  width N  color C }', t.line);
          } else throw new AdvError("entry needs 'add', 'clear' or 'show'", t.line);
          break;
        }
        case 'give': s.obj = this.ident(); this.expect('to'); s.actor = this.ident(); break;
        case 'follow': s.actor = this.ident(); s.leader = this.ident(); break;
        case 'choose': s.options = this.options(); break;
        case 'goto':                            // goto PLACE (X, Y), or goto PLACE: shown without actors
          s.place = this.ident();
          if (this.at('(') || this.peek().kind === 'num') [s.x, s.y] = this.pair();
          else s.x = s.y = null;
          break;
        case 'wait': s.n = this.value(); break;
        case 'draw': s.patch = this.ident(); break;
        case 'music': case 'sound': s.song = this.ident(); break;
        case 'pickup': case 'drop': s.obj = this.ident(); break;
        case 'place': s.obj = this.ident(); s.place = this.ident(); break;
        case 'setpos': [s.x, s.y] = this.pair(); break;
        case 'face': {
          const who = this.ident();
          if (DIRECTIONS.includes(who)) s.dir = who;
          else { s.op = 'faceactor'; s.actor = who; s.dir = this.ident(); }
          break;
        }
        case 'actor': s.mode = this.ident(); break;
        case 'call': case 'run': s.sub = this.ident(); break;
        case 'end': s.epilog = this.ident(); break;                // end NAME: epilog NAME follows
        case 'stop':                                               // stop SUB: its background thread ends
          if (this.peek().kind === 'ident' && this.peek().line === t.line) { s.op = 'stopsub'; s.sub = this.ident(); }
          break;
        case 'animate': {
          // animate ACTOR ANIM [once] | animate ACTOR off | animate PATCHANIM [once | off]
          s.target = this.ident();
          const words = [];
          while (this.peek().kind === 'ident' && this.peek().line === t.line) words.push(this.ident());
          s.anim = null;
          s.mode = 'loop';
          if (words[0] === 'off' || words[0] === 'once') s.mode = words.shift();
          else if (words.length) {
            s.anim = words.shift();
            if (words[0] === 'once') s.mode = words.shift();
          }
          if (words.length) throw new AdvError(`animate: unexpected '${words[0]}'`, t.line);
          break;
        }
      }
    } else if (kw === 'if') {
      this.next();
      s.op = 'if';
      s.branches = [{ cond: this.expr(), body: this.block() }];
      s.else = null;
      for (;;) {
        this.skipSeparators();
        const elseTok = this.peek();
        if (!this.accept('else')) break;
        const lead = elseTok.lead.length ? elseTok.lead : undefined;
        if (this.accept('if')) {
          s.branches.push({ cond: this.expr(), body: this.block(), lead });
        } else {
          s.else = this.block();
          if (lead) s.elseLead = lead;
          break;
        }
      }
    } else if (kw === 'while') {
      this.next();
      s.op = 'while';
      s.cond = this.expr();
      s.body = this.block();
    } else if (kw === 'cutscene') {
      this.next();
      s.op = 'cutscene';
      s.frames = null;
      s.skip = 'no skip';
      while (!this.at('{')) {
        if (this.accept('skip')) {
          if (s.skip === 'skip') throw new AdvError("cutscene: 'skip' twice", t.line);
          s.skip = 'skip';
        } else if (s.frames == null) s.frames = this.value();
        else throw new AdvError("use 'cutscene [FRAMES] [skip] { ... }'", t.line);
      }
      s.body = this.block();
    } else {
      let target = this.ident();
      if (this.accept('.')) {
        const attr = this.ident();
        target += '.' + attr;                       // .state, .place or a variable of an object or place
      }
      const op = this.next();
      if (op.kind !== 'op' || !['=', '+=', '-='].includes(op.value)) {
        throw new AdvError(`unknown statement '${target}'`, t.line);
      }
      s.op = 'assign';
      s.target = target;
      s.aop = op.value;
      s.expr = this.expr();
    }

    return this.finish(b);
  }

  // expressions are validated with the compiler's grammar but stored as text
  expr() {
    const from = this.i;
    this.orExpr();
    return joinTokens(this.toks.slice(from, this.i));
  }
  orExpr() { this.andExpr(); while (this.accept('or')) this.andExpr(); }
  andExpr() { this.notExpr(); while (this.accept('and')) this.notExpr(); }
  notExpr() { if (this.accept('not')) this.notExpr(); else this.cmpExpr(); }
  cmpExpr() {
    const start = this.i;
    this.addExpr();
    const t = this.peek();
    if (t.kind === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(t.value)) {
      this.next();
      // entry == "1234": compare the code entry with a string (or a secret, a name like any other)
      const entry = this.i - 1 === start + 1 && this.toks[start].value === 'entry';
      if (entry && (t.value === '==' || t.value === '!=') && this.peek().kind === 'str') this.next();
      else this.addExpr();
    }
  }
  addExpr() {
    this.primary();
    while (this.peek().kind === 'op' && ['+', '-'].includes(this.peek().value)) { this.next(); this.primary(); }
  }
  primary() {
    const t = this.next();
    if (t.kind === 'num') return;
    if (t.kind === 'op' && t.value === '(') { this.orExpr(); this.expect(')'); return; }
    if (t.kind === 'ident') {
      if (['shl', 'shr', 'and', 'or', 'xor', 'mod'].includes(t.value) && this.at('(')) {    // functions of two values: the bits, mod
        this.next(); this.orExpr(); this.expect(','); this.orExpr(); this.expect(')');
        return;
      }
      if (t.value === 'can' && this.at('(')) throw new AdvError("'can(...)' is 'strength(...)' now", t.line);   // the old word: refused, the new one named
      if ((t.value === 'has' || t.value === 'strength' || t.value === 'random') && this.accept('(')) {
        if (t.value === 'random') { this.value(); if (this.accept(',')) this.value(); }   // random(N), random(LOW, HIGH)
        else { this.ident(); if (this.accept(',')) this.ident(); }
        this.expect(')');
        return;
      }
      if (this.accept('.')) {                        // .state, .place, entry.length or a variable of an object or place
        const a = this.peek();
        this.ident();
        if (a.value === 'room') throw new AdvError("'.room' is '.place' now", a.line);
      }
      return;
    }
    throw new AdvError(`expression expected, got ${show(t)}`, t.line);
  }
}

function show(t) {
  return t.kind === 'eof' ? 'end of file' : `'${Array.isArray(t.value) ? '"""' : t.raw}'`;
}

function joinTokens(toks) {
  let out = '';
  toks.forEach((t, k) => {
    const prev = toks[k - 1];
    const glue = !prev || t.raw === '.' || t.raw === ')' || t.raw === ',' || prev.raw === '.' || prev.raw === '(' ||
      (t.raw === '(' && prev.kind === 'ident' && (['has', 'strength', 'random', 'shl', 'shr', 'xor', 'mod'].includes(prev.raw) ||
        // and( / or( as a function: where an operand starts, not between two values
        (['and', 'or'].includes(prev.raw) && (!toks[k - 2] || (toks[k - 2].kind === 'op' && toks[k - 2].raw !== ')') || ['and', 'or', 'not'].includes(toks[k - 2].raw)))));
    out += (glue ? '' : ' ') + t.raw;
  });
  return out;
}

export function parse(src) {
  return new Parser(src.replace(/\r\n?/g, '\n')).parse();
}

// 'legend "c" CODE COLOR' is gone: a map is drawn with the PETSCII glyphs themselves (and a colors block)
export const LEGEND_GONE = "'legend' is gone: draw the map with PETSCII glyphs and a 'colors' block";
// what a travel says while its rule does not hold (actions.js: a travel made in the editor)
export const LOCKED_TEXT = "You can't go there yet.";

// A fragment is parsed by wrapping it in the line the grammar wants, so everything the parser
// says is one line further down than what the user typed. Errors are thrown while tokenizing and
// while parsing, before any node exists to correct - so they are caught and moved back here.
function unwrapLine(e) {
  if (e instanceof AdvError && e.line) return new AdvError(e.plain, e.line - 1);
  return e;
}

// parse only a statement list, used by the inspector's code editor
export function parseBody(text) {
  try {
    const p = new Parser('{\n' + text.replace(/\r\n?/g, '\n') + '\n}');
    const body = p.block();
    if (p.peek().kind !== 'eof') throw new AdvError(`unexpected ${show(p.peek())}`, p.peek().line);
    walkBody(body, s => { s.line -= 1; });
    return body;
  } catch (e) {
    throw unwrapLine(e);
  }
}

// The scripts of a place as text, for the code tab of a place (codearea.js). The text is the
// inside of a place without its graphics, one indent level less than in the file - so it is read
// by wrapping it in a place again and letting the ordinary parser do the work. Nothing about the
// grammar is special; what may appear in the text is decided when it is merged back (advgen.js).
export const SCRIPT_IND = '    ';

// the members the code tab shows; everything else of a place is edited in the other tabs
export const SCRIPT_KINDS = new Set(['enter', 'exit', 'sub', 'object', 'actor']);

export function parsePlaceScripts(text) {
  try {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const body = lines.map(l => (l.trim() ? SCRIPT_IND + l : l)).join('\n');
    const p = new Parser('place __tab {\n' + body + '\n}\n');
    p.expect('place');
    const b = p.begin({});
    p.place(b.node);
    const place = p.finish(b);
    if (p.peek().kind !== 'eof') throw new AdvError(`unexpected ${show(p.peek())}`, p.peek().line);
    // the wrapper took the first line: every line is one lower than the parser saw it
    walk({ items: [place] }, x => { if (x.line) x.line -= 1; });
    return place.members;
  } catch (e) {
    throw unwrapLine(e);
  }
}


// The handlers of one object or person as text, for its code tab. Like parsePlaceScripts it is
// read by wrapping it in what the grammar wants and letting the ordinary parser do the work.
export function parseObjectHandlers(text) {
  try {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const body = lines.map(l => (l.trim() ? SCRIPT_IND + l : l)).join('\n');
    const p = new Parser('object __tab {\n' + body + '\n}\n');
    p.expect('object');
    const b = p.begin({});
    p.object(b.node);
    const obj = p.finish(b);
    if (p.peek().kind !== 'eof') throw new AdvError(`unexpected ${show(p.peek())}`, p.peek().line);
    walk({ items: [obj] }, x => { if (x.line) x.line -= 1; });
    return obj.handlers ?? [];
  } catch (e) {
    throw unwrapLine(e);
  }
}

// validate a single expression, returns an error message or null
export function checkExpr(text) {
  try {
    const p = new Parser(text);
    p.orExpr();
    if (p.peek().kind !== 'eof') return `unexpected ${show(p.peek())}`;
    return null;
  } catch (e) {
    return e.plain || e.message;
  }
}

export function exprNames(text) {
  try {
    const toks = tokenize(text);
    return toks.filter((t, k) => t.kind === 'ident' && toks[k - 1]?.raw !== '.').map(t => t.value);
  } catch {
    return [];
  }
}

// the names the code entry is compared with: entry == NAME, entry != NAME (not the strings)
export function entryNames(text) {
  try {
    const toks = tokenize(text);
    return toks.filter((t, k) => t.kind === 'ident' && t.value === 'entry' && toks[k - 1]?.raw !== '.' &&
        toks[k + 1]?.kind === 'op' && ['==', '!='].includes(toks[k + 1].value) && toks[k + 2] && !['str', 'eof'].includes(toks[k + 2].kind))
      .map(t => toks[toks.indexOf(t) + 2].raw);
  } catch {
    return [];
  }
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
