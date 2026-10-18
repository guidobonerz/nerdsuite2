// sound.js - the composer: a tracker for the three voices of the SID - or more, of an imported
// MIDI file: then the game plays up to three of them, chosen in the head of the pattern, and the
// editor plays all of them (a SID for every three) or only those.
//   left    the orders: the patterns in the order the song plays them
//   middle  the pattern of the selected order: a row is a step of the song, a column a voice,
//           a cell a note, the instrument that plays it and a command with its value
//   right   the song (tempo, rows), the instruments, the tables of the song (wave, pulse, filter,
//           speed: GoatTracker's, see song.js) and the selection
// Notes are typed like on a piano, by the place of the keys (so QWERTZ and QWERTY play the
// same): Z S X D C ... is the octave, Q 2 W 3 E ... the next one. The song plays on a model
// of the SID (sid.js) with the player of sidplayer.js, in an audio worklet. The song is a file
// of the project (.sng, see song.js); GoatTracker songs, SID tunes and MIDI files are imported
// (songimport.js). The view is a Preact view (pui.js): bar and body are functions of the state
// st, rendered again by update() after every change.

import { LAYOUT } from './layout.js';
import {
  h, mount, useRef, useLayoutEffect, icon, iconButton, button, field, select, segmented, slider, snackbar, promptDialog, confirmDialog,
  section as uiSection, sidePanel, openMenu, closeMenu, confirmRemove,
} from './pui.js';
import {
  VOICES, NOTE_OFF, NO_LOOP, NOTES, NOTE_NAMES, MAX_INSTRUMENTS, MAX_PATTERNS, MAX_ORDERS, ROW_CHOICES, PRESETS, WAVES, FILTERS, COMMANDS, CELL,
  TABLES, MAX_TABLE_ROWS, SYNC, RING,
  noteName, newSong, newPattern, newInstrument, cloneSong, cellOffset, setRows, encode, decode, transpose, pickVoices,
} from './song.js';
import { songKind, sidInfo, importGoat, importSid, midiInfo, importMidi } from './songimport.js';
import { addSongFile } from './songfiles.js';
import { listBinaries, readBinary, writeBinary, isOpen } from './project.js';
import { exportName } from './export.js';
import { tr } from './i18n.js';
import { keepUi, pick as pickUi, put as putUi } from './uistate.js';

const UNDO_LIMIT = 100;
const HEX = '0123456789ABCDEF';
// the semitone of a key, by its place on the keyboard
const NOTE_KEYS = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11, Comma: 12, KeyL: 13, Period: 14,
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18, KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23,
  KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27, KeyP: 28,
};
// the seconds of an attack per rate; decay and release take three times as long
const COLS = 4;                             // the columns of a cell: note, instrument, command, value
const COL_CLASS = ['.trk-note', '.trk-ins', '.trk-cmd', '.trk-val'];
const EMPTY = [0, 0, 0, 0];
const ATTACK_MS = [2, 8, 16, 24, 38, 56, 68, 80, 100, 250, 500, 800, 1000, 3000, 5000, 8000];
const ms = v => (v < 1000 ? `${v} ms` : tr('§0923', v / 1000));
// the tables of a song: their names and what their bytes do
const TABLE_LABELS = { wave: '§1310', pulse: '§1311', filter: '§1312', speed: '§1313' };
const TABLE_HINTS = { wave: '§1314', pulse: '§1315', filter: '§1316', speed: '§1317' };
// the wave table: the waveforms its popup offers (the gate bit is the note's), what a byte does
const WAVE_CHOICES = [0x11, 0x21, 0x41, 0x81, 0x31, 0x51, 0x61, 0x71, 0x13, 0x15, 0x17, 0x23, 0x43];
const WAVE_BITS = [[0x10, '§0027'], [0x20, '§0028'], [0x40, '§0029'], [0x80, '§0030'], [0x02, '§1336'], [0x04, '§1337'], [0x08, '§1338']];
const waveName = l => WAVE_BITS.filter(([b]) => l & b).map(([, t]) => tr(t)).join(' + ');
const isWait = l => l >= 1 && l <= 0x0f;
function waveLeftText(l) {
  if (!l) return tr('§1330');
  if (isWait(l)) return tr('§1331', l);
  if (l < 0xf0) return waveName(l);
  return l < 0xff ? tr('§1332') : tr('§1333');
}
function waveRightText(l, r) {
  if (l === 0xff) return r ? tr('§1326', HEX[r >> 4] + HEX[r & 15]) : tr('§1334');
  if (isWait(l) || (l >= 0xf0 && l < 0xff)) return '';
  if (r < 0x60) return r ? `+${r}` : tr('§1339');
  if (r < 0x80) return `-${0x80 - r}`;
  return r === 0x80 ? tr('§1335') : noteName(Math.min(r - 0x80, NOTES - 1) + 1);
}
// the other tables (song.js): pulse and filter rows set a width, a type or a cutoff, sweep so many
// frames by a signed speed or jump; a row of the speed table is a vibrato - the frames of its half
// wave and its depth - or, for the commands A-C, one 16 bit speed
const signedText = v => { const s = (v << 24) >> 24; return s > 0 ? `+${s}` : String(s); };
const FILTER_BITS = [[1, '§0032'], [2, '§1110'], [4, '§0033']];
const filterName = m => (m ? FILTER_BITS.filter(([b]) => m & b).map(([, t]) => tr(t)).join(' + ') : tr('§0031'));
const cutoffText = v => `${Math.round((30 + v * 8 * 5.8) / 10) * 10} Hz`;
const percent = (l, r) => Math.round((((l & 15) << 8) | r) / 40.95);
const isSet = l => l >= 0x80 && l < 0xff;
// what the two bytes of row [l, r] of table k do, by name
function rowText(k, l, r) {
  if (k === 'wave') return [waveLeftText(l), waveRightText(l, r)];
  if (k === 'speed') return [tr('§1327', l), tr('§1364', r)];
  if (l === 0xff) return [tr('§1333'), r ? tr('§1326', HEX[r >> 4] + HEX[r & 15]) : tr('§1334')];
  if (l && l < 0x80) return [tr('§1352', l), tr('§1353', signedText(r))];
  if (k === 'pulse') return l ? [tr('§1351'), `${percent(l, r)} %`] : [tr('§1350'), ''];
  return l ? [filterName((l >> 4) & 7), tr('§1355', r >> 4)] : [tr('§1354'), cutoffText(r)];
}
// the choices of the popups: frames of a sweep, its speeds, the speeds of slides
const FRAME_PICKS = [...Array.from({ length: 16 }, (_, k) => k + 1), 20, 24, 32, 40, 48, 64, 96, 127];
const SPEED_PICKS = [-128, -96, -64, -48, -32, -24, -16, -12, -8, -4, -2, -1, 1, 2, 4, 8, 12, 16, 24, 32, 48, 64, 96, 127];
const SLIDE_PICKS = [4, 8, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024, 2048];
const FILTER_TYPES = [0, 1, 2, 4, 3, 5, 6, 7];

// onRoute: called when the song open changes - the address follows it (app.js)
export function createSoundEditor(el, bar, { onRoute, onDirty } = {}) {
  const st = {
    file: null, files: [],
    suggest: null,                          // the path Save proposes: an imported song is a new file
    song: newSong(), dirty: false, undo: [], redo: [],
    order: 0, row: 0, voice: 0, col: 0,     // the cursor: the position in the orders, the cell, 0 note / 1 instrument / 2 command / 3 its value
    anchor: null,                           // the selection reaches from {row, voice} to the cursor
    ins: 1, octave: 3, step: 1,
    playing: null,                          // 'song', 'pattern'
    pos: null,                              // the row that plays: {order, row}
    muted: [],                              // per voice: not heard
    hearAll: true,                          // all voices of the song are heard, not only the game's
    clip: null,                             // copied cells: {rows, voices, data}
    table: 'wave',                          // the table shown in the side panel
  };
  const dom = { wrap: null, scroll: null };  // the pattern: what has the focus, what scrolls
  let views = null;                         // the mounted bar and body (pui.mount)
  const update = () => views?.forEach(v => v.update());
  let audio = null;                         // {ctx, post}: the worklet, made with the first sound
  let sliding = false;                      // a slider moves: one undo step
  const held = new Map();                   // the keys that hold a note: code -> voice

  const pattern = () => st.song.patterns[st.song.orders[st.order]];
  const voices = () => st.song.voices;
  const at = (row, voice) => cellOffset(row, voice, st.song.voices);
  // the game does not play every voice: the editor can play all or the game's
  const choosing = () => st.song.voices > VOICES || st.song.game.length < VOICES;
  const selection = () => (st.anchor ? {
    r0: Math.min(st.anchor.row, st.row), r1: Math.max(st.anchor.row, st.row),
    v0: Math.min(st.anchor.voice, st.voice), v1: Math.max(st.anchor.voice, st.voice),
  } : null);
  const hex2 = n => HEX[n >> 4] + HEX[n & 15];

  // --- the sound ---------------------------------------------------------------------------------

  async function startAudio() {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    let post;
    try {
      await ctx.audioWorklet.addModule(new URL('./sidworklet.js', import.meta.url));
      const node = new AudioWorkletNode(ctx, 'sid-engine', { numberOfInputs: 0, outputChannelCount: [1] });
      node.port.onmessage = e => onPos(e.data);
      node.connect(ctx.destination);
      post = m => node.port.postMessage(m);
    } catch {                                // no worklets with modules: the player in this thread
      const { SidEngine } = await import('./sidplayer.js');
      const engine = new SidEngine(ctx.sampleRate);
      engine.onpos = onPos;
      const node = ctx.createScriptProcessor(2048, 0, 1);
      node.onaudioprocess = e => engine.render(e.outputBuffer.getChannelData(0));
      node.connect(ctx.destination);
      post = m => engine.handle(m);
    }
    post({ type: 'song', bytes: encode(st.song), all: st.hearAll });
    st.muted.forEach((on, voice) => post({ type: 'mute', voice, on }));
    return { ctx, post };
  }

  // the messages of the engine, in their order, when the sound is ready
  function send(m) {
    audio ??= startAudio();
    audio = audio.then(a => { if (a.ctx.state === 'suspended') a.ctx.resume(); a.post(m); return a; });
    audio.catch(e => { audio = null; snackbar(tr('§0302', e.message), { error: true }); });
  }
  const syncSong = () => { if (audio) send({ type: 'song', bytes: encode(st.song), all: st.hearAll }); };

  function play(mode) {
    st.playing = mode;
    st.pos = null;
    send({ type: 'play', order: st.order, row: mode === 'pattern' ? 0 : st.row, loop: mode === 'pattern' });
    update();
  }

  function stop() {
    if (audio) send({ type: 'stop' });
    st.playing = null;
    st.pos = null;
    update();
  }

  function onPos(pos) {
    if (!st.playing || !views) return;
    st.pos = pos;
    if (st.playing === 'song' && pos.order !== st.order && pos.order < st.song.orders.length) {   // follow the song
      st.order = pos.order;
      update();
    }
    update();
  }

  // --- undo and files ------------------------------------------------------------------------------

  function snapshot() {
    st.undo.push(cloneSong(st.song));
    if (st.undo.length > UNDO_LIMIT) st.undo.shift();
    st.redo = [];
    setDirty(true);
  }

  function restore(from, to) {
    const s = from.pop();
    if (!s) return;
    to.push(cloneSong(st.song));
    st.song = s;
    setDirty(true);
    clampCursor();
    syncSong();
    render();
  }

  function clampCursor() {
    st.order = Math.min(st.order, st.song.orders.length - 1);
    st.row = Math.min(st.row, st.song.rows - 1);
    st.ins = Math.max(1, Math.min(st.ins, st.song.instruments.length));
    st.anchor = null;
  }

  function setSong(song, file, dirty = false) {
    stop();
    if (file) st.suggest = null;
    setDirty(dirty);
    Object.assign(st, { song, file, undo: [], redo: [], order: 0, row: 0, voice: 0, col: 0, anchor: null, ins: 1 });
    syncSong();
    render();
  }

  async function listFiles() {
    st.files = listBinaries().filter(f => /\.sng$/i.test(f));
  }

  const discard = () => !st.dirty || confirmDialog({ title: tr('§0204'), text: `${st.file ?? tr('§1850')} has unsaved changes.`, ok: '§0205', danger: true });

  async function openFile(path) {
    if (!(await discard())) return render();
    try {
      await loadBytes(readBinary(path), path, true);
    } catch (e) {
      snackbar(tr('§0626', path, e.message), { error: true });
      render();
    }
  }

  // a song of this editor, or one to import: a GoatTracker song, a SID tune, a MIDI file. The imported song
  // is a new, unsaved song - the file it comes from stays as it is
  async function loadBytes(bytes, name, inProject) {
    const kind = songKind(bytes);
    if (kind === 'song') { st.suggest = inProject ? null : `${LAYOUT.music}/${name.replace(/^.*[\/]/, '')}`; return setSong(decode(bytes), inProject ? name : null, !inProject); }
    if (!kind) throw new Error('not a song of this editor, a GoatTracker song, a SID tune or a MIDI file');
    let result;
    if (kind === 'goat') result = importGoat(bytes);
    else if (kind === 'midi') {
      const info = midiInfo(bytes);
      const v = await promptDialog({
        title: tr('§0303'), icon: 'upload_file', ok: 'Import',
        text: `${info.title || name}: ${info.parts.map(p => `${p.name} (${p.notes})`).join(', ')}, ${info.bpm} bpm.`,
        fields: [
          { name: 'voices', value: 'all', radios: [
            { value: 'all', label: '§0310' },
            { value: 'three', label: '§0311' }] },
          { name: 'rows', label: '§0304', value: '4', options: [{ value: '2', label: '§0305' }, { value: '4', label: '§0306' }, { value: '8', label: '§0307' }] },
          ...(info.parts.some(p => p.drums) ? [{ name: 'drums', value: 'yes', radios: [{ value: 'yes', label: '§0308' }, { value: 'no', label: '§0309' }] }] : []),
        ],
      });
      if (!v) return render();
      result = importMidi(bytes, { rowsPerQuarter: Number(v.rows), drums: v.drums !== 'no', all: v.voices === 'all' });
    } else {
      const info = sidInfo(bytes);
      const v = await promptDialog({
        title: tr('§0321'), icon: 'upload_file', ok: 'Import',
        text: tr('§1367', `${info.title || name}${info.author ? ` by ${info.author}` : ''}`),
        fields: [
          { name: 'subtune', label: `Subtune (1-${info.songs})`, value: String(info.start), validate: s => (/^\d+$/.test(s) && s >= 1 && s <= info.songs ? null : `1 to ${info.songs}`) },
          { name: 'seconds', label: '§0322', value: '90', validate: s => (/^\d+$/.test(s) && s >= 5 && s <= 600 ? null : '5 to 600') },
        ],
      });
      if (!v) return render();
      result = importSid(bytes, { subtune: Number(v.subtune), seconds: Number(v.seconds) });
    }
    const base = name.replace(/^.*[\/]/, '').replace(/\.\w+$/, '');
    st.suggest = `${inProject ? name.replace(/[^/]*$/, '') : `${LAYOUT.music}/`}${base}${kind === 'goat' ? '-import' : ''}.sng`;
    setSong(result.song, null, true);
    snackbar(tr('§0323', name, result.notes.join(' · ')), { timeout: 12000 });
  }

  // a file of the computer: the same songs as in the project
  // the Import button of the app bar (app.js, export.js): a song from this computer - a song of
  // this editor, a GoatTracker 2 song (.sng), a SID tune (.sid) or a MIDI file (.mid)
  const importSong = async (bytes, name) => { if (await discard()) await loadBytes(bytes, name, false); };
  const importFormats = () => (!isOpen() ? [] : [
    { label: '§0999', icon: 'music_note', accept: '.sng', open: importSong },
    { label: '§1000', icon: 'music_note', accept: '.sid', open: importSong },
    { label: '§1001', icon: 'music_note', accept: '.mid,.midi,.rmi', open: importSong },
  ]);

  // changed or not: the red dot of the Save in the app bar follows (app.js)
  function setDirty(on) {
    if (st.dirty === on) return;
    st.dirty = on;
    onDirty?.();
  }

  async function save(as = false, { quiet = false } = {}) {
    let path = st.file;
    if (!path || as) {
      const v = await promptDialog({
        title: tr('§0325'), icon: 'save', ok: 'Save', text: 'A song of the sound editor (.sng): the orders, instruments and patterns.',
        fields: [{ name: 'path', label: '§1263', value: path ?? st.suggest ?? `${LAYOUT.music}/song.sng`,      // a sound effect: audio/effects/ (layout.js) mono: true,
          validate: p => (!/^[\w\-./]+\.sng$/i.test(p) || p.includes('..') ? '§0326' : null) }],
      });
      if (!v) return;
      path = v.path;
    }
    const bin = encode(st.song);
    try {
      writeBinary(path, bin);
      st.file = path; setDirty(false);
      addSongFile(path);                         // the panels of the storyboard offer it
      if (!quiet) snackbar(tr('§0327', path, bin.length));
      await listFiles();
      update();
    } catch (e) {
      snackbar(tr('§0632', e.message, /path must be/.test(e.message) ? '§1854' : ''), { error: true, timeout: 8000 });
    }
  }

  async function newFile() {
    if (await discard()) { st.suggest = null; setSong(newSong(), null); }
  }

  // --- editing the pattern -------------------------------------------------------------------------

  // an edit of the pattern: fn changes it; the cells are drawn again
  function edit(fn) {
    snapshot();
    fn(pattern());
    syncSong();
    update();
  }

  function moveTo(row, voice = st.voice, col = st.col, { extend = false } = {}) {
    if (extend) st.anchor ??= { row: st.row, voice: st.voice };
    else st.anchor = null;
    const rows = st.song.rows;
    st.row = ((row % rows) + rows) % rows;
    st.voice = Math.max(0, Math.min(voices() - 1, voice));
    st.col = col;
    update();
  }

  // to the next column, over the voices
  function moveColumn(dir, extend) {
    if (extend) return moveTo(st.row, st.voice + dir, st.col, { extend });
    const k = Math.max(0, Math.min(voices() * COLS - 1, st.voice * COLS + st.col + dir));
    moveTo(st.row, Math.floor(k / COLS), k % COLS);
  }

  function jam(code, note) {
    if (held.has(code)) return;
    held.set(code, st.voice);
    send({ type: 'noteOn', voice: st.voice, note, ins: st.ins });
  }

  function release(code) {
    const voice = held.get(code);
    if (voice == null) return;
    held.delete(code);
    if (![...held.values()].includes(voice)) send({ type: 'noteOff', voice });
  }

  function enterNote(note) {
    const { row, voice } = st;
    edit(p => p.set([note, note === NOTE_OFF ? 0 : st.ins], at(row, voice)));
    moveTo(st.row + st.step);
  }

  // the popup of a cell (a double click, the right button, Enter): every note by octave, the
  // note off and the empty cell - or, in the instrument column, the instruments, in the columns
  // of the command the commands. A note sounds when it is chosen
  function cellPopup(anchor) {
    const o = at(st.row, st.voice), p = pattern();
    const pick = fn => () => { closeMenu(); dom.wrap?.focus({ preventScroll: true }); fn(); };
    if (st.col >= 2) {
      return openMenu(anchor, [{ header: tr('§0328', hex2(st.row), st.voice + 1) },
        { label: 'none', icon: 'remove', checked: !p[o + 2], onclick: () => enterCommand(0) },
        ...COMMANDS.map(c => ({ label: tr('§1084', HEX[c.value], c.label), icon: 'tune', tip: c.tip, checked: p[o + 2] === c.value, onclick: () => enterCommand(c.value) }))]);
    }
    if (st.col === 1) {
      return openMenu(anchor, [{ header: tr('§0329', hex2(st.row), st.voice + 1) },
        { label: '§0330', icon: 'remove', checked: !p[o + 1], onclick: () => enterInstrument(0) },
        ...st.song.instruments.map((x, k) => ({ label: tr('§1084', HEX[k + 1], x.name), icon: 'piano', checked: p[o + 1] === k + 1, onclick: () => enterInstrument(k + 1) }))]);
    }
    const preview = note => {
      const voice = st.voice;
      send({ type: 'noteOn', voice, note, ins: st.ins });
      setTimeout(() => send({ type: 'noteOff', voice }), 350);
    };
    const grid = h('div', { class: 'trk-notes' },
      h('span', {}), NOTE_NAMES.map(n => h('span', { class: `trk-notes__head ${n[1] === '#' ? 'trk-notes__sharp' : ''}` }, n.replace('-', ''))),
      Array.from({ length: 8 }, (_, octave) => [h('span', { class: 'trk-notes__head' }, String(octave)),
        NOTE_NAMES.map((n, k) => {
          const note = octave * 12 + k + 1;
          if (note > NOTES) return h('span', {});
          return h('button', { class: `trk-notes__key ${n[1] === '#' ? 'trk-notes__sharp' : ''} ${p[o] === note ? 'trk-notes__key--current' : ''}`, type: 'button',
            'data-tip': noteName(note), 'data-autofocus': p[o] === note ? '' : undefined, onclick: pick(() => { preview(note); enterNote(note); }) }, noteName(note));
        })]));
    openMenu(anchor, [{ header: tr('§0331', hex2(st.row), st.voice + 1, HEX[st.ins], st.song.instruments[st.ins - 1]?.name ?? '') }],
      h('div', {}, grid, h('div', { class: 'trk-notes__foot' },
        button('§1087', { variant: p[o] === NOTE_OFF ? 'tonal' : 'outlined', onclick: pick(() => enterNote(NOTE_OFF)) }),
        button('§1086', { variant: 'outlined', onclick: pick(() => { st.anchor = null; st.col = 0; clearCells(); }) }))));
  }

  function enterInstrument(n) {
    if (n > st.song.instruments.length) return snackbar(tr('§0332', HEX[n]), { error: true });
    const { row, voice } = st;
    edit(p => { p[at(row, voice) + 1] = n; });
    if (n) { st.ins = n; update(); }
    moveTo(st.row + st.step);
  }

  // the command of the cell; the cursor goes on to its value
  function enterCommand(n) {
    if (n && !COMMANDS.some(c => c.value === n)) return snackbar(tr('§0333', HEX[n]), { error: true });
    const { row, voice } = st;
    edit(p => { const o = at(row, voice); p[o + 2] = n; if (!n) p[o + 3] = 0; });
    if (n) moveTo(st.row, st.voice, 3); else moveTo(st.row + st.step);
  }

  // a digit of the value of the command: the digits move to the left
  function enterValue(digit) {
    const { row, voice } = st;
    edit(p => { const o = at(row, voice); p[o + 3] = ((p[o + 3] << 4) | digit) & 255; });
  }

  // a selection: its cells. Without one the part of the cell the cursor is in: the note with its
  // instrument, the instrument, the command with its value
  function clearCells() {
    const s = selection() ?? { r0: st.row, r1: st.row, v0: st.voice, v1: st.voice };
    const part = st.anchor ? [0, 1, 2, 3] : [[0, 1], [1], [2, 3], [2, 3]][st.col];
    edit(p => {
      for (let r = s.r0; r <= s.r1; r++) {
        for (let v = s.v0; v <= s.v1; v++) for (const k of part) p[at(r, v) + k] = 0;
      }
    });
  }

  // the cells of the voice from the cursor on move a row down (dir 1) or up (-1)
  function shiftTrack(dir) {
    const { row, voice } = st, rows = st.song.rows;
    edit(p => {
      const cells = [];
      for (let r = row; r < rows; r++) cells.push([...p.subarray(at(r, voice), at(r, voice) + CELL)]);
      if (dir > 0) { cells.unshift(EMPTY); cells.pop(); } else { cells.shift(); cells.push(EMPTY); }
      cells.forEach((c, k) => p.set(c, at(row + k, voice)));
    });
  }

  // the selected cells; without a selection the cell at the cursor (a note with its instrument and
  // command). Ctrl+A selects the track, again the pattern. The clip stays while the song changes
  function copy(cut = false) {
    const s = selection() ?? { r0: st.row, r1: st.row, v0: st.voice, v1: st.voice };
    const rows = s.r1 - s.r0 + 1, voices = s.v1 - s.v0 + 1, data = [], p = pattern();
    for (let r = s.r0; r <= s.r1; r++) for (let v = s.v0; v <= s.v1; v++) data.push(...p.subarray(at(r, v), at(r, v) + CELL));
    st.clip = { rows, voices, data };
    if (cut) {
      edit(q => { for (let r = s.r0; r <= s.r1; r++) for (let v = s.v0; v <= s.v1; v++) q.set(EMPTY, at(r, v)); });
    }
    snackbar(st.anchor ? tr('§1068', cut ? '§1851' : '§1852', rows, rows > 1 ? 's' : '', voices > 1 ? tr('§1853', voices) : tr('§1089', s.v0 + 1))
      : tr(cut ? '§1718' : '§1717', noteName(p[at(s.r0, s.v0)]), s.r0));
  }

  // at the cursor; a copied track goes to the top of the voice
  function paste() {
    const c = st.clip;
    if (!c) return;
    const row = c.rows >= st.song.rows ? 0 : st.row, voice = st.voice;
    edit(p => {
      for (let r = 0; r < c.rows && row + r < st.song.rows; r++) {
        for (let v = 0; v < c.voices && voice + v < voices(); v++) p.set(c.data.slice((r * c.voices + v) * CELL, (r * c.voices + v + 1) * CELL), at(row + r, voice + v));
      }
    });
  }

  // the note at the cursor a semitone up or down (Alt + up / down); a note off and an empty cell stay
  function noteBy(d) {
    const { row, voice } = st;
    const n = pattern()[at(row, voice)];
    if (n < 1 || n > NOTES || n + d < 1 || n + d > NOTES) return;
    edit(p => { p[at(row, voice)] = n + d; });
  }

  function transposeBy(semitones) {
    const s = selection() ?? { r0: 0, r1: st.song.rows - 1, v0: st.voice, v1: st.voice };
    edit(p => transpose(p, s.r0, s.r1, s.v0, s.v1, semitones, voices()));
  }

  function selectAll() {
    // the track, then the pattern
    const track = st.anchor && st.anchor.row === 0 && st.row === st.song.rows - 1 && st.anchor.voice === st.voice;
    st.anchor = { row: 0, voice: track ? 0 : st.voice };
    st.row = st.song.rows - 1;
    if (track) st.voice = voices() - 1;
    update();
  }

  function setMuted(voice, on) {
    st.muted[voice] = on;
    if (audio) send({ type: 'mute', voice, on });
    update();
  }

  // every voice muted or heard: while one is heard they are all muted, else all heard again
  const allMuted = () => Array.from({ length: voices() }, (_, v) => !!st.muted[v]).every(Boolean);
  function toggleAllMuted() {
    const on = !allMuted();
    for (let v = 0; v < voices(); v++) if (!!st.muted[v] !== on) { st.muted[v] = on; if (audio) send({ type: 'mute', voice: v, on }); }
    update();
  }

  // the voices the game plays: up to three
  function toggleGame(voice) {
    const s = st.song, on = s.game.includes(voice);
    if (!on && s.game.length >= VOICES) return snackbar('§0317', { error: true });
    songEdit(() => { s.game = on ? s.game.filter(v => v !== voice) : [...s.game, voice].sort((a, b) => a - b); });
  }

  function hear(all) {
    st.hearAll = all;
    syncSong();
    update();
  }

  // the song becomes the three voices of the SID the game plays
  async function keepGameVoices() {
    const s = st.song;
    const gone = Array.from({ length: s.voices }, (_, v) => v).filter(v => !s.game.includes(v)).map(v => v + 1);
    if (!(await confirmRemove({ what: tr('§1492', gone.join(', ')), detail: tr('§1493', s.game.map(v => v + 1).join(', ')), kind: 'song-voices', verb: 'remove' }))) return;
    if (st.song !== s) return;
    songEdit(() => { st.song = pickVoices(s, s.game); });
    st.muted.forEach((on, voice) => { if (on && audio) send({ type: 'mute', voice, on: false }); });
    st.muted = [];
    snackbar(tr('§0319', s.game.map(v => v + 1).join(', ') || 'none'));
  }

  // --- the orders ------------------------------------------------------------------------------------

  function songEdit(fn) {
    snapshot();
    fn(st.song);
    st.voice = Math.min(st.voice, voices() - 1);
    clampCursor();
    syncSong();
    render();
  }

  // a position after the selected one: 'same' pattern, a 'new' one or a 'copy' of it
  function addOrder(kind) {
    const s = st.song;
    if (s.orders.length >= MAX_ORDERS) return snackbar(tr('§0334', MAX_ORDERS), { error: true });
    if (kind !== 'same' && s.patterns.length >= MAX_PATTERNS) return snackbar(tr('§0335', MAX_PATTERNS), { error: true });
    songEdit(() => {
      let p = s.orders[st.order];
      if (kind !== 'same') { s.patterns.push(kind === 'copy' ? pattern().slice() : newPattern(s.rows, s.voices)); p = s.patterns.length - 1; }
      s.orders.splice(st.order + 1, 0, p);
      if (s.loop !== NO_LOOP && s.loop > st.order) s.loop++;
      st.order++;
    });
  }

  async function removeOrder() {
    const s = st.song, at = st.order;
    if (s.orders.length < 2) return;
    if (!(await confirmRemove({ what: tr('§1477', hex2(at)), detail: '§1478', kind: 'song-order', verb: 'remove' }))) return;
    if (st.song !== s || st.order !== at) return;
    songEdit(() => {
      s.orders.splice(st.order, 1);
      if (s.loop !== NO_LOOP && (s.loop > st.order || s.loop >= s.orders.length)) s.loop = Math.max(0, s.loop - 1);
    });
  }

  // the pattern of the selected position; one past the last pattern makes a new one
  function stepPattern(dir) {
    const s = st.song, p = s.orders[st.order] + dir;
    if (p < 0) return;
    if (p >= s.patterns.length && s.patterns.length >= MAX_PATTERNS) return snackbar(tr('§0335', MAX_PATTERNS), { error: true });
    songEdit(() => {
      if (p >= s.patterns.length) s.patterns.push(newPattern(s.rows, s.voices));
      s.orders[st.order] = p;
    });
  }

  // --- the instruments ---------------------------------------------------------------------------------

  // preset: a ready instrument of PRESETS, else a copy of the selected one
  function addInstrument(preset) {
    const s = st.song;
    if (s.instruments.length >= MAX_INSTRUMENTS) return snackbar(tr('§0336', MAX_INSTRUMENTS), { error: true });
    songEdit(() => { s.instruments.push(preset ? { ...preset } : { ...newInstrument(), ...s.instruments[st.ins - 1], name: `instrument ${s.instruments.length + 1}` }); });
    st.ins = s.instruments.length;
    update();
  }

  function addMenu(anchor) {
    const full = st.song.instruments.length >= MAX_INSTRUMENTS;
    openMenu(anchor, [
      { label: '§0356', icon: 'content_copy', disabled: full, onclick: () => addInstrument() },
      ...PRESETS.flatMap(g => [{ divider: true }, { header: g.group },
        ...g.instruments.map(x => ({ label: x.name, icon: 'piano', disabled: full, tip: WAVES.find(w => w.value === (x.wave & 0xf0))?.label, onclick: () => addInstrument(x) }))]),
    ]);
  }

  // the cells that play it lose their instrument, the instruments after it move up
  async function removeInstrument() {
    const s = st.song, n = st.ins;
    if (s.instruments.length < 2) return;
    let notes = 0;
    for (const p of s.patterns) for (let o = 1; o < p.length; o += CELL) if (p[o] === n) notes++;
    if (!(await confirmRemove({ what: tr('§1479', HEX[n], s.instruments[n - 1]?.name ?? ''), detail: notes ? tr('§1480', notes) : null, kind: 'song-instrument' }))) return;
    if (st.song !== s || st.ins !== n) return;
    songEdit(() => {
      s.instruments.splice(n - 1, 1);
      for (const p of s.patterns) for (let o = 1; o < p.length; o += CELL) p[o] = p[o] === n ? 0 : p[o] > n ? p[o] - 1 : p[o];
    });
  }

  // a value of the selected instrument, from a slider: the drag is one undo step
  function setIns(key, value, done) {
    if (!sliding) snapshot();
    sliding = !done;
    st.song.instruments[st.ins - 1][key] = value;
    syncSong();
    if (done) update();
  }

  // --- keys ------------------------------------------------------------------------------------------

  function onKey(e) {
    if (el.hidden || !dom.wrap || !isOpen() || document.querySelector('.md-dialog-scrim, .md-menu')) return;
    const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
    if (typing && !(typing.type === 'range' && NOTE_KEYS[e.code] != null && !e.ctrlKey && !e.metaKey)) {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 's') handled(e, () => save(true));
      return;
    }
    const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase(), extend = e.shiftKey;
    if (mod) {
      // Ctrl+S is the save of the whole project (app.js); Shift+Ctrl+S saves the song as
      const f = { s: e.shiftKey ? () => save(true) : null, z: () => (e.shiftKey ? restore(st.redo, st.undo) : restore(st.undo, st.redo)), y: () => restore(st.redo, st.undo),
        c: () => copy(), x: () => copy(true), v: paste, a: selectAll }[key];
      if (f) handled(e, f);
      return;
    }
    if (e.altKey) {                                     // Alt + up / down: the note at the cursor a semitone up or down (a selection: all of it)
      const d = { ArrowUp: 1, ArrowDown: -1 }[e.key];
      if (d) handled(e, () => (st.anchor ? transposeBy(d) : noteBy(d)));
      return;
    }
    const page = Math.min(16, st.song.rows >> 1);
    const nav = {
      ArrowUp: () => moveTo(st.row - 1, st.voice, st.col, { extend }), ArrowDown: () => moveTo(st.row + 1, st.voice, st.col, { extend }),
      ArrowLeft: () => moveColumn(-1, extend), ArrowRight: () => moveColumn(1, extend),
      PageUp: () => moveTo(Math.max(0, st.row - page), st.voice, st.col, { extend }), PageDown: () => moveTo(Math.min(st.song.rows - 1, st.row + page), st.voice, st.col, { extend }),
      Home: () => moveTo(0, st.voice, st.col, { extend }), End: () => moveTo(st.song.rows - 1, st.voice, st.col, { extend }),
      Tab: () => moveTo(st.row, (st.voice + (e.shiftKey ? voices() - 1 : 1)) % voices(), 0),
      ' ': () => (st.playing ? stop() : play(e.shiftKey ? 'pattern' : 'song')),
      Escape: () => { st.anchor = null; update(); },
      Enter: () => cellPopup(dom.scroll.children[st.row].querySelectorAll(COL_CLASS[st.col])[st.voice]),
      Delete: () => { if (e.shiftKey) shiftTrack(-1); else { clearCells(); if (!st.anchor) moveTo(st.row + st.step); } },
      Backspace: () => { st.anchor = null; clearCells(); moveTo(st.row - 1); },
      Insert: () => shiftTrack(1),
      '+': () => setOctave(st.octave + 1), '-': () => setOctave(st.octave - 1),
    }[e.key];
    if (nav && (e.key !== 'Tab' || dom.wrap.contains(document.activeElement))) return handled(e, nav);
    if (st.col >= 1 && !typing) {
      const n = HEX.indexOf(e.key.toUpperCase());
      if (n >= 0 && e.key.length === 1) handled(e, () => [enterInstrument, enterCommand, enterValue][st.col - 1](n));
      return;
    }
    if (e.code === 'Digit1' && !typing) return handled(e, () => { if (!e.repeat) enterNote(NOTE_OFF); });
    const semitone = NOTE_KEYS[e.code];
    if (semitone == null) return;
    handled(e, () => {
      const note = st.octave * 12 + semitone + 1;
      if (e.repeat || note > NOTES) return;
      jam(e.code, note);
      if (!typing) enterNote(note);                       // on a slider the keys only play: the sound of the instrument
    });
  }

  // the key is the editor's: not the browser's, not the application's
  function handled(e, fn) {
    e.preventDefault();
    e.stopPropagation();
    fn();
  }

  function setOctave(o) {
    st.octave = Math.max(0, Math.min(7, o));
    update();
  }

  // --- the views --------------------------------------------------------------------------------------

  function statusText() {
    const s = selection(), i = st.song.instruments[st.ins - 1];
    return [
      `${st.file ?? '§1088'}${st.dirty ? ' · changed' : ''}`,
      tr('§0337', hex2(st.order), st.song.orders.length, hex2(st.song.orders[st.order]), hex2(st.row), st.voice + 1),
      tr('§0338', st.octave, HEX[st.ins], i?.name ?? ''),
      s ? tr('§1090', s.r1 - s.r0 + 1) : '',
      tr('§1077', encode(st.song).length),
    ].filter(Boolean).join(' · ');
  }

  // the pattern: the head with the voices, the rows. The cursor stays in view, the row that plays
  // in the middle
  function Pattern() {
    const last = useRef({});
    const p = pattern(), sel = selection();
    const playRow = st.pos && st.pos.order === st.order ? st.pos.row : -1;
    useLayoutEffect(() => {
      const was = last.current;
      if (playRow >= 0 && playRow !== was.playRow) {
        const r = dom.scroll.children[playRow];
        if (r) dom.scroller.scrollTop = r.offsetTop - dom.scroller.clientHeight / 2;
      } else if (st.row !== was.row || st.order !== was.order) dom.scroll.children[st.row]?.scrollIntoView({ block: 'nearest' });
      last.current = { playRow, row: st.row, order: st.order };
    });
    // a click sets the cursor, a double click or the right button opens the popup: the notes, or the instruments
    const cell = (r, v, col, cls, text, empty) => h('span', {
      class: `${cls} ${empty ? 'trk-empty' : ''} ${r === st.row && v === st.voice && st.col === col ? 'trk-cursor' : ''}`,
      onpointerdown: e => { dom.wrap.focus({ preventScroll: true }); moveTo(r, v, col, { extend: e.shiftKey }); },
      ondblclick: e => cellPopup(e.currentTarget),
      oncontextmenu: e => { e.preventDefault(); const at = e.currentTarget; moveTo(r, v, col); cellPopup(at); },
    }, text);
    const game = st.song.game;
    // the head stays at the top of the rows; a song of many voices scrolls to the side
    return h('div', { class: 'trk-pattern', tabindex: 0, ref: x => { dom.wrap = x; } },
      h('div', { class: 'trk-scroll', ref: x => { dom.scroller = x; } },
        h('div', { class: 'trk-row trk-head' }, h('span', { class: 'trk-num' }, hex2(st.song.orders[st.order])),
          Array.from({ length: voices() }, (_, v) => h('span', { class: `trk-cell trk-voice-head ${game.includes(v) ? 'trk-voice-head--game' : ''}` },
            h('button', { class: `trk-voice ${st.muted[v] ? 'trk-voice--muted' : ''}`, type: 'button',
              'data-tip': st.muted[v] ? '§0339' : '§0340', onclick: () => setMuted(v, !st.muted[v]) },
            icon(st.muted[v] ? 'volume_off' : 'volume_up', 'msr--xs'), tr('§0343', v + 1)),
            h('button', { class: `trk-game ${game.includes(v) ? 'trk-game--on' : ''}`, type: 'button',
              'data-tip': game.includes(v) ? tr('§0318', game.indexOf(v) + 1) : '§0316',
              onclick: () => toggleGame(v) }, icon('sports_esports', 'msr--xs'))))),
        h('div', { class: 'trk-rows', ref: x => { dom.scroll = x; } }, Array.from({ length: st.song.rows }, (_, r) =>
        h('div', { key: r, class: `trk-row ${r % 16 === 0 ? 'trk-row--bar' : r % 4 === 0 ? 'trk-row--beat' : ''} ${r === playRow ? 'trk-row--playing' : ''}` },
          h('span', { class: 'trk-num' }, hex2(r)),
          Array.from({ length: voices() }, (_, v) => {
            const o = at(r, v), note = p[o], ins = p[o + 1];
            const selected = !!sel && r >= sel.r0 && r <= sel.r1 && v >= sel.v0 && v <= sel.v1;
            const cmd = p[o + 2], value = p[o + 3];
            return h('span', { class: `trk-cell ${st.muted[v] ? 'trk-cell--muted' : ''} ${selected ? 'trk-cell--selected' : ''}` },
              cell(r, v, 0, 'trk-note', noteName(note), !note), cell(r, v, 1, 'trk-ins', ins ? hex2(ins) : '--', !ins),
              cell(r, v, 2, 'trk-cmd', cmd ? HEX[cmd] : '-', !cmd), cell(r, v, 3, 'trk-val', cmd ? hex2(value) : '--', !cmd));
          }))))));
  }

  function ordersView() {
    const s = st.song;
    return h('div', { class: 'trk-orders' },
      h('div', { class: 'trk-orders__head' }, h('span', { class: 'section__title' }, '§0344')),
      h('div', { class: 'trk-orders__list' }, s.orders.map((p, k) => h('button', {
        class: `trk-order ${k === st.order ? 'trk-order--selected' : ''} ${st.pos && k === st.pos.order ? 'trk-order--playing' : ''}`, type: 'button',
        onclick: () => { st.order = k; st.anchor = null; update(); } },
      h('span', { class: 'trk-num' }, hex2(k)), h('span', {}, hex2(p)), k === s.loop ? icon('replay', 'msr--xs') : ''))),
      h('div', { class: 'trk-orders__tools' },
        iconButton('remove', '§0345', () => stepPattern(-1)),
        iconButton('add', '§0346', () => stepPattern(1)),
        iconButton('playlist_add', '§0347', () => addOrder('same')),
        iconButton('note_add', '§0348', () => addOrder('new')),
        iconButton('content_copy', '§0349', () => addOrder('copy')),
        iconButton('replay', '§0969', () => songEdit(() => { s.loop = s.loop === st.order ? NO_LOOP : st.order; })),
        iconButton('delete', '§0970', removeOrder)));
  }

  const section = (title, action, ...content) => uiSection(title, content, action);

  function sideView() {
    const s = st.song, i = s.instruments[st.ins - 1];
    const num = (label, key, max, format, tip, min = 0) => slider({ label, value: i[key], min, max, format, tip,
      oninput: v => setIns(key, v, false), onchange: v => setIns(key, v, true) });
    const semitones = v => (v ? tr('§1069', v, v > 1 ? 's' : '') : 'off');
    const local = (label, key, min, max, format) => slider({ label, value: st[key], min, max, format, oninput: v => { st[key] = v; update(); } });
    const pulse = !!(i.wave & 0x40);
    // the row of a table an instrument starts at: up to the rows the table has
    const rowOf = v => (v ? tr('§1326', hex2(v)) : 'off');
    const tabRow = (label, key, table) => num(label, key, Math.max(1, s.tables[table].length, i[key]), rowOf);
    return [
      section('§1098', null,
        slider({ label: '§1106', value: s.tempo, min: 1, max: 24, format: v => tr('§0350', v, Math.round(750 / v)),
          tip: '§0971',
          oninput: v => { if (!sliding) snapshot(); sliding = true; s.tempo = v; syncSong(); }, onchange: () => { sliding = false; update(); } }),
        select({ label: '§0351', value: s.rows, options: [...new Set([...ROW_CHOICES, s.rows])].sort((a, b) => a - b).map(r => ({ value: r, label: tr('§1076', r) })),
          onchange: v => songEdit(() => setRows(s, Number(v))) }),
        h('div', { class: 'trk-two' }, local('§0352', 'octave', 0, 7), local('§0353', 'step', 0, 8)),
        choosing() ? h('div', { class: 'trk-game-voices' },
          h('div', { class: 'section__hint' }, tr('§0320', s.voices, s.game.length ? s.game.map(v => v + 1).join(', ') : 'none')),
          segmented([{ value: 'all', label: '§0312' }, { value: 'game', label: '§0313' }], st.hearAll ? 'all' : 'game', v => hear(v === 'all')),
          s.voices > VOICES ? button('§0314', { variant: 'outlined', icon: 'delete_sweep', onclick: keepGameVoices,
            tip: '§0315' }) : null) : null),
      section('§0354', iconButton('add', '§0355', e => addMenu(e.currentTarget)),
        h('div', { class: 'trk-instruments' }, s.instruments.map((x, k) => h('button', { class: `trk-instrument ${k + 1 === st.ins ? 'trk-instrument--selected' : ''}`, type: 'button',
          onclick: () => { st.ins = k + 1; update(); } },
        h('span', { class: 'trk-num' }, HEX[k + 1]), h('span', { class: 'trk-instrument__name' }, x.name),
        h('span', { class: 'trk-instrument__wave' }, WAVES.find(w => w.value === (x.wave & 0xf0))?.label ?? '')))),
        h('div', { class: 'section__hint', style: { margin: '8px 0 0' } }, '§0364')),
      // keyed by the instrument: its sliders and its name start anew with another one
      h('div', { key: `${st.ins}:${s.instruments.length}` }, section(tr('§1112', HEX[st.ins]), s.instruments.length > 1 ? iconButton('delete', '§0365', removeInstrument) : null,
        field({ label: '§1293', value: i.name, dense: true, onchange: v => songEdit(() => { i.name = v.replace(/[^\x20-\x7e]/g, '').slice(0, 12) || 'instrument'; }) }),
        // the waveform, then sync and ring modulation with the voice before (the SID's: voice 3 for
        // voice 1) as buttons that are on or off; ring modulates the triangle - with another
        // waveform the SID plays it without
        segmented(WAVES.map(w => ({ value: String(w.value), label: w.label })), String(i.wave & 0xf0), v => songEdit(() => { i.wave = Number(v) | (i.wave & (SYNC | RING)); }),
          [[SYNC, '§1336', '§1585'], [RING, '§1337', '§1586']].map(([bit, label, tip]) => ({ label: tr(label), tip: tr(tip), on: !!(i.wave & bit),
            onchange: on => songEdit(() => { i.wave = on ? i.wave | bit : i.wave & ~bit; }) })), 'md-segmented--fill'),
        h('div', { class: 'trk-two' },
          num('§1113', 'a', 15, v => ms(ATTACK_MS[v])), num('§1114', 'd', 15, v => ms(ATTACK_MS[v] * 3)),
          num('§1115', 's', 15, v => `${v} / 15`, '§0366'), num('§1116', 'r', 15, v => ms(ATTACK_MS[v] * 3))),
        pulse ? h('div', { class: 'trk-two' },
          num('§0367', 'pulse', 4095, v => tr('§0715', Math.round(v / 40.95)), '§0368'),
          num('§0369', 'pwm', 255, v => (v ? tr('§0370', v) : 'off'), '§0371')) : '',
        h('div', { class: 'trk-two' },
          num('§0372', 'vibDepth', 15, v => (v ? String(v) : 'off'), '§0373'),
          num('§0374', 'vibSpeed', 15, v => (v ? String(v) : 'off'))),
        h('div', { class: 'trk-two' },
          num('§0375', 'arp1', 15, semitones, '§0972'),
          num('§0376', 'arp2', 15, semitones, '§0377')),
        h('div', { class: 'md-label-medium', style: { margin: '12px 0 4px' }, 'data-tip': '§0378' }, '§1170'),
        segmented(FILTERS.map(f => ({ value: String(f.value), label: f.label })), String(i.filter), v => songEdit(() => { i.filter = Number(v); })),
        i.filter ? h('div', { class: 'trk-two' },
          num('§0379', 'cutoff', 255, v => `${Math.round((30 + v * 8 * 5.8) / 10) * 10} Hz`, '§0380'),
          num('§0381', 'res', 15, v => `${v} / 15`, '§0382'),
          num('§0383', 'sweep', 127, v => (v ? tr('§0384', v > 0 ? '+' : '', v) : 'off'), '§0385', -128)) : '',
        h('div', { class: 'md-label-medium', style: { margin: '12px 0 4px' }, 'data-tip': '§1325' }, '§1309'),
        h('div', { class: 'trk-two' },
          tabRow('§1320', 'waveTab', 'wave'), tabRow('§1321', 'pulseTab', 'pulse'),
          tabRow('§1322', 'filterTab', 'filter'), tabRow('§1323', 'vibTab', 'speed'),
          i.vibTab ? num('§1324', 'vibDelay', 255, v => (v ? tr('§1327', v) : 'off')) : null))),
      tablesView(),
      section('§0386', null,
        h('div', { class: 'inline-actions' },
          ...[[-12, '§0387'], [-1, '− 1'], [1, '+ 1'], [12, '§0388']].map(([n, label]) =>
            button(label, { variant: 'tonal', tip: tr('§1070', n, Math.abs(n) > 1 ? 's' : ''), onclick: () => transposeBy(n) }))),
        // copy, cut and paste of the selected cells, or of the note at the cursor (the keys do the same)
        h('div', { class: 'inline-actions trk-clip', style: { marginTop: '8px' } },
          button('§1712', { variant: 'tonal', icon: 'content_copy', tip: '§1715', onclick: () => copy() }),
          button('§1713', { variant: 'tonal', icon: 'content_cut', tip: '§1716', onclick: () => copy(true) }),
          button('§1714', { variant: 'tonal', icon: 'content_paste', tip: '§1719', disabled: !st.clip, onclick: paste })),
        h('div', { class: 'section__hint', style: { margin: '12px 0 0' } },
          'Notes: Z S X D C V G B H N J M and Q 2 W 3 E R 5 T 6 Y 7 U, an octave higher; 1 is the note off. In the instrument column: 0-F. ',
          '§1308',
          'A double click, the right button or Enter opens the popup of the cell: every note, the instruments, or the commands. ',
          '§1855',
          '§0389')),
    ];
  }

  // the tables of the song: a row is a left and a right byte, typed in hex
  // a byte of a row of a table, chosen in a popup: what it does, by name - no values. at: the
  // mouse, or the field
  function tablePopup(at, k, n, side) {
    const rows = st.song.tables[k], [l, r] = rows[n], cur = side ? r : l;
    const setRow = (a, b) => songEdit(() => { rows[n][0] = a; rows[n][1] = b; });
    const set = v => setRow(side ? l : v, side ? v : r);
    const item = (v, text, row = null) => ({ label: text, checked: row ? l === row[0] && r === row[1] : cur === v, onclick: () => (row ? setRow(...row) : set(v)) });
    // a key of a grid: its text, whether it is the value now, what it sets
    const key = (text, current, fn, extra = '') => h('button', { class: `trk-notes__key ${extra} ${current ? 'trk-notes__key--current' : ''}`, type: 'button',
      'data-autofocus': current ? '' : undefined, onclick: () => { closeMenu(); fn(); } }, text);
    const head = text => h('div', { class: 'md-menu__header' }, text);
    const grid = (keys, wide = false) => h('div', { class: `trk-picks ${wide ? 'trk-picks--wide' : ''}` }, keys);
    const title = { header: tr(side ? '§1329' : '§1328', hex2(n + 1)) };
    const open = (items, ...content) => openMenu(at, [title, ...items].filter(Boolean), content.length ? h('div', {}, ...content) : null);
    const unused = () => open([{ label: '§1348', disabled: true }]);
    const jumpItem = item(0xff, tr('§1333'), l === 0xff ? [l, r] : [0xff, 0]);
    // the right byte of a jump: the end, or a row of the table
    if (side && l === 0xff && k !== 'speed') {
      return openMenu(at, [{ header: tr('§1342') }, item(0, tr('§1334')),
        ...rows.map((x, j) => item(j + 1, `${tr('§1326', hex2(j + 1))} · ${rowText(k, x[0], x[1])[0]}`))]);
    }
    // a sweep: so many frames (left), so much a frame (right)
    const frames = keep => [head('§1356'), grid(FRAME_PICKS.map(f => key(String(f), l === f, () => setRow(f, keep))))];
    const speeds = () => [head('§1357'), grid(SPEED_PICKS.map(s => key(s > 0 ? `+${s}` : String(s), signedText(r) === (s > 0 ? `+${s}` : String(s)), () => set(s & 255))))];
    if (k === 'wave') {
      const wkey = (v, text, extra) => key(text, cur === v, () => set(v), extra);
      if (!side) {
        const shown = WAVE_CHOICES.includes(cur) || cur < 0x10 || cur >= 0xf0 ? WAVE_CHOICES : [...WAVE_CHOICES, cur];
        return open([item(0, tr('§1330')), { header: '§1340' }, ...shown.map(v => item(v, waveName(v))), { divider: true }, jumpItem,
          cur >= 0xf0 && cur < 0xff ? item(cur, tr('§1332')) : null],
        head('§1341'), grid(Array.from({ length: 15 }, (_, j) => wkey(j + 1, String(j + 1)))));
      }
      if (isWait(l) || (l >= 0xf0 && l < 0xff)) return unused();
      const notes = h('div', { class: 'trk-notes' },
        h('span', {}), NOTE_NAMES.map(x => h('span', { class: `trk-notes__head ${x[1] === '#' ? 'trk-notes__sharp' : ''}` }, x.replace('-', ''))),
        Array.from({ length: 8 }, (_, octave) => [h('span', { class: 'trk-notes__head' }, String(octave)),
          NOTE_NAMES.map((x, j) => (octave * 12 + j < NOTES && octave * 12 + j <= 0x5f
            ? wkey(0x80 + octave * 12 + j, noteName(octave * 12 + j + 1), x[1] === '#' ? 'trk-notes__sharp' : '') : h('span', {})))]));
      return open([item(0, tr('§1339')), item(0x80, tr('§1335'))],
        head('§1343'), grid([...Array.from({ length: 24 }, (_, j) => wkey(0x68 + j, `-${24 - j}`)), ...Array.from({ length: 36 }, (_, j) => wkey(j + 1, `+${j + 1}`))]),
        head('§1344'), notes);
    }
    if (k === 'pulse') {
      if (!side) {
        return open([item(0, tr('§1350'), [0, 0]), item(0, tr('§1351'), isSet(l) ? [l, r] : [0x88, 0]), jumpItem],
          ...frames(l && l < 0x80 ? r : 0x10));
      }
      if (isSet(l)) {
        const width = p => { const w = Math.min(0xfff, Math.round(p * 40.95)); return [0x80 | (w >> 8), w & 255]; };
        return open([], head('§1358'), grid(Array.from({ length: 19 }, (_, j) => (j + 1) * 5).map(p => key(`${p} %`, percent(l, r) === p, () => setRow(...width(p))))));
      }
      return l ? open([], ...speeds()) : unused();
    }
    if (k === 'filter') {
      if (!side) {
        return open([{ header: '§1359' }, ...FILTER_TYPES.map(m => item(0, filterName(m), [0x80 | (m << 4), isSet(l) ? r : 0x80])).map((x, j) => ({ ...x,
          checked: isSet(l) && ((l >> 4) & 7) === FILTER_TYPES[j] })), { divider: true }, item(0, tr('§1354'), !l ? [0, r] : [0, 0x40]), jumpItem],
        ...frames(l && l < 0x80 ? r : 0x02));
      }
      if (isSet(l)) return open([], head('§1360'), grid(Array.from({ length: 16 }, (_, j) => key(String(j), r >> 4 === j, () => set(j << 4)))));
      if (!l) {
        return open([], head('§1361'), grid([...Array.from({ length: 16 }, (_, j) => j * 16), 255].map(v => key(cutoffText(v), r === v, () => set(v))), true));
      }
      return open([], ...speeds());
    }
    // the speed table: a vibrato (frames of a half wave, depth) or a speed of a slide or glide
    const slides = [head('§1365'), grid(SLIDE_PICKS.map(v => key(String(v), ((l << 8) | r) === v, () => setRow(v >> 8, v & 255))))];
    if (!side) return open([], head('§1362'), grid([...Array.from({ length: 17 }, (_, j) => j), 24, 32, 48, 64, 96, 128].map(f => key(String(f), l === f, () => set(f)))), ...slides);
    return open([], head('§1363'), grid([0, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 255].map(v => key(String(v), r === v, () => set(v)))), ...slides);
  }

  function tablesView() {
    const s = st.song, k = st.table, rows = s.tables[k];
    // a byte shows only what it does; a double click opens its popup at the mouse, Enter under it
    const byte = (r, n, side) => h('button', { class: 'trk-table__pick', type: 'button', 'aria-label': tr(side ? '§1329' : '§1328', hex2(n + 1)),
      'data-tip': k === 'speed' ? tr('§1366', (r[0] << 8) | r[1]) : '§1349',
      ondblclick: e => tablePopup({ x: e.clientX, y: e.clientY }, k, n, side),
      onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); tablePopup(e.currentTarget, k, n, side); } } },
    rowText(k, r[0], r[1])[side] || '-');
    return section('§1309', null,
      segmented(TABLES.map(t => ({ value: t, label: TABLE_LABELS[t] })), k, v => { st.table = v; update(); }),
      rows.length ? h('div', { class: 'trk-table' }, rows.map((r, n) => h('div', { class: 'trk-table__row', key: `${k}:${n}` },
        h('span', { class: 'trk-num' }, hex2(n + 1)),
        [0, 1].map(side => byte(r, n, side))))) : null,
      h('div', { class: 'inline-actions' },
        iconButton('add', '§1318', () => { if (rows.length < MAX_TABLE_ROWS) songEdit(() => { rows.push([0, 0]); }); }),
        iconButton('remove', '§1319', async () => {
          if (rows.length && await confirmRemove({ what: tr('§1481', hex2(rows.length), TABLE_LABELS[k]), kind: 'song-table-row', verb: 'remove' })) songEdit(() => { rows.pop(); });
        })),
      h('div', { class: 'section__hint' }, TABLE_HINTS[k]));
  }

  function barView() {
    if (!isOpen()) return null;             // no project: nothing to edit, like screen and sprites
    const playing = st.playing;
    return h('div', { class: 'screen-bar' },
      h('span', { class: 'md-title-medium' }, 'Composer'),
      h('span', { class: 'screen-bar__sep' }),
      select({ label: '§1098', hideLabel: true, value: st.file ?? '', dense: true, cls: 'screen-bar__sprite',
        // the open song is the first option and carries its own path, so the select shows its name
        options: [{ value: st.file ?? '', label: st.file ?? '§1088' }, ...st.files.filter(f => f !== st.file).map(f => ({ value: f, label: f }))],
        onchange: v => { if (v) openFile(v); } }),
      iconButton('add', '§0390', newFile),
      h('span', { class: 'screen-bar__sep' }),
      iconButton('undo', 'Undo (Ctrl+Z)', () => restore(st.undo, st.redo)),
      iconButton('redo', 'Redo (Ctrl+Y)', () => restore(st.redo, st.undo)),
      h('span', { class: 'screen-bar__sep' }),
      iconButton('play_arrow', '§0391', () => play('song'), playing === 'song' ? 'md-icon-button--selected' : ''),
      iconButton('repeat_one', '§0392', () => play('pattern'), playing === 'pattern' ? 'md-icon-button--selected' : ''),
      iconButton('stop', '§0393', stop),
      iconButton(allMuted() ? 'volume_off' : 'volume_up', allMuted() ? '§0342' : '§0341', toggleAllMuted, allMuted() ? 'md-icon-button--selected' : ''),
      h('div', { class: 'app-bar__spacer' }));
  }

  // what the Export button of the app bar offers here (app.js)
  const exportFormats = () => (!isOpen() || !st.song ? [] : [{ label: '§1856', icon: 'music_note', name: exportName(st.file ?? 'song', 'sng'),
    description: 'yopaca song', bytes: () => encode(st.song) }]);

  // the changed song into its file, for the Save of the app bar: a new song asks for its path.
  // false: that was cancelled
  async function saveChanges() {
    if (!st.dirty) return true;
    await save(false, { quiet: true });
    return !st.dirty;
  }

  const bodyView = () => !isOpen() ? null : h('div', { class: 'screen-body' },
    h('div', { class: 'screen-main' }, h('div', { class: 'trk' }, ordersView(), h(Pattern, {})), h('div', { class: 'screen-foot' }, h('span', { class: 'md-body-small screen-status' }, statusText()))),
    sidePanel('Composer', sideView()));

  function render() {
    views ??= [mount(bar, barView), mount(el, bodyView)];
    update();
    if (isOpen()) onRoute?.();
  }

  addEventListener('keydown', onKey, true);
  addEventListener('keyup', e => release(e.code), true);
  addEventListener('blur', () => { for (const code of [...held.keys()]) release(code); });

  async function open() {
    if (!isOpen()) return render();
    await listFiles();
    const first = st.files.find(f => /\.sng$/i.test(f));
    if (!views && !st.file && first) return openFile(first);
    render();
  }

  // the view closes: the song stops
  function close() { if (st.playing) stop(); }

  // a song named in the storyboard
  async function selectFile(file) {
    await listFiles();
    if (file !== st.file) await openFile(file);
  }

  // what a reload keeps (uistate.js): the cursor in the song, the instrument, the octave, the table shown
  const KEEP = ['order', 'row', 'voice', 'col', 'ins', 'octave', 'step', 'table', 'hearAll'];
  keepUi('sound', { save: () => pickUi(st, KEEP), load(s) { putUi(st, s, KEEP); if (!el.hidden) render(); } });

  return { open, close, select: selectFile, saveChanges, exportFormats, importFormats, isDirty: () => st.dirty, current: () => st.file };
}
