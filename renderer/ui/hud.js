// The status bubble and the swipe arrow over the page (see hud.html and
// main/page-hud.js). Each tells main how big it is, so its view is never
// bigger than what it shows (a view over the page takes its clicks).
import { elideUrl, displayUrl } from './elide.mjs';

const api = window.lumio;
const kind = new URLSearchParams(location.search).get('kind') || 'status';
const body = document.body;
body.classList.add(kind);
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const size = (width, height) => api?.send('hud:size', { width, height });

// ---------------------------------------------------------------- status bubble
// Chrome's timing: shown a moment after the pointer reaches a link, hidden a
// moment after it leaves (so moving between links doesn't flicker), and
// widened to the whole address if the pointer stays.
const SHOW_DELAY = 80;
const HIDE_DELAY = 250;
const FADE_OUT = 200;
const EXPAND_DELAY = 1600;
const PAD = 6; // room for the shadow, beside and above the bubble (hud.css)

const bubble = document.getElementById('bubble');
const text = bubble.querySelector('.t');
const ctx = document.createElement('canvas').getContext('2d');
let shown = false;
let url = '';
let showTimer = 0;
let hideTimer = 0;
let expandTimer = 0;
let width = 0; // what the bubble may take now

const measure = (s) => { ctx.font = getComputedStyle(text).font; return ctx.measureText(s).width; };

// Writes the address, shortened to fit, and reports the bubble's size.
// Returns whether it had to be shortened.
function render(max) {
  width = max;
  const full = displayUrl(url);
  const sides = bubble.offsetWidth - text.offsetWidth; // padding and border
  const room = Math.max(40, max - PAD - sides);
  text.style.setProperty('--max', `${room}px`);
  text.textContent = elideUrl(full, room, measure);
  size(Math.ceil(bubble.getBoundingClientRect().width) + PAD, Math.ceil(bubble.getBoundingClientRect().height) + PAD);
  return text.textContent !== full;
}

function hide() {
  clearTimeout(expandTimer);
  shown = false;
  body.classList.remove('on');
  hideTimer = setTimeout(() => { if (!shown && !url) size(0, 0); }, reduced.matches ? 0 : FADE_OUT);
}

function status({ url: next, side, now, maxWidth, expandedWidth }) {
  if (side) body.dataset.side = side;
  if (next === undefined) return; // only the corner changed
  clearTimeout(hideTimer);
  clearTimeout(expandTimer);
  url = next || '';
  if (!url) {
    clearTimeout(showTimer);
    // Not on screen yet, or another tab took over: gone at once.
    if (!shown || now) { shown = false; body.classList.remove('on'); size(0, 0); return; }
    hideTimer = setTimeout(hide, HIDE_DELAY);
    return;
  }
  const cut = render(maxWidth);
  if (!shown) {
    clearTimeout(showTimer);
    showTimer = setTimeout(() => { shown = true; body.classList.add('on'); }, SHOW_DELAY);
  }
  if (cut) expandTimer = setTimeout(() => { if (url) render(expandedWidth); }, EXPAND_DELAY);
}
// The font arrives a moment after the first address: measure again with it.
document.fonts.ready.then(() => { if (url && width) render(width); });

// ---------------------------------------------------------------- swipe arrow
let swipeTimer = 0;
function swipe({ swipe: s, done }) {
  clearTimeout(swipeTimer);
  if (s) {
    body.dataset.dir = s.dir;
    body.style.setProperty('--p', String(Math.max(0, Math.min(1, s.progress))));
    body.classList.toggle('ready', s.progress >= 1);
    body.classList.remove('done');
    body.classList.add('on');
    return;
  }
  // Let go: it slides back out, or fades where it is when the page changes.
  body.classList.remove('on');
  body.classList.toggle('done', !!done);
  if (!done) body.style.setProperty('--p', '0');
  swipeTimer = setTimeout(() => { body.classList.remove('ready', 'done'); size(0, 0); }, reduced.matches ? 0 : 180);
}

api?.on('hud', (d = {}) => (kind === 'status' ? status(d) : swipe(d)));
