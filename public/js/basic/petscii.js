// PETSCII control-code names, compatible with VICE petcat ({clr}, {home}, {rvs on}, {$xx}, {shift-a}, ...).
// The lookup tables mirror petcat.c (ctrl1/a_ctrl1/.../cbmkeys) and are searched in petcat's order,
// case-insensitively (like `petcat -ic`).

const E = '';

// 0x00-0x1f (petcat)
const ctrl1 = [
  E, 'ctrl-a', 'ctrl-b', 'stop', 'ctrl-d', 'wht', 'ctrl-f', 'ctrl-g',
  'dish', 'ensh', E, 'ctrl-k', 'ctrl-l', E, 'swlc', 'ctrl-o',
  'ctrl-p', 'down', 'rvon', 'home', 'del', 'ctrl-u', 'ctrl-v', 'ctrl-w',
  'ctrl-x', 'ctrl-y', 'ctrl-z', 'esc', 'red', 'rght', 'grn', 'blu',
];
// 0x00-0x1f (MikroBITTI)
const a_ctrl1 = [
  E, E, E, E, E, 'wht', E, E,
  'up/lo lock on', 'up/lo lock off', E, E, E, 'return', 'lower case', E,
  E, 'down', 'rvs on', 'home', 'delete', E, E, E,
  E, E, E, 'esc', 'red', 'right', 'grn', 'blu',
];
// 0x00-0x1f
const b_ctrl1 = [
  E, E, E, E, E, E, E, E, E, E, E, E, E, E, E, E,
  E, E, 'reverse on', E, E, E, E, E, E, E, E, E, E, E, E, E,
];
// 0x00-0x1f (tok64)
const c_ctrl1 = [
  E, E, E, E, E, 'white', E, E, E, E, E, E, E, E, E, E,
  E, 'down', 'reverse on', 'home', E, E, E, E, E, E, E, E, 'red', 'right', 'green', 'blue',
];
// 0x00-0x1f (64'er / checksummer v3)
const d_ctrl1 = [
  E, E, E, E, E, 'white', E, E, E, E, E, E, E, 'return', E, E,
  E, 'down', 'rvson', 'home', 'del', E, E, E, E, E, E, E, 'red', 'right', 'green', 'blue',
];
// 0x00-0x1f BASIC 3.5
const e_ctrl1 = ctrl1.slice();
e_ctrl1[0x1f] = 'dblu';

// 0x20-0x5f (petcat, tok64)
const cbmchars = [
  'space', E, E, E, E, E, E, E, E, E, '*', '+', E, '-', E, '/',
  E, E, E, E, E, E, E, E, E, E, E, E, '<', '=', '>', E,
  E, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o',
  'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', E, E, E, '^', E,
];

// 0x80-0x9f (petcat)
const ctrl2 = [
  E, 'orng', E, E, E, 'f1', 'f3', 'f5', 'f7', 'f2', 'f4', 'f6', 'f8', 'sret', 'swuc', E,
  'blk', 'up', 'rvof', 'clr', 'inst', 'brn', 'lred', 'gry1', 'gry2', 'lgrn', 'lblu', 'gry3', 'pur', 'left', 'yel', 'cyn',
];
// 0x80-0x9f (MikroBITTI)
const a_ctrl2 = [
  E, 'orange', E, E, E, 'f1', 'f3', 'f5', 'f7', 'f2', 'f4', 'f6', 'f8', 'shift return', 'upper case', E,
  'blk', 'up', 'rvs off', 'clr', 'insert', 'brown', 'lt.red', 'grey1', 'grey2', 'lt green', 'lt.blue', 'grey3', 'pur', 'left', 'yel', 'cyn',
];
// 0x80-0x9f (tok64)
const b_ctrl2 = [
  E, 'orange', E, E, E, 'f1', 'f3', 'r5', 'f7', 'f2', 'f4', 'f6', 'f8', E, E, E,
  'black', 'up', 'reverse off', 'clear', E, 'brown', 'pink', 'dark gray', 'gray', 'light green', 'light blue', 'light gray', 'purple', 'left', 'yellow', 'cyan',
];
// 0x80-0x9f (64'er / checksummer v3)
const c_ctrl2 = [
  E, 'orange', E, E, E, 'f1', 'f3', 'f5', 'f7', 'f2', 'f4', 'f6', 'f8', E, E, E,
  'black', 'up', 'rvsoff', 'clr', 'inst', 'brown', 'lig.red', 'grey 1', 'grey 2', 'lig.green', 'lig.blue', 'grey 3', 'purple', 'left', 'yellow', 'cyan',
];
// 0x80-0x9f BASIC 3.5
const d_ctrl2 = [
  E, 'orng', 'flon', E, 'flof', 'f1', 'f3', 'f5', 'f7', 'f2', 'f4', 'f6', 'help', 'sret', 'swuc', E,
  'blk', 'up', 'rvof', 'clr', 'inst', 'brn', 'lred', 'pink', 'blgn', 'lblu', 'blu', 'lgrn', 'pur', 'left', 'yel', 'cyn',
];

// 0xa0-0xdf keyboard names
const cbmkeys = [
  'shift-space', 'cbm-k', 'cbm-i', 'cbm-t', 'cbm-@', 'cbm-g', 'cbm-+', 'cbm-m',
  'cbm-pound', 'shift-pound', 'cbm-n', 'cbm-q', 'cbm-d', 'cbm-z', 'cbm-s', 'cbm-p',
  'cbm-a', 'cbm-e', 'cbm-r', 'cbm-w', 'cbm-h', 'cbm-j', 'cbm-l', 'cbm-y',
  'cbm-u', 'cbm-o', 'shift-@', 'cbm-f', 'cbm-c', 'cbm-x', 'cbm-v', 'cbm-b',
  'shift-*', 'shift-a', 'shift-b', 'shift-c', 'shift-d', 'shift-e', 'shift-f', 'shift-g',
  'shift-h', 'shift-i', 'shift-j', 'shift-k', 'shift-l', 'shift-m', 'shift-n', 'shift-o',
  'shift-p', 'shift-q', 'shift-r', 'shift-s', 'shift-t', 'shift-u', 'shift-v', 'shift-w',
  'shift-x', 'shift-y', 'shift-z', 'shift-+', 'cbm--', 'shift--', 'shift-^', 'cbm-*',
];
const a_cbmkeys = new Array(0x40).fill(E);
a_cbmkeys[0x3e] = 'cbm-^';

const hex2 = (n) => n.toString(16).padStart(2, '0');
const hexcodes = Array.from({ length: 0x100 }, (_, i) => '$' + hex2(i));

// Search order exactly as petcat's tokenizer: [table, base, onlyFor35]
const SEARCH = [
  [hexcodes, 0, false],
  [e_ctrl1, 0, true], [ctrl1, 0, false], [a_ctrl1, 0, false], [b_ctrl1, 0, false], [c_ctrl1, 0, false], [d_ctrl1, 0, false],
  [cbmchars, 0x20, false],
  [d_ctrl2, 0x80, true], [ctrl2, 0x80, false], [a_ctrl2, 0x80, false], [b_ctrl2, 0x80, false], [c_ctrl2, 0x80, false],
  [cbmkeys, 0xa0, false], [a_cbmkeys, 0xa0, false],
];

/**
 * Look up a control-code name (without braces, case-insensitive) -> PETSCII byte, or -1.
 * Accepts every name petcat accepts, plus "$xx" hex codes.
 */
export function lookupControlCode(name, dialect = 'v2') {
  const n = String(name).toLowerCase();
  if (!n) return -1;
  const is35 = dialect === 'v35';
  for (const [table, base, only35] of SEARCH) {
    if (only35 && !is35) continue;
    const i = table.indexOf(n);
    if (i >= 0) return base + i;
  }
  return -1;
}

/** Preferred name (petcat listing style, lowercase) for a PETSCII byte, or null if it is written as {$xx}. */
export function controlCodeName(code, dialect = 'v2') {
  let name = null;
  if (code < 0x20) name = (dialect === 'v35' ? e_ctrl1 : ctrl1)[code];
  else if (code >= 0x80 && code < 0xa0) name = (dialect === 'v35' ? d_ctrl2 : ctrl2)[code & 0x1f];
  else if (code >= 0xa1 && code <= 0xdf) name = cbmkeys[code - 0xa0];
  if (!name) return null;
  // guard against petcat table ambiguities (e.g. {blu} in 3.5 mode): only return names that map back
  return lookupControlCode(name, dialect) === code ? name : null;
}

const DESC = {
  stop: 'RUN/STOP', wht: 'white', dish: 'disable SHIFT+C= charset switching', ensh: 'enable SHIFT+C= charset switching',
  down: 'cursor down', rvon: 'reverse on', home: 'cursor home', del: 'delete', esc: 'ESC (C128/Plus4)',
  red: 'red', rght: 'cursor right', grn: 'green', blu: 'blue', dblu: 'dark blue (BASIC 3.5)',
  swlc: 'switch to lowercase charset', orng: 'orange',
  f1: 'F1 key', f2: 'F2 key', f3: 'F3 key', f4: 'F4 key', f5: 'F5 key', f6: 'F6 key', f7: 'F7 key', f8: 'F8 key',
  help: 'HELP key (BASIC 3.5)', flon: 'flash on (BASIC 3.5)', flof: 'flash off (BASIC 3.5)',
  sret: 'shifted RETURN', swuc: 'switch to uppercase charset', blk: 'black', up: 'cursor up', rvof: 'reverse off',
  clr: 'clear screen', inst: 'insert', brn: 'brown', lred: 'light red', gry1: 'dark grey', gry2: 'medium grey',
  lgrn: 'light green', lblu: 'light blue', gry3: 'light grey', pur: 'purple', left: 'cursor left', yel: 'yellow', cyn: 'cyan',
  pink: 'pink (BASIC 3.5)', blgn: 'blue-green (BASIC 3.5)',
  'rvs on': 'reverse on', 'rvs off': 'reverse off', space: 'space', 'shift-space': 'shifted space',
};

function describe(name) {
  if (DESC[name]) return DESC[name];
  if (name.startsWith('ctrl-')) return 'CTRL+' + name.slice(5).toUpperCase();
  if (name.startsWith('cbm-')) return 'C= + ' + name.slice(4).toUpperCase() + ' graphic character';
  if (name.startsWith('shift-')) return 'SHIFT + ' + name.slice(6).toUpperCase() + ' graphic character';
  return '';
}

function buildList() {
  const out = [];
  const seen = new Set();
  const add = (name, code, dialect) => {
    const key = name + '|' + (dialect || '');
    if (!name || seen.has(key)) return;
    seen.add(key);
    const e = { name, code, desc: describe(name) };
    if (dialect) e.dialect = dialect;
    out.push(e);
  };
  ctrl1.forEach((n, i) => add(n, i));
  ctrl2.forEach((n, i) => add(n, 0x80 + i));
  add('rvs on', 0x12);
  add('rvs off', 0x92);
  add('space', 0x20);
  e_ctrl1.forEach((n, i) => { if (n !== ctrl1[i]) add(n, i, 'v35'); });
  d_ctrl2.forEach((n, i) => {
    if (n !== ctrl2[i] && controlCodeName(0x80 + i, 'v35') === n) add(n, 0x80 + i, 'v35');
  });
  cbmkeys.forEach((n, i) => add(n, 0xa0 + i));
  return out;
}

/**
 * Control-code names for completion: [{ name, code, desc, dialect? }].
 * `dialect: 'v35'` marks names only valid in BASIC 3.5 mode. Any byte can also be written as {$xx} or {nnn},
 * and a repeat count is allowed: {3 down}, {down*3}.
 */
export const CONTROL_CODES = buildList();

/** Control codes valid for a dialect (names that map to the listed code in that dialect). */
export function controlCodesFor(dialect = 'v2') {
  return CONTROL_CODES.filter((c) => (!c.dialect || c.dialect === dialect) && lookupControlCode(c.name, dialect) === c.code);
}
