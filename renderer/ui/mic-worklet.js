// Voice mode's microphone tap: sends the mic's samples (16 kHz mono, set by
// the AudioContext) to the panel in blocks of 512 (32 ms). Its output stays
// silent.
class LumioMic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(512);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf);
          this.buf = new Float32Array(512);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('lumio-mic', LumioMic);
