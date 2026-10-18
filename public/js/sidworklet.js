// sidworklet.js - the audio worklet of the sound editor: the SID and the player of
// sidplayer.js render the sound, the editor sends the song and what to play (see SidEngine)

import { SidEngine } from './sidplayer.js';

class SidProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.engine = new SidEngine(sampleRate);
    this.engine.onpos = pos => this.port.postMessage(pos);
    this.port.onmessage = e => this.engine.handle(e.data);
  }

  process(inputs, outputs) {
    this.engine.render(outputs[0][0]);
    return true;
  }
}

registerProcessor('sid-engine', SidProcessor);
