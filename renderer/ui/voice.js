// Voice in the AI panel.
// - The mic button dictates: talk, and your words land in the message box.
//   When you send what you said, the answer is read aloud too (you talked to
//   it, so it talks back); typing a message keeps answers silent.
// - Voice mode (the waveform button) is a live conversation, like ChatGPT's:
//   the microphone stays open the whole time. Talk and Lumio answers out
//   loud, sentence by sentence as it writes. It says what it's doing while it
//   works. Talk while it works and your words join the task ("actually, use
//   Best Buy"; "stop" stops it). Start talking while it speaks and it stops
//   to listen.
// Speech is turned into text and back by the Lumio server (charged to the
// weekly allowance like everything else). Hearing when you start and stop
// talking happens here, so silence costs nothing.
const $ = (sel) => document.querySelector(sel);

const RATE = 16000; // the microphone's sample rate (what speech-to-text wants)
const PIECE = 600; // characters per spoken piece; the next one loads while one plays
const MAX_REPLY_SPOKEN = 2400; // a longer reply is cut short: "The rest is in the chat."
const NARRATE_GAP = 7000; // say what it's doing after this long without speaking

// ---------------------------------------------------------------- text to speech
// Markdown -> plain sentences worth reading aloud.
export function speakable(md) {
  let t = String(md || '');
  t = t.replace(/```[\s\S]*?(```|$)/g, ' (There’s code in the chat.) ');
  t = t.replace(/`([^`]+)`/g, '$1');
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  t = t.replace(/https?:\/\/\S+/g, 'the link in the chat');
  t = t.replace(/^\s{0,3}#{1,6}\s*/gm, '');
  t = t.replace(/^\s*[-*+]\s+/gm, '');
  t = t.replace(/^\s*\d+[.)]\s+/gm, '');
  t = t.replace(/^\s*>\s?/gm, '');
  t = t.replace(/\|/g, ', ').replace(/^[\s,:-]+$/gm, '');
  t = t.replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]+?)\1/g, '$2');
  t = t.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  return t;
}

// Splits text into pieces of up to PIECE characters at sentence ends.
export function pieces(text) {
  const out = [];
  let cur = '';
  for (const s of String(text).split(/(?<=[.!?…])\s+|\n+/)) {
    if (!s.trim()) continue;
    if (cur && (cur + ' ' + s).length > PIECE) { out.push(cur); cur = ''; }
    if (s.length > PIECE) {
      for (let i = 0; i < s.length; i += PIECE) out.push(s.slice(i, i + PIECE));
    } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

// Streaming text -> whole sentences as soon as each one is finished, so Lumio
// starts talking while it's still writing. Code blocks wait until they close.
export class SentenceStream {
  constructor() { this.buf = ''; }
  push(delta) {
    this.buf += delta;
    const out = [];
    for (;;) {
      const end = this.boundary();
      if (end < 0) break;
      const chunk = this.buf.slice(0, end).trim();
      this.buf = this.buf.slice(end);
      if (/[\p{L}\p{N}]/u.test(chunk)) out.push(chunk);
    }
    return out;
  }
  // Where the first finished sentence ends (-1 if none yet), never inside a
  // code block.
  boundary() {
    const re = /([.!?…:]["”’)]*)(\s+)|\n+/g;
    for (let m; (m = re.exec(this.buf));) {
      const fences = (this.buf.slice(0, m.index).match(/```/g) || []).length;
      if (fences % 2 === 0) return m.index + m[0].length;
    }
    return -1;
  }
  flush() {
    const rest = this.buf.trim();
    this.buf = '';
    return /[\p{L}\p{N}]/u.test(rest) ? [rest] : [];
  }
}

// Did the microphone just hear Lumio itself (from the speakers)? Most of
// what was heard appears in what it said a moment ago.
export function isEcho(heard, spoken) {
  const words = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter((w) => w.length > 1);
  const h = words(heard);
  if (!h.length) return true;
  const said = new Set(words(spoken));
  if (!said.size) return false;
  return h.filter((w) => said.has(w)).length / h.length >= 0.6;
}

// A step's label ("Reading www.apple.com", "Click “Add to Bag”") as something
// to say while Lumio works quietly, or null when it isn't worth saying.
export function narration(label) {
  let t = String(label || '').replace(/[“”"]/g, '').replace(/\[\d+\]\s*/g, '').replace(/\bwww\./g, '').trim();
  if (!t || t.length > 70 || /^(Updating the plan|Wait)/i.test(t)) return null;
  if (/^Click\b/.test(t)) t = t.replace(/^Click\b/, 'Clicking');
  return t.endsWith('…') ? t : `${t}…`;
}

// ---------------------------------------------------------------- hearing
// Decides when someone starts and stops talking from the microphone's
// loudness, keeping a moment from before they started. `strict` (while Lumio
// talks) asks for louder, longer speech, so its own voice from the speakers
// doesn't count.
export class Listener {
  constructor({ endMs = 800, maxMs = 60_000, minSpeechMs = 280 } = {}) {
    Object.assign(this, { endMs, maxMs, minSpeechMs });
    this.floor = 0.004;
    this.preroll = [];
    this.inSpeech = false;
    this.loud = 0;
    this.level = 0;
  }
  // Returns 'start', { samples, ms } when a phrase ends, 'discard' when it
  // was too short to be speech, or null.
  push(frame, strict = false) {
    const ms = (frame.length / RATE) * 1000;
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    this.level = rms;
    const thresh = strict ? Math.max(0.045, this.floor * 7) : Math.max(0.016, this.floor * 3.2);
    if (!this.inSpeech) {
      this.floor = rms < this.floor ? this.floor * 0.9 + rms * 0.1 : this.floor * 0.995 + rms * 0.005;
      this.preroll.push(frame);
      while (this.preroll.length * ms > 400) this.preroll.shift();
      this.loud = rms > thresh ? this.loud + ms : 0;
      if (this.loud >= (strict ? 220 : 90)) {
        this.inSpeech = true;
        this.frames = [...this.preroll];
        this.speech = this.loud;
        this.quiet = 0;
        this.total = this.preroll.length * ms;
        this.preroll = [];
        this.thresh = thresh;
        return 'start';
      }
      return null;
    }
    this.frames.push(frame);
    this.total += ms;
    if (rms > Math.min(thresh, this.thresh) * 0.55) { this.quiet = 0; this.speech += ms; } else this.quiet += ms;
    if (this.quiet >= this.endMs || this.total >= this.maxMs) return this.finish();
    return null;
  }
  // Ends the phrase now (also when the person clicks to say they're done).
  finish() {
    if (!this.inSpeech) return null;
    this.inSpeech = false;
    this.loud = 0;
    if (this.speech < this.minSpeechMs) return 'discard';
    // Keep about 0.2 s of the quiet at the end.
    const ms = ((this.frames[0]?.length || 512) / RATE) * 1000;
    const drop = Math.max(0, Math.floor((this.quiet - 200) / ms));
    const frames = this.frames.slice(0, this.frames.length - drop);
    const n = frames.reduce((a, f) => a + f.length, 0);
    const samples = new Float32Array(n);
    let o = 0;
    for (const f of frames) { samples.set(f, o); o += f.length; }
    this.frames = [];
    return { samples, ms: (n / RATE) * 1000 };
  }
}

// 16 kHz mono float samples -> a WAV file (16-bit PCM).
export function encodeWav(samples, rate = RATE) {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); out.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE');
  text(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  text(36, 'data'); out.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Uint8Array(out.buffer);
}

// The microphone, as 16 kHz blocks of samples.
async function openMic(onFrame) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  const ctx = new AudioContext({ sampleRate: RATE });
  try {
    await ctx.audioWorklet.addModule('mic-worklet.js');
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    ctx.close();
    throw err;
  }
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'lumio-mic');
  node.port.onmessage = (e) => onFrame(e.data);
  src.connect(node);
  node.connect(ctx.destination); // silent; keeps the worklet running
  // Started after awaiting the microphone, so it may begin paused.
  if (ctx.state !== 'running') await ctx.resume().catch(() => {});
  return {
    close() {
      node.port.onmessage = null;
      try { src.disconnect(); node.disconnect(); } catch {}
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
    },
  };
}

// ---------------------------------------------------------------- speaking
// Says things one after another. Each piece's audio is fetched as soon as it's
// queued, so the next one is ready when the last ends.
class Speaker {
  constructor({ fetchAudio, onChange, onError }) {
    Object.assign(this, { fetchAudio, onChange, onError });
    this.queue = [];
    this.current = null; // { text, audio, el }
    this.recent = ''; // what it said lately (to recognize its own voice)
    this.lastEnd = 0;
    this.ducked = false;
  }
  get busy() { return !!this.current || this.queue.length > 0; }
  say(text) {
    for (const p of pieces(text)) this.queue.push({ text: p, audio: this.fetchAudio(p) });
    this.pump();
  }
  async pump() {
    if (this.current || !this.queue.length) return;
    const item = this.queue.shift();
    this.current = item;
    this.onChange();
    const res = await item.audio;
    if (this.current !== item) return; // stopped meanwhile
    if (res?.error || !res?.audio) {
      this.current = null;
      this.queue = [];
      if (res?.error) this.onError(res.error);
      this.onChange();
      return;
    }
    const url = URL.createObjectURL(new Blob([res.audio], { type: 'audio/mpeg' }));
    const el = new Audio(url);
    el.volume = this.ducked ? 0.25 : 1;
    item.el = el;
    this.recent = `${this.recent} ${item.text}`.slice(-600);
    await new Promise((resolve) => {
      item.done = resolve;
      el.addEventListener('ended', resolve, { once: true });
      el.addEventListener('error', () => { this.onError('Lumio’s voice couldn’t play. Check your sound output.'); resolve(); }, { once: true });
      el.play().catch((err) => { if (err?.name !== 'AbortError') this.onError(`Lumio’s voice couldn’t play (${err?.message || err}).`); resolve(); });
    });
    URL.revokeObjectURL(url);
    if (this.current !== item) return;
    this.current = null;
    this.lastEnd = Date.now();
    this.onChange();
    this.pump();
  }
  duck(on) {
    this.ducked = on;
    if (this.current?.el) this.current.el.volume = on ? 0.25 : 1;
  }
  stop() {
    const item = this.current;
    this.queue = [];
    this.current = null;
    this.ducked = false;
    if (item?.el) item.el.pause();
    item?.done?.();
    this.lastEnd = Date.now();
    this.onChange();
  }
}

// ---------------------------------------------------------------- the panel part
export function initVoice({ api, prompt, autosize, submit, notice, isReady, isBusy, getChatId, onChange = () => {} }) {
  const micBtn = $('#mic-btn');
  const modeBtn = $('#voice-btn');
  const bar = $('#voice-bar');
  const status = bar.querySelector('.vb-status');
  const caption = bar.querySelector('.vb-cap');
  const muteBtn = bar.querySelector('.vb-mute');

  let mic = null; // the open microphone
  let listener = null;
  let mode = false; // the live conversation is on
  let dictating = false;
  let dictated = ''; // the last dictated words, until a message with them is sent
  let aloud = null; // a dictated message's chat: its answer is read aloud
  let muted = false;
  let starting = false;
  let hearing = 0; // phrases being turned into text
  let chain = Promise.resolve(); // what was heard is handled in order
  let heardOverSpeech = false; // the phrase began while Lumio was talking
  let working = ''; // what Lumio is doing (its latest step), while it works
  let stream = new SentenceStream();
  let spokenThisReply = 0;
  let cutShort = false;

  const speaker = new Speaker({
    fetchAudio: (text) => api.invoke('ai:voice-speak', { text }).catch(() => ({ error: 'Couldn’t read that aloud.' })),
    onChange: () => render(),
    onError: (msg) => notice(msg),
  });

  function phase() {
    if (!mode) return '';
    if (listener?.inSpeech) return 'hearing';
    if (speaker.current) return 'speaking';
    if (hearing) return 'thinking';
    if (isBusy()) return 'working';
    return 'listening';
  }
  function render() {
    const p = phase();
    document.body.classList.toggle('voice-on', mode);
    document.body.dataset.voice = p;
    micBtn.classList.toggle('on', dictating);
    modeBtn.classList.toggle('on', mode);
    modeBtn.setAttribute('aria-pressed', String(mode));
    bar.hidden = !mode;
    status.textContent = muted ? 'Microphone off' : {
      listening: 'Listening…',
      hearing: 'Listening…',
      thinking: 'Thinking…',
      working: working || 'Working on it…',
      speaking: 'Talk anytime to interrupt',
    }[p] || '';
    if (p === 'speaking' && speaker.current) caption.textContent = speaker.current.text;
    muteBtn.classList.toggle('on', muted);
    muteBtn.title = muted ? 'Turn the microphone on' : 'Mute the microphone';
    muteBtn.setAttribute('aria-pressed', String(muted));
    onChange();
  }

  function level(rms) {
    const v = Math.min(1, rms * 14).toFixed(2);
    bar.style.setProperty('--level', v);
    micBtn.style.setProperty('--level', v);
  }

  async function startMic() {
    listener = new Listener({ endMs: dictating ? 1300 : 800 });
    try {
      mic = await openMic(onFrame);
      return true;
    } catch (err) {
      listener = null;
      const why = `${err?.name} ${err?.message}`;
      notice(/denied|not allowed|permission/i.test(why)
        ? (/Mac/.test(navigator.platform) ? 'Lumio can’t use the microphone. Allow Lumio Browser in System Settings › Privacy & Security › Microphone, then try again.' : 'Lumio can’t use the microphone. In Windows Settings › Privacy & security › Microphone, turn on microphone access for desktop apps, then try again.')
        : /notfound|requested device/i.test(why) ? 'No microphone found.' : `The microphone didn’t start: ${err?.message || err}`);
      return false;
    }
  }
  function closeMic() {
    mic?.close();
    mic = null;
    listener = null;
    level(0);
  }

  function onFrame(frame) {
    if (!listener) return;
    if (muted) { level(0); return; }
    // While Lumio talks, only clearly louder speech counts (not its own voice).
    const strict = speaker.busy && !listener.inSpeech;
    const ev = listener.push(frame, strict);
    level(listener.level);
    if (ev === 'start') {
      heardOverSpeech = speaker.busy;
      if (mode && speaker.busy) speaker.duck(true); // quieter while you talk
      render();
    } else if (ev === 'discard') {
      speaker.duck(false);
      render();
    } else if (ev?.samples) phrase(ev);
  }

  // A finished phrase: turn it into text, then act on it (in order).
  function phrase(clip) {
    const overSpeech = heardOverSpeech;
    const spoken = speaker.recent;
    hearing++;
    render();
    const job = api.invoke('ai:voice-transcribe', { data: encodeWav(clip.samples), mime: 'audio/wav', seconds: clip.ms / 1000 })
      .catch(() => ({ error: 'Couldn’t reach Lumio. Check your connection.' }));
    chain = chain.then(async () => {
      const res = await job;
      hearing--;
      const text = (res.text || '').trim();
      if (res.error) notice(res.error);
      if (res.error || !text || (overSpeech && isEcho(text, spoken))) {
        speaker.duck(false);
        if (dictating) stopDictation();
        render();
        return;
      }
      await heard(text);
      render();
    });
  }

  async function heard(text) {
    if (dictating) {
      stopDictation();
      dictated = text;
      prompt.value = prompt.value.trim() ? `${prompt.value.trimEnd()} ${text}` : text;
      autosize();
      prompt.focus();
      prompt.setSelectionRange(prompt.value.length, prompt.value.length);
      return;
    }
    if (!mode) return;
    speaker.stop(); // you talked: Lumio stops to listen
    caption.textContent = `“${text}”`;
    newReply();
    const res = await submit(text, { voice: true });
    if (res && !res.ok && res.error) notice(res.error);
  }

  function newReply() {
    stream = new SentenceStream();
    spokenThisReply = 0;
    cutShort = false;
  }

  // Lumio's words, out loud as they're written.
  function speak(chunks) {
    for (const c of chunks) {
      if (cutShort) return;
      const t = speakable(c);
      if (!t) continue;
      if (spokenThisReply + t.length > MAX_REPLY_SPOKEN) {
        cutShort = true;
        speaker.say('The rest is in the chat.');
        return;
      }
      spokenThisReply += t.length;
      speaker.say(t);
    }
  }

  // ---------------------------------------------------------------- dictation
  micBtn.addEventListener('click', async () => {
    if (mode) { stopMode(); return; }
    if (aloud && speaker.busy) { speaker.stop(); aloud = null; render(); return; } // stop reading the answer
    if (dictating) { // done talking
      const ev = listener?.finish();
      if (ev?.samples) phrase(ev); else stopDictation();
      return;
    }
    if (starting) return;
    if (!isReady()) { notice('Sign in to Lumio to use your voice.'); return; }
    starting = true;
    dictating = true;
    render();
    const ok = await startMic();
    starting = false;
    if (!ok) { dictating = false; render(); return; }
    micBtn.title = 'Done talking';
  });
  function stopDictation() {
    dictating = false;
    closeMic();
    micBtn.title = 'Dictate';
    render();
  }

  // ---------------------------------------------------------------- voice mode
  async function startMode() {
    if (starting) return;
    if (!isReady()) { notice('Sign in to Lumio to use voice mode.'); return; }
    if (dictating) stopDictation();
    starting = true;
    mode = true;
    muted = false;
    caption.textContent = '';
    working = '';
    render();
    const ok = await startMic();
    starting = false;
    if (!ok) mode = false;
    render();
  }
  function stopMode() {
    mode = false;
    speaker.stop();
    closeMic();
    caption.textContent = '';
    render();
  }
  modeBtn.addEventListener('click', () => (mode ? stopMode() : startMode()));
  bar.querySelector('.vb-end').addEventListener('click', stopMode);
  muteBtn.addEventListener('click', () => {
    muted = !muted;
    if (muted) { const ev = listener?.finish(); if (ev?.samples) phrase(ev); }
    render();
  });
  bar.querySelector('.vb-orb').addEventListener('click', () => {
    if (speaker.busy) { speaker.stop(); return; } // skip what it's saying
    const ev = listener?.finish(); // done talking
    if (ev?.samples) phrase(ev);
  });

  return {
    // Every ai-event: in voice mode, the open chat's replies are spoken.
    onEvent(ev) {
      // A message sent with dictated words in it: its answer is read aloud.
      if (!mode && ev.type === 'user' && !ev.mid) {
        const said = dictated && String(ev.text || '').includes(dictated);
        dictated = '';
        speaker.stop();
        aloud = said ? ev.chatId : null;
        if (said) newReply();
        return;
      }
      if (!(mode || aloud === ev.chatId) || ev.chatId !== getChatId()) return;
      if (!mode && ['step', 'approval'].includes(ev.type)) { speak(stream.flush()); return; } // no narration outside voice mode
      if (!mode && ev.type === 'end') { speak(stream.flush()); aloud = null; return; }
      switch (ev.type) {
        case 'start':
          newReply();
          working = '';
          break;
        case 'text':
          speak(stream.push(ev.delta || ''));
          break;
        case 'text_end':
          speak(stream.flush());
          break;
        case 'step': {
          speak(stream.flush());
          const line = narration(ev.label);
          if (line) working = line.replace(/…$/, '');
          // Quiet for a while: say what it's doing.
          if (line && !speaker.busy && Date.now() - speaker.lastEnd > NARRATE_GAP) speaker.say(line);
          break;
        }
        case 'approval':
          speak(stream.flush());
          speaker.say('I need your OK in the panel to continue.');
          break;
        case 'error':
          speaker.say('Something went wrong. The details are in the chat.');
          break;
        case 'end':
          speak(stream.flush());
          working = '';
          break;
        default:
      }
      render();
    },
    refresh: () => render(),
    stop: () => { if (mode) stopMode(); else if (dictating) stopDictation(); if (aloud) { speaker.stop(); aloud = null; } },
  };
}
