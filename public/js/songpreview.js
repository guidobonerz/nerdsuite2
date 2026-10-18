// songpreview.js - hears a song of the project outside the Sound view: the play buttons of the
// storyboard (the steps 'Play music' and 'Play sound', the music and sounds of a place and of
// the game). It plays like the game does - music from its start, a sound as the first voice
// of its song, once - on the SID model and the player of the Sound view (sidworklet.js).

import { readBinary } from './project.js';

let audio = null;                 // {ctx, post}, made with the first sound
let playing = null;               // the key of the music that plays
const listeners = new Set();

async function start() {
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  let post;
  try {
    await ctx.audioWorklet.addModule(new URL('./sidworklet.js', import.meta.url));
    const node = new AudioWorkletNode(ctx, 'sid-engine', { numberOfInputs: 0, outputChannelCount: [1] });
    node.connect(ctx.destination);
    post = m => node.port.postMessage(m);
  } catch {                         // no worklets with modules: the player in this thread
    const { SidEngine } = await import('./sidplayer.js');
    const engine = new SidEngine(ctx.sampleRate);
    const node = ctx.createScriptProcessor(2048, 0, 1);
    node.onaudioprocess = e => engine.render(e.outputBuffer.getChannelData(0));
    node.connect(ctx.destination);
    post = m => engine.handle(m);
  }
  return { ctx, post };
}

async function songBytes(key) {
  return readBinary(key);
}

// the music that plays (its project path), for the buttons
export const previewPlaying = () => playing;
export function onPreviewChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const changed = key => { playing = key; listeners.forEach(fn => fn()); };

// key: the project path of the song; kind: 'music' (again: it stops) or 'sound'
export async function previewSong(key, kind) {
  if (kind === 'music' && playing === key) return stopPreview();
  return playSong(key, kind);
}

// the music and the sounds of the game in the Play view (play.js): music plays from its start
// until other music or 'off', a sound over it
let asked = 0;                    // the last music asked for: a song read late does not play over it
// polite: not over another sound (a step)
export async function playSong(key, kind, polite = false) {
  const n = kind === 'music' ? ++asked : asked;
  const bytes = await songBytes(key);
  const a = await (audio ??= start());
  if (kind === 'music' && n !== asked) return;
  if (a.ctx.state === 'suspended' && !held) await a.ctx.resume();
  if (kind === 'sound') return a.post({ type: 'sound', bytes, polite });   // over the music that plays
  a.post({ type: 'song', bytes });
  a.post({ type: 'play', order: 0, row: 0, loop: false });
  changed(key);
}

export function stopPreview() {
  asked++;
  if (!audio || !playing) return;
  audio.then(a => a.post({ type: 'stop' }));
  changed(null);
}

// the game paused: what plays holds where it is and goes on with the game
let held = false;
export function holdSongs(on) {
  if (held === on) return;
  held = on;
  audio?.then(a => on ? a.ctx.suspend() : a.ctx.resume());
}
// a browser starts sound only after a click: the first one resumes what the game started before
addEventListener('pointerdown', () => audio?.then(a => { if (!held && a.ctx.state === 'suspended') a.ctx.resume(); }));
