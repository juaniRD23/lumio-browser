// Reading mode: the article on the current page, laid out for reading in a
// view on the right, with its own font, size, spacing and theme, and Read
// aloud in Lumio's voice (the same speech as the AI panel: ai:voice-speak,
// charged to the weekly allowance) with the sentence being read highlighted.
// main/reader.js finds the article; it arrives as HTML and is sanitized here
// to plain article markup (no scripts, styles, ids or classes of its own).
//
// createReaderView() is self-contained, so another container (a side panel)
// can host it; initReadingMode() gives it its own column next to the page for
// now, with a button in the address bar.
import DOMPurify from '/vendor/purify.js';

const SIZES = [13, 14, 15, 16, 17, 18, 20, 22, 24, 28];
const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
const SPACING = { tight: 1.45, normal: 1.65, loose: 1.9 };
const DEFAULTS = { font: 'sans', size: 17, spacing: 'normal', theme: 'auto', speed: 1 };
const CHUNK = 480; // characters per spoken piece (whole sentences); the next one loads while one plays
// Article markup only: no forms, media players, frames, styles, ids or classes.
const PURIFY = {
  ALLOWED_TAGS: ['a', 'abbr', 'article', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'picture', 'pre', 'q', 's', 'samp', 'section', 'small', 'source', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul'],
  ALLOWED_ATTR: ['href', 'src', 'srcset', 'sizes', 'alt', 'title', 'width', 'height', 'colspan', 'rowspan', 'lang', 'dir', 'datetime', 'cite', 'start', 'reversed'],
  ALLOW_DATA_ATTR: false,
};
// Where sentences live: text is split into sentences inside each of these.
const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, figcaption, td, th, dd, dt, caption, summary, div, section, article, header, footer, figure';

const svg = (d, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const BOOK = svg('<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v14a1.5 1.5 0 0 0-1.5-1.5H4z"/><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v14a1.5 1.5 0 0 1 1.5-1.5H20z"/>', 16);
const I = {
  close: svg('<path d="M7 7l10 10M17 7L7 17"/>', 14),
  play: svg('<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>', 16),
  pause: svg('<rect x="6.5" y="5.5" width="3.8" height="13" rx="1" fill="currentColor" stroke="none"/><rect x="13.7" y="5.5" width="3.8" height="13" rx="1" fill="currentColor" stroke="none"/>', 16),
  prev: svg('<path d="M18 6.5v11l-8-5.5z" fill="currentColor"/><path d="M7 6v12"/>', 16),
  next: svg('<path d="M6 6.5v11l8-5.5z" fill="currentColor"/><path d="M17 6v12"/>', 16),
  spin: svg('<path d="M20 12a8 8 0 1 1-8-8"/>', 16),
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const stripHash = (u) => String(u || '').split('#')[0];

// Wraps each sentence of the article in <span class="rs" data-s="n"> (a
// sentence that crosses a link or bold text gets one span per piece, all with
// the same number) and returns the sentences in reading order. Code and the
// "site · 4 min read" line aren't read aloud.
export function wrapSentences(root, lang) {
  let seg;
  try { seg = new Intl.Segmenter(lang || undefined, { granularity: 'sentence' }); } catch { seg = new Intl.Segmenter(undefined, { granularity: 'sentence' }); }
  // Group the text by the block it belongs to (code is never read aloud).
  const groups = new Map();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (!parent || parent.closest('pre, code, script, style, .rd-site') || !n.data.trim()) continue;
    const near = parent.closest(BLOCKS);
    const block = near && root.contains(near) ? near : root;
    if (!groups.has(block)) groups.set(block, []);
    groups.get(block).push(n);
  }
  const sentences = [];
  for (const nodes of groups.values()) {
    let full = '';
    const at = nodes.map((n) => { const start = full.length; full += n.data; return start; });
    const ranges = [];
    for (const s of seg.segment(full)) {
      const text = s.segment.replace(/\s+/g, ' ').trim();
      if (!/[\p{L}\p{N}]/u.test(text)) continue;
      ranges.push({ start: s.index, end: s.index + s.segment.length, k: sentences.length });
      sentences.push({ text });
    }
    nodes.forEach((n, i) => {
      const start = at[i];
      const end = start + n.data.length;
      const parts = ranges.filter((r) => r.start < end && r.end > start);
      if (!parts.length) return;
      const frag = document.createDocumentFragment();
      let pos = start;
      for (const r of parts) {
        const a = Math.max(r.start, start);
        const b = Math.min(r.end, end);
        if (a > pos) frag.append(n.data.slice(pos - start, a - start));
        const span = document.createElement('span');
        span.className = 'rs';
        span.dataset.s = String(r.k);
        span.textContent = n.data.slice(a - start, b - start);
        frag.append(span);
        pos = b;
      }
      if (pos < end) frag.append(n.data.slice(pos - start));
      n.replaceWith(frag);
    });
  }
  return sentences;
}

// The reading view: header, settings, the article and the Read aloud bar.
// onClose: the person closed it (× or Esc). Its host loads articles with
// loading() and show(reader:article's answer), and hears a 'reader-retry'
// event on the view's element when the person asks to try a page again.
export function createReaderView({ api, onClose = () => {} }) {
  const el = document.createElement('div');
  el.className = 'rd';
  el.innerHTML = `
    <div class="rd-head">
      <span class="rd-ic">${BOOK}</span><span class="rd-name">Reading mode</span><span class="spacer"></span>
      <button type="button" class="rd-btn" data-rd="settings" aria-expanded="false" aria-controls="rd-settings" title="Text and theme" aria-label="Text and theme"><span class="rd-aa" aria-hidden="true">Aa</span></button>
      <button type="button" class="rd-btn" data-rd="close" title="Close reading mode (Esc)" aria-label="Close reading mode">${I.close}</button>
    </div>
    <div class="rd-settings" id="rd-settings" role="group" aria-label="Text and theme" hidden>
      <div class="rd-row"><span class="rd-label" id="rd-font-l">Font</span>
        <div class="rd-seg" role="radiogroup" aria-labelledby="rd-font-l" data-pref="font"><button type="button" role="radio" data-v="sans">Sans</button><button type="button" role="radio" data-v="serif" class="rd-serif">Serif</button></div></div>
      <div class="rd-row"><span class="rd-label" id="rd-size-l">Size</span>
        <div class="rd-size" role="group" aria-labelledby="rd-size-l"><button type="button" data-rd="smaller" aria-label="Smaller text" title="Smaller text">A<sup>−</sup></button><span class="rd-size-v" aria-live="polite"></span><button type="button" data-rd="larger" aria-label="Larger text" title="Larger text">A<sup>+</sup></button></div></div>
      <div class="rd-row"><span class="rd-label" id="rd-sp-l">Spacing</span>
        <div class="rd-seg" role="radiogroup" aria-labelledby="rd-sp-l" data-pref="spacing"><button type="button" role="radio" data-v="tight">Tight</button><button type="button" role="radio" data-v="normal">Normal</button><button type="button" role="radio" data-v="loose">Loose</button></div></div>
      <div class="rd-row"><span class="rd-label" id="rd-th-l">Theme</span>
        <div class="rd-seg rd-themes" role="radiogroup" aria-labelledby="rd-th-l" data-pref="theme">
          <button type="button" role="radio" data-v="auto" title="Same as Lumio"><i class="sw sw-auto" aria-hidden="true"><b></b><b></b></i>Auto</button><button type="button" role="radio" data-v="light"><i class="sw sw-light" aria-hidden="true"></i>Light</button><button type="button" role="radio" data-v="dark"><i class="sw sw-dark" aria-hidden="true"></i>Dark</button><button type="button" role="radio" data-v="sepia"><i class="sw sw-sepia" aria-hidden="true"></i>Sepia</button>
        </div></div>
    </div>
    <div class="rd-scroll" tabindex="0" aria-label="Article">
      <div class="rd-state" aria-live="polite"></div>
      <article class="rd-article"></article>
    </div>
    <div class="rd-player" role="group" aria-label="Read aloud">
      <button type="button" class="rd-btn" data-rd="prev" title="Previous sentence" aria-label="Previous sentence">${I.prev}</button>
      <button type="button" class="rd-play" data-rd="play"><span class="rd-pi"></span><span class="rd-pl"></span></button>
      <button type="button" class="rd-btn" data-rd="next" title="Next sentence" aria-label="Next sentence">${I.next}</button>
      <span class="rd-status" aria-live="polite"></span>
      <select class="rd-speed" data-rd="speed" aria-label="Reading speed" title="Reading speed">${SPEEDS.map((s) => `<option value="${s}">${s}×</option>`).join('')}</select>
    </div>`;
  const $ = (sel) => el.querySelector(sel);
  const scroller = $('.rd-scroll');
  const article = $('.rd-article');
  const stateEl = $('.rd-state');
  const settings = $('.rd-settings');
  const settingsBtn = $('[data-rd="settings"]');
  const playBtn = $('[data-rd="play"]');
  const statusEl = $('.rd-status');

  let prefs = { ...DEFAULTS };
  let page = null; // { url, tabId } of what's shown
  let sentences = [];

  // ---------------------------------------------------------------- settings
  function applyPrefs() {
    el.dataset.theme = prefs.theme;
    el.dataset.font = prefs.font;
    el.style.setProperty('--rd-size', `${prefs.size}px`);
    el.style.setProperty('--rd-lh', String(SPACING[prefs.spacing] || SPACING.normal));
    el.querySelectorAll('.rd-seg').forEach((g) => {
      g.querySelectorAll('[role=radio]').forEach((b) => {
        const on = b.dataset.v === prefs[g.dataset.pref];
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      });
    });
    $('.rd-size-v').textContent = String(prefs.size);
    $('[data-rd="smaller"]').disabled = prefs.size <= SIZES[0];
    $('[data-rd="larger"]').disabled = prefs.size >= SIZES.at(-1);
    $('.rd-speed').value = String(prefs.speed);
    if (audio) audio.playbackRate = prefs.speed;
  }
  function setPref(key, value) {
    if (prefs[key] === value) return;
    prefs = { ...prefs, [key]: value };
    applyPrefs();
    api.send('reader:set-prefs', { [key]: value });
  }
  function toggleSettings(show = settings.hidden) {
    settings.hidden = !show;
    settingsBtn.setAttribute('aria-expanded', String(show));
    settingsBtn.classList.toggle('on', show);
    if (show) settings.querySelector('[role=radio][tabindex="0"]')?.focus();
  }
  // Arrow keys move through each set of choices (radio buttons).
  el.querySelectorAll('.rd-seg').forEach((g) => g.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const items = [...g.querySelectorAll('[role=radio]')];
    const next = items[(items.indexOf(document.activeElement) + step + items.length) % items.length];
    next.focus();
    next.click();
  }));

  // ---------------------------------------------------------------- read aloud
  let audio = null;
  let audioUrl = null;
  let mode = 'idle'; // idle | loading | playing | paused
  let at = 0; // the sentence being read (or next to read)
  let run = 0; // bumps whenever reading jumps or stops, so late answers are ignored
  const cache = new Map(); // first sentence -> its piece's audio (promise)

  function setMode(m, note = '') {
    mode = m;
    const label = { idle: 'Read aloud', loading: 'Loading…', playing: 'Pause', paused: 'Resume' }[m];
    playBtn.querySelector('.rd-pi').innerHTML = m === 'playing' ? I.pause : m === 'loading' ? I.spin : I.play;
    playBtn.querySelector('.rd-pl').textContent = label;
    playBtn.setAttribute('aria-label', m === 'idle' ? 'Read aloud' : label);
    playBtn.classList.toggle('busy', m === 'loading');
    el.classList.toggle('reading', m !== 'idle');
    statusEl.textContent = note;
    const none = !sentences.length;
    playBtn.disabled = none;
    $('[data-rd="prev"]').disabled = none;
    $('[data-rd="next"]').disabled = none;
  }
  function stopAudio() {
    if (audio) { audio.pause(); audio.removeAttribute('src'); }
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audio = null;
    audioUrl = null;
  }
  // Marks sentence k (null clears), scrolling it into view when it's off screen.
  function mark(k, scroll = false) {
    el.querySelectorAll('.rs.on').forEach((s) => s.classList.remove('on'));
    if (k == null) return;
    const spans = el.querySelectorAll(`.rs[data-s="${k}"]`);
    spans.forEach((s) => s.classList.add('on'));
    if (!scroll || !spans[0]) return;
    const r = spans[0].getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    if (r.top < box.top + 40 || r.bottom > box.bottom - 40) spans[0].scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }
  // Whole sentences from `from`, up to CHUNK characters, with where each one
  // starts in the audio (by length, plus a little for the pause after it).
  function chunkFrom(from) {
    let to = from;
    let len = 0;
    while (to < sentences.length && (to === from || len + sentences[to].text.length <= CHUNK)) len += sentences[to++].text.length + 1;
    const weights = sentences.slice(from, to).map((s) => s.text.length + 12);
    const total = weights.reduce((a, b) => a + b, 0);
    let acc = 0;
    const starts = weights.map((w) => { const s = acc / total; acc += w; return s; });
    return { from, to, starts, text: sentences.slice(from, to).map((s) => s.text).join(' ') };
  }
  function audioFor(c) {
    if (!cache.has(c.from)) {
      cache.set(c.from, api.invoke('ai:voice-speak', { text: c.text }).catch(() => ({ error: 'Couldn’t reach Lumio. Check your connection.' })));
      while (cache.size > 6) cache.delete(cache.keys().next().value);
    }
    return cache.get(c.from);
  }
  async function speakFrom(k) {
    const mine = ++run;
    stopAudio();
    if (k >= sentences.length) { at = 0; mark(null); setMode('idle', 'Finished'); return; }
    at = k;
    mark(k, true);
    setMode('loading');
    const c = chunkFrom(k);
    const res = await audioFor(c);
    if (mine !== run) return;
    if (res?.error || !res?.audio) {
      cache.delete(c.from);
      setMode('idle', res?.error || 'Couldn’t read this aloud.');
      return;
    }
    audioUrl = URL.createObjectURL(new Blob([res.audio], { type: 'audio/mpeg' }));
    const a = new Audio(audioUrl);
    audio = a;
    a.playbackRate = prefs.speed;
    a.addEventListener('timeupdate', () => {
      if (mine !== run || !a.duration) return;
      const f = a.currentTime / a.duration;
      let i = 0;
      while (i + 1 < c.starts.length && c.starts[i + 1] <= f) i++;
      if (c.from + i !== at) { at = c.from + i; mark(at, true); }
    });
    a.addEventListener('ended', () => { if (mine === run) speakFrom(c.to); });
    a.addEventListener('error', () => { if (mine === run) { stopAudio(); setMode('idle', 'Lumio’s voice couldn’t play. Check your sound output.'); } });
    try { await a.play(); } catch (err) {
      if (mine === run && err?.name !== 'AbortError') { stopAudio(); setMode('idle', 'Lumio’s voice couldn’t play. Check your sound output.'); }
      return;
    }
    if (mine !== run) return;
    setMode('playing');
    if (c.to < sentences.length) audioFor(chunkFrom(c.to)); // the next piece loads while this one plays
  }
  // The first sentence on screen, where reading starts when nothing was read yet.
  function firstOnScreen() {
    const top = scroller.getBoundingClientRect().top;
    const span = [...el.querySelectorAll('.rs')].find((s) => s.getBoundingClientRect().bottom > top + 8);
    return span ? Number(span.dataset.s) : 0;
  }
  function play() {
    if (mode === 'playing') { audio?.pause(); setMode('paused'); return; }
    if (mode === 'paused' && audio) { audio.play().then(() => setMode('playing')).catch(() => speakFrom(at)); return; }
    if (mode === 'loading') { run++; setMode('idle'); return; }
    speakFrom(mode === 'paused' || at > 0 ? at : firstOnScreen());
  }
  function skip(step) {
    if (!sentences.length) return;
    const k = Math.max(0, Math.min(sentences.length - 1, at + step));
    if (mode === 'playing' || mode === 'loading') { speakFrom(k); return; }
    at = k;
    mark(k, true);
    if (mode === 'paused') { run++; stopAudio(); } // Resume starts at the new sentence
  }
  function stop() {
    run++;
    stopAudio();
    at = 0;
    mark(null);
    setMode('idle');
  }

  // ---------------------------------------------------------------- content
  function showState(html) {
    stop();
    article.innerHTML = '';
    sentences = [];
    stateEl.innerHTML = html;
    stateEl.hidden = false;
    setMode('idle');
  }
  function loading() {
    if (mode !== 'idle') return; // keep reading what's open until the new page is ready
    showState('<div class="rd-skel" aria-label="Loading the article"><i></i><i></i><i></i><i></i><i></i></div>');
  }
  function show(res) {
    if (res?.prefs) { prefs = { ...DEFAULTS, ...res.prefs }; applyPrefs(); }
    page = { url: res?.url || '', tabId: res?.tabId ?? null };
    if (!res?.ok) {
      showState(`<div class="rd-empty">${BOOK}<p class="rd-empty-t">Reading mode isn’t available for this page</p><p>${esc(res?.reason || 'Lumio couldn’t find an article here.')}</p><button type="button" class="rd-again" data-rd="again">Try again</button></div>`);
      return;
    }
    stop();
    cache.clear();
    const a = res.article;
    const words = String(a.content.replace(/<[^>]+>/g, ' ')).split(/\s+/).filter(Boolean).length;
    const meta = [a.siteName || hostOf(page.url), `${Math.max(1, Math.round(words / 230))} min read`].filter(Boolean).join(' · ');
    stateEl.hidden = true;
    stateEl.innerHTML = '';
    article.lang = a.lang || '';
    article.dir = a.dir === 'rtl' ? 'rtl' : 'auto';
    article.innerHTML = `<header class="rd-top"><p class="rd-site">${esc(meta)}</p><h1 class="rd-title">${esc(a.title)}</h1>${a.byline ? `<p class="rd-by">${esc(a.byline)}</p>` : ''}</header>
      <div class="rd-body">${DOMPurify.sanitize(a.content, PURIFY)}</div>`;
    article.querySelectorAll('img').forEach((img) => {
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('error', () => img.remove(), { once: true });
    });
    sentences = wrapSentences(article, a.lang);
    scroller.scrollTop = 0;
    setMode('idle');
  }

  // ---------------------------------------------------------------- input
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-rd]');
    const act = b?.dataset.rd;
    if (act === 'close') onClose({ keyboard: e.detail === 0 });
    else if (act === 'settings') toggleSettings();
    else if (act === 'smaller' || act === 'larger') {
      const i = SIZES.indexOf(prefs.size);
      const next = SIZES[Math.max(0, Math.min(SIZES.length - 1, (i < 0 ? SIZES.indexOf(DEFAULTS.size) : i) + (act === 'larger' ? 1 : -1)))];
      setPref('size', next);
    } else if (act === 'play') play();
    else if (act === 'prev') skip(-1);
    else if (act === 'next') skip(1);
    else if (act === 'again') el.dispatchEvent(new CustomEvent('reader-retry'));
    const radio = e.target.closest('.rd-seg [role=radio]');
    if (radio) setPref(radio.closest('.rd-seg').dataset.pref, radio.dataset.v);
    // Links open in a new tab; while reading aloud, a sentence you click is read from.
    const link = e.target.closest('.rd-article a[href]');
    if (link) {
      e.preventDefault();
      if (/^https?:/i.test(link.href) && stripHash(link.href) !== stripHash(page?.url)) api.send('open-url', link.href);
      return;
    }
    const s = e.target.closest('.rs');
    if (s && mode !== 'idle' && !String(getSelection()).trim()) speakFrom(Number(s.dataset.s));
  });
  $('.rd-speed').addEventListener('change', (e) => setPref('speed', Number(e.target.value)));
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (!settings.hidden) { toggleSettings(false); settingsBtn.focus(); return; }
    onClose({ keyboard: true });
  });

  applyPrefs();
  setMode('idle');
  return {
    el,
    loading,
    show,
    stop,
    // The article takes the keyboard (arrows and Page Down scroll it); the ring shows only for keyboard use.
    focus: (keyboard = false) => scroller.focus({ preventScroll: true, focusVisible: keyboard }),
    get page() { return page; },
    get sentences() { return sentences; },
    setPrefs(p) { prefs = { ...DEFAULTS, ...p }; applyPrefs(); },
  };
}

// Reading mode in its own column, right of the page, opened from the address
// bar's button, the page's right-click menu or View › Reading Mode.
export function initReadingMode({ api, activeTab, onLayout = () => {} }) {
  const host = document.createElement('aside');
  host.id = 'reader';
  host.className = 'closed';
  host.inert = true;
  host.setAttribute('aria-label', 'Reading mode');
  const view = createReaderView({ api, onClose: ({ keyboard }) => close(keyboard) });
  host.append(view.el);
  document.getElementById('workspace').insertBefore(host, document.getElementById('resizer'));
  // The page follows the column as it slides open and closed.
  host.addEventListener('transitionend', onLayout);

  const btn = document.createElement('button');
  btn.id = 'reader-btn';
  btn.className = 'icon-btn small';
  btn.hidden = true;
  btn.innerHTML = BOOK;
  document.getElementById('star').before(btn);

  let isOpen = false;
  let wanted = null; // { tabId, url } being loaded or shown
  let timer = null;

  function render() {
    const t = activeTab();
    btn.hidden = !(isOpen || (t?.readerable && !t.loading));
    btn.classList.toggle('on', isOpen);
    btn.setAttribute('aria-pressed', String(isOpen));
    btn.title = isOpen ? 'Close reading mode' : 'Reading mode';
    btn.setAttribute('aria-label', btn.title);
  }
  async function refresh(force = false) {
    const t = activeTab();
    if (!isOpen || !t) return;
    if (t.loading) { view.loading(); wanted = null; return; } // the page is changing: wait for it
    if (!force && wanted?.tabId === t.id && stripHash(wanted.url) === stripHash(t.url)) return; // same article (a #section doesn't count)
    const ask = { tabId: t.id, url: t.url };
    wanted = ask;
    view.loading();
    const res = await api.invoke('reader:article', t.id).catch(() => null);
    if (!isOpen || wanted !== ask) return; // closed, or another page came up meanwhile
    view.show(res || { ok: false, url: t.url, tabId: t.id });
  }
  function open({ keyboard = false } = {}) {
    if (!isOpen) {
      isOpen = true;
      host.inert = false;
      host.classList.remove('closed');
      onLayout();
    }
    render();
    refresh();
    view.focus(keyboard);
  }
  function close(refocus = false) {
    if (!isOpen) return;
    isOpen = false;
    wanted = null;
    view.stop();
    host.classList.add('closed');
    host.inert = true;
    onLayout();
    render();
    if (refocus && !btn.hidden) btn.focus();
  }
  const toggle = (opts) => (isOpen ? close(true) : open(opts));

  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', (e) => toggle({ keyboard: e.detail === 0 }));
  api.invoke('reader:prefs').then((p) => { if (p) view.setPrefs(p); }).catch(() => {});
  view.el.addEventListener('reader-retry', () => refresh(true));
  api.on('reader-open', ({ tabId, toggle: flip } = {}) => {
    if (flip) { toggle(); return; }
    if (tabId != null && activeTab()?.id !== tabId) return;
    if (isOpen) refresh(true); else open();
  });

  return {
    view,
    open,
    close,
    toggle,
    get isOpen() { return isOpen; },
    // Every tab change: the button, and the article for the page now showing.
    onTabs() {
      render();
      if (!isOpen) return;
      clearTimeout(timer);
      timer = setTimeout(() => refresh(), 200);
    },
  };
}
