// Voice in the AI panel.
// - The mic button dictates: talk, and your words land in the message box
//   (it stops when you click again or go quiet).
// - Voice mode (the waveform button) is hands-free: Lumio listens, sends what
//   you said when you stop talking, reads its answer aloud, then listens again.
// Audio goes to the Lumio server (speech to text, text to speech), which
// charges it to the weekly allowance like everything else.
const $ = (sel) => document.querySelector(sel);

const SPEECH_RMS = 0.025; // louder than this counts as talking
const QUIET_RMS = 0.015;
const QUIET_MS = 1300; // this long quiet after talking ends the recording
const NO_SPEECH_MS = 8000; // nothing said: give up
const MAX_MS = 110_000;
const CHUNK = 600; // characters per spoken piece (the next one loads while this one plays)
const MAX_SPOKEN = 3000;

// Markdown reply -> plain sentences worth reading aloud.
export function speakable(md) {
  let t = String(md || '');
  t = t.replace(/```[\s\S]*?```/g, ' (There’s code in the chat.) ');
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
  if (t.length > MAX_SPOKEN) {
    const cut = t.lastIndexOf('. ', MAX_SPOKEN);
    t = t.slice(0, cut > 1000 ? cut + 1 : MAX_SPOKEN) + ' The rest is in the chat.';
  }
  return t;
}

// Splits text into pieces of up to CHUNK characters at sentence ends.
export function pieces(text) {
  const out = [];
  let cur = '';
  for (const s of text.split(/(?<=[.!?…])\s+|\n+/)) {
    if (!s.trim()) continue;
    if (cur && (cur + ' ' + s).length > CHUNK) { out.push(cur); cur = ''; }
    if (s.length > CHUNK) {
      for (let i = 0; i < s.length; i += CHUNK) out.push(s.slice(i, i + CHUNK));
    } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

export function initVoice({ api, prompt, autosize, submit, notice, isReady, onChange = () => {} }) {
  const micBtn = $('#mic-btn');
  const modeBtn = $('#voice-btn');
  const bar = $('#voice-bar');
  let rec = null; // the recording in progress
  let starting = false; // waiting for the microphone
  let mode = false; // hands-free voice mode
  let phase = 'idle'; // idle | listening | hearing | thinking | speaking
  let player = null; // { audio, stop }
  let replyBuf = ''; // the reply being written, after the last tool step
  let waitingFor = null; // chat id we sent to in voice mode

  function setPhase(p) {
    phase = p;
    document.body.dataset.voice = mode ? p : '';
    micBtn.classList.toggle('on', !mode && !!rec);
    modeBtn.classList.toggle('on', mode);
    modeBtn.setAttribute('aria-pressed', String(mode));
    bar.hidden = !mode;
    const label = { listening: 'Listening…', hearing: 'Listening…', thinking: 'Working on it…', speaking: 'Speaking… tap to interrupt', idle: 'Voice mode' }[p];
    bar.querySelector('.vb-text').textContent = label;
    onChange();
  }

  // ---------------------------------------------------------------- recording
  async function record({ untilQuiet }) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (err) {
      notice(/denied|not allowed/i.test(err?.message || err?.name || '')
        ? 'Lumio can’t use the microphone. Allow Lumio Browser in System Settings › Privacy & Security › Microphone, then try again.'
        : 'No microphone found.');
      return null;
    }
    const type = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    const mr = new MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: 32000 });
    const parts = [];
    mr.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    const started = performance.now();
    let spoke = false;
    let quietSince = null;
    let timer = null;
    const r = { cancelled: false };
    const done = new Promise((resolve) => {
      r.stop = (cancel = false) => {
        if (mr.state === 'inactive') return;
        r.cancelled = cancel;
        clearInterval(timer);
        mr.stop();
      };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        ctx.close().catch(() => {});
        const seconds = (performance.now() - started) / 1000;
        if (r.cancelled || !spoke) { resolve(null); return; }
        const blob = new Blob(parts, { type });
        resolve({ data: new Uint8Array(await blob.arrayBuffer()), mime: type, seconds });
      };
    });
    timer = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      bar.style.setProperty('--level', Math.min(1, rms * 12).toFixed(2));
      micBtn.style.setProperty('--level', Math.min(1, rms * 12).toFixed(2));
      const now = performance.now();
      if (rms > SPEECH_RMS) { spoke = true; quietSince = null; if (mode && phase === 'listening') setPhase('hearing'); }
      else if (rms < QUIET_RMS) quietSince ??= now;
      if (now - started > MAX_MS) r.stop();
      else if (untilQuiet && spoke && quietSince && now - quietSince > QUIET_MS) r.stop();
      else if (!spoke && now - started > NO_SPEECH_MS) r.stop();
    }, 60);
    mr.start(250);
    r.done = done;
    return r;
  }

  async function hear(clip) {
    if (!clip) return '';
    const res = await api.invoke('ai:voice-transcribe', clip);
    if (res.error) { notice(res.error); return null; }
    return res.text.trim();
  }

  // ---------------------------------------------------------------- dictation
  micBtn.addEventListener('click', async () => {
    if (mode) { stopMode(); return; }
    if (rec) { rec.stop(); return; }
    if (starting) return;
    if (!isReady()) { notice('Sign in to Lumio to use your voice.'); return; }
    starting = true;
    rec = await record({ untilQuiet: true });
    starting = false;
    if (!rec) return;
    setPhase('idle');
    micBtn.classList.add('on');
    micBtn.title = 'Stop dictating';
    const clip = await rec.done;
    rec = null;
    micBtn.classList.remove('on');
    micBtn.title = 'Dictate';
    if (!clip) return;
    micBtn.classList.add('busy');
    const text = await hear(clip);
    micBtn.classList.remove('busy');
    if (!text) return;
    prompt.value = prompt.value.trim() ? `${prompt.value.trimEnd()} ${text}` : text;
    autosize();
    prompt.focus();
    prompt.setSelectionRange(prompt.value.length, prompt.value.length);
  });

  // ---------------------------------------------------------------- voice mode
  async function listenLoop() {
    while (mode) {
      setPhase('listening');
      rec = await record({ untilQuiet: true });
      if (!rec) { stopMode(); return; }
      const clip = await rec.done;
      rec = null;
      if (!mode) return;
      if (!clip) continue; // nothing said yet: keep listening
      setPhase('thinking');
      const text = await hear(clip);
      if (!mode) return;
      if (text === null) { stopMode(); return; }
      if (!text) continue;
      replyBuf = '';
      const res = await submit(text);
      if (!res?.ok) { stopMode(); return; }
      waitingFor ??= res.chatId;
      return; // the reply's 'end' event speaks it, then listening starts again
    }
  }

  function startMode() {
    if (!isReady()) { notice('Sign in to Lumio to use voice mode.'); return; }
    if (rec) rec.stop(true);
    mode = true;
    listenLoop();
  }
  function stopMode() {
    mode = false;
    waitingFor = null;
    rec?.stop(true);
    rec = null;
    player?.stop();
    setPhase('idle');
  }
  modeBtn.addEventListener('click', () => (mode ? stopMode() : startMode()));
  bar.querySelector('.vb-end').addEventListener('click', stopMode);
  bar.querySelector('.vb-orb').addEventListener('click', () => {
    if (phase === 'speaking') { player?.stop(); return; } // interrupt: listen again
    if (rec) rec.stop(); // done talking
  });

  // Reads a reply aloud, a piece at a time (the next piece loads while one plays).
  async function say(text) {
    const list = pieces(speakable(text));
    if (!list.length) return;
    setPhase('speaking');
    let stopped = false;
    let current = null;
    player = { stop() { stopped = true; current?.pause(); current?.dispatchEvent(new Event('ended')); } };
    let next = api.invoke('ai:voice-speak', { text: list[0] });
    for (let i = 0; i < list.length && !stopped; i++) {
      const res = await next;
      if (i + 1 < list.length) next = api.invoke('ai:voice-speak', { text: list[i + 1] });
      if (stopped) break;
      if (res.error) { notice(res.error); break; }
      const url = URL.createObjectURL(new Blob([res.audio], { type: 'audio/mpeg' }));
      current = new Audio(url);
      await new Promise((resolve) => {
        current.addEventListener('ended', resolve, { once: true });
        current.addEventListener('error', resolve, { once: true });
        current.play().catch(resolve);
      });
      URL.revokeObjectURL(url);
    }
    player = null;
  }

  setPhase('idle');

  return {
    // Every ai-event for the open chat.
    onEvent(ev) {
      if (mode && phase === 'thinking' && !waitingFor && ev.type === 'user') waitingFor = ev.chatId; // our message, before submit() returned
      if (!mode || ev.chatId !== waitingFor) return;
      if (ev.type === 'text') replyBuf += ev.delta || '';
      if (ev.type === 'step') replyBuf = ''; // only the answer after the last action is read
      if (ev.type === 'approval') setPhase('thinking');
      if (ev.type === 'end') {
        waitingFor = null;
        const text = replyBuf;
        replyBuf = '';
        (async () => {
          if (mode && text.trim()) await say(text);
          if (mode) listenLoop();
        })();
      }
    },
    stop: () => { if (mode) stopMode(); else rec?.stop(true); },
  };
}
