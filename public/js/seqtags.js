// seqtags.js - the tags of the text sequences of a prolog and an epilog (advc/adv/sequence.go has
// the same): a letter writer types its text, a vertical scroller moves it up line by line. A tag
// is {name args} in the text, from where it stands on.
import { COLOR_NAMES } from './adv.js';

// kinds of texts: the sequences of a prolog or an epilog, and the scroll text of the intro (its
// own tags, engine/intro.s - 'intro' is no kind of sequence)
// the icons of the shows: the prolog, an epilog, the outro
export const SHOW_ICONS = { prolog: 'slideshow', epilog: 'flag', outro: 'outro' };

export const SEQ_KINDS = {
  writer: { label: '§1525', icon: 'edit_note' },
  scroller: { label: '§1526', icon: 'vertical_align_top' },
};

// kinds: w writer, s scroller; args: c color, n number (min..max), t time in seconds, nn column, row,
// s the name of a sound of the game ('sound NAME "FILE"' at the top level).
// pair: the tag that closes it. sample: what a new one is
export const SEQ_TAGS = {
  color:    { kinds: 'wsi', args: 'c', label: '§1527', icon: 'format_color_text', sample: 'color white' },
  border:   { kinds: 'ws', args: 'c', label: '§1528', icon: 'border_outer', sample: 'border black' },
  bg:       { kinds: 'ws', args: 'c', label: '§1529', icon: 'format_color_fill', sample: 'bg black' },
  speed:    { kinds: 'ws', args: 'n', min: 0, max: 9, label: '§1530', icon: 'speed', sample: 'speed 2' },
  key:      { kinds: 'ws', args: '', label: '§1531', icon: 'keyboard', sample: 'key' },
  blink:    { kinds: 'ws', args: '', pair: '/blink', label: '§1532', icon: 'flare', sample: 'blink' },
  '/blink': { kinds: 'ws', args: '', label: '§1533', icon: 'flare', sample: '/blink' },
  at:       { kinds: 'w', args: 'nn', min: 0, max: 39, label: '§1534', icon: 'my_location', sample: 'at 0,0' },
  cls:      { kinds: 'w', args: '', label: '§1535', icon: 'clear_all', sample: 'cls' },
  del:      { kinds: 'w', args: 'n', min: 1, max: 255, label: '§1537', icon: 'backspace', sample: 'del 1' },
  ins:      { kinds: 'w', args: '', pair: '/ins', label: '§1538', icon: 'keyboard_tab', sample: 'ins' },
  '/ins':   { kinds: 'w', args: '', label: '§1539', icon: 'keyboard_tab', sample: '/ins' },
  center:   { kinds: 's', args: '', label: '§1540', icon: 'format_align_center', sample: 'center' },
  left:     { kinds: 's', args: '', label: '§1541', icon: 'format_align_left', sample: 'left' },
  right:    { kinds: 's', args: '', label: '§1542', icon: 'format_align_right', sample: 'right' },
  gap:      { kinds: 's', args: 'n', min: 1, max: 25, label: '§1543', icon: 'expand', sample: 'gap 1' },
  // a pause: the writer waits, the scroller stops with the line in the middle (seqCommand in seqdata.go)
  hold:     { kinds: 'ws', args: 't', label: '§1544', icon: 'pause_circle', sample: 'hold 2' },
  sound:    { kinds: 'ws', args: 's', label: '§1565', icon: 'volume_up', sample: 'sound NAME' },
  // the intro: p a pause of 0.5-3 seconds (in halves), when the letter after the tag has reached the left side
  fade:     { kinds: 'wsi', args: 'f', pair: '/fade', label: '§1573', icon: 'dark_mode', sample: 'fade grey' },
  '/fade':  { kinds: 'wsi', args: '', label: '§1574', icon: 'dark_mode', sample: '/fade' },
  pause:    { kinds: 'i', args: 'p', label: '§1576', icon: 'pause_circle', sample: 'pause 1' },
};

// the sounds a sequence can play: the global 'sound NAME "FILE"' of the game
export const gameSounds = game => game.items.filter(x => x.kind === 'song' && x.songKind === 'sound').map(x => x.name);

// the fades of the scroll text of the intro, their colors (engine/intro.s fade_colors)
export const FADES = {
  grey: [1, 1, 15, 12, 11, 0, 0, 11, 12, 15], red: [10, 10, 8, 2, 9, 0, 0, 9, 2, 8], blue: [3, 3, 14, 14, 6, 0, 0, 6, 14, 14],
  green: [13, 13, 5, 5, 11, 0, 0, 11, 5, 5], gold: [1, 7, 7, 8, 9, 0, 0, 9, 8, 7], purple: [15, 15, 4, 4, 6, 0, 0, 6, 4, 4],
  rainbow: [2, 8, 7, 13, 5, 3, 14, 6, 4, 10],
};

// the tags of a kind of sequence, in the order of SEQ_TAGS, without the closing ones
export const tagsOf = kind => Object.entries(SEQ_TAGS).filter(([name, d]) => d.kinds.includes(kind[0]) && !name.startsWith('/')).map(([name]) => name);

// the chars a sequence shows (screen codes of the ROM sets), and line breaks
export const seqShows = c => c === '\n' || c === '\r' || (c >= ' ' && c <= ']') || (c >= 'a' && c <= 'z') || c === '^' || c === '_';

const colorOf = w => {
  const k = w.toLowerCase();
  const i = COLOR_NAMES.indexOf(k);
  if (i >= 0) return i;
  return /^\d+$/.test(w) && +w <= 15 ? +w : null;
};

function argsText(name, d) {
  switch (d.args) {
    case '': return 'nothing';
    case 'c': return `a color: {${name} yellow} or {${name} 7}`;
    case 't': return `a time in seconds: {${name} 2} or {${name} 0.5}`;
    case 'nn': return 'a column and a row: {at 4,10}';
    case 's': return `the name of a sound of the game: {${name} click}`;
    case 'p': return `a pause of 0.5 to 3 seconds: {${name} 1.5}`;
    case 'f': return `a fade: {${name} ${Object.keys(FADES).join('|')}}`;
  }
  return `a number, ${d.min} to ${d.max}`;
}

// one tag: its words (name and arguments) as { tag, args } or an error
export function parseTag(body, kind) {
  const words = body.split(/[\s,]+/).filter(Boolean);
  if (!words.length) return { error: 'an empty tag {}' };
  const name = words[0].toLowerCase();
  const d = SEQ_TAGS[name];
  if (!d) return { error: `unknown tag {${words[0]}}` };
  if (kind && !d.kinds.includes(kind[0])) return { error: `{${name}} is not a tag of a ${kind}` };
  if (words.length - 1 !== d.args.length) return { error: `{${name}} takes ${argsText(name, d)}` };
  const args = [];
  for (let a = 0; a < d.args.length; a++) {
    const w = words[a + 1];
    if (d.args[a] === 's') {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(w)) return { error: `{${name}}: '${w}' is no name of a sound` };
      args.push(w);
    } else if (d.args[a] === 'c') {
      const c = colorOf(w);
      if (c == null) return { error: `{${name}}: '${w}' is no color (0-15 or black, white, red, ...)` };
      args.push(c);
    } else if (d.args[a] === 'f') {
      const k = Object.keys(FADES).indexOf(w.toLowerCase());
      if (k < 0) return { error: `{${name}}: '${w}' is no fade (${Object.keys(FADES).join(', ')})` };
      args.push(k);
    } else if (d.args[a] === 'p') {
      const f = Number(w.toLowerCase().replace(/s$/, ''));
      if (!(f >= 0.5 && f <= 3 && Number.isInteger(f * 2))) return { error: `{${name}}: '${w}' is no pause of 0.5, 1, 1.5 ... 3 seconds` };
      args.push(f * 2);
    } else if (d.args[a] === 't') {
      const f = Number(w.toLowerCase().replace(/s$/, ''));
      if (!(f >= 0.1 && f <= 25.5)) return { error: `{${name}}: '${w}' is no time from 0.1 to 25.5 seconds` };
      args.push(Math.round(f * 10));
    } else {
      const hi = name === 'at' && a === 1 ? 24 : d.max;
      if (!/^\d+$/.test(w) || +w < d.min || +w > hi) return { error: `{${name}}: '${w}' is not a number from ${d.min} to ${hi}` };
      args.push(+w);
    }
  }
  return { tag: name, args, words: words.slice(1) };
}

// the text of a sequence as runs and tags: [{ text } | { tag, args, words, raw }], each with pos
// (from 1); error: the first problem, as the compiler says it; span: where it is, [first char, chars]
// counted in chars from 0 (null: the whole text)
export function parseSeq(kind, text) {
  const items = [];
  const open = new Map();
  let run = '', runAt = 1;
  const flush = () => { if (run) items.push({ text: run, pos: runAt }); run = ''; };
  const chars = [...text];
  const fail = (error, at, len) => ({ items, error, span: [at, len] });
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === '}') return fail(`a '}' without its '{' (at ${i + 1})`, i, 1);
    if (c !== '{') {
      if (!seqShows(c)) return fail(`'${c}' cannot be shown (at ${i + 1}): letters, digits, space and ! " # $ % & ' ( ) * + , - . / : ; < = > ? @ [ ] ^ _`, i, 1);
      if (!run) runAt = i + 1;
      run += c;
      continue;
    }
    let end = i + 1;
    while (end < chars.length && !'{}\n'.includes(chars[end])) end++;
    if (chars[end] !== '}') return fail(`the tag at ${i + 1} has no '}'`, i, end - i);
    flush();
    const body = chars.slice(i + 1, end).join('');
    const t = parseTag(body, kind);
    if (t.error) return fail(`${t.error} (at ${i + 1})`, i, end - i + 1);
    if (t.tag === 'blink' || t.tag === 'ins' || t.tag === 'fade') {
      if (open.has(t.tag)) return fail(`{${t.tag}} inside {${t.tag}} (at ${i + 1})`, i, end - i + 1);
      open.set(t.tag, [i + 1, end - i + 1]);
    } else if (t.tag === '/blink' || t.tag === '/ins' || t.tag === '/fade') {
      if (!open.has(t.tag.slice(1))) return fail(`{${t.tag}} without {${t.tag.slice(1)}} before it (at ${i + 1})`, i, end - i + 1);
      open.delete(t.tag.slice(1));
    }
    items.push({ ...t, raw: body, pos: i + 1 });
    i = end;
  }
  flush();
  for (const [name, [at, len]] of open) return fail(`{${name}} has no {/${name}} (at ${at})`, at - 1, len);
  if (!items.length) return { items, error: 'it has no text', span: null };
  return { items, error: null, span: null };
}

// [first char, chars] of the chars of text as a span of its string (a char beyond U+FFFF is two)
const stringSpan = (text, [at, len]) => {
  const chars = [...text];
  const start = chars.slice(0, at).join('').length;
  return [start, chars.slice(at, at + len).join('').length];
};

// the problem of a sequence (null: none): its text, an {at} outside the text area, a scroller
// line wider than the screen, a sound the game does not have (sounds: their names, null: not
// checked) - as sequence.go and seqdata.go check it
export function seqProblem(seq, sounds = null) {
  return seqIssue(seq, sounds)?.msg ?? null;
}

// the problem of a sequence and where it is in its text: { msg, span: [start, length] of the
// string, null: not one place of it }, null: none
export function seqIssue(seq, sounds = null) {
  const text = seq.text ?? '';
  const at = (msg, span) => ({ msg, span: span && stringSpan(text, span) });
  const { items, error, span } = parseSeq(seq.kind, text);
  if (error) return at(error, span);
  const [top, bottom] = seqRows(seq);
  const tagSpan = it => [it.pos - 1, it.raw.length + 2];
  let col = 0;
  for (const it of items) {
    if (it.tag === 'sound' && sounds && !sounds.includes(it.args[0])) return at(`the game has no sound ${it.args[0]} (sound ${it.args[0]} "FILE" at the top level of the script)`, tagSpan(it));
    if (it.tag === 'at' && (it.args[1] < top || it.args[1] > bottom)) return at(`{at ${it.args[0]},${it.args[1]}} is outside the text area, rows ${top} to ${bottom} (at ${it.pos})`, tagSpan(it));
    if (seq.kind !== 'scroller' || it.tag) continue;
    const chars = [...it.text];
    for (let k = 0; k < chars.length; k++) {
      if (chars[k] === '\n') { col = 0; continue; }
      if (++col === 41) {                       // the rest of the line is too much
        let len = 0;
        while (k + len < chars.length && chars[k + len] !== '\n') len++;
        return at(`a line of the scroller is longer than 40 chars (at ${it.pos})`, [it.pos - 1 + k, len]);
      }
    }
  }
  if (seq.screen && seq.picture) return at('a screen or a picture behind the text, not both');
  if (seq.picture && top === 0) return at('the picture needs rows above the text (rows FIRST LAST, FIRST from 1)');
  if (seq.typesound && seq.kind !== 'writer') return at('typesound is for a writer (it types its text)');
  if (seq.fadeout && seq.kind !== 'scroller') return at('fadeout is for a scroller (its lines leave at the top)');
  if (seq.fadeout && bottom - top < 8) return at(`fadeout needs an area of 9 rows at least, not ${bottom - top + 1}`);
  if (seq.typesound && sounds && !sounds.includes(seq.typesound)) return at(`the game has no sound ${seq.typesound}`);
  if (seq.kind === 'scroller' && bottom !== 24) return at(`its text area goes down to the last row (rows ${top} 24)`);
  return null;
}

// the problem of the scroll text of the intro (null: none): its tags, and its chars - @ to ? of
// the ROM font (letters shown in capitals); the older tags [ ] and @ among them (advc intro.go)
export function introProblem(text) {
  return introIssue(text)?.msg ?? null;
}

// the problem of the scroll text of the intro and where it is: { msg, span } as seqIssue
export function introIssue(text) {
  if (!text.trim()) return { msg: '§0476', span: null };
  const { items, error, span } = parseSeq('intro', text);
  if (error) return { msg: error, span: span && stringSpan(text, span) };
  for (const it of items) {
    const chars = it.tag ? [] : [...it.text];
    const k = chars.findIndex(c => !/[A-Za-z0-9 @[\]!"#$%&'()*+,\-./:;<=>?\n]/.test(c));
    if (k >= 0) return { msg: `'${chars[k]}' cannot be shown (at ${it.pos + k}): letters, digits, space and ! " # $ % & ' ( ) * + , - . / : ; < = > ?`,
      span: stringSpan(text, [it.pos - 1 + k, 1]) };
  }
  return null;
}

// the text area of a sequence: [first row, last row]
export const seqRows = seq => seq.rows ?? (seq.picture ? [18, 24] : [0, 24]);
