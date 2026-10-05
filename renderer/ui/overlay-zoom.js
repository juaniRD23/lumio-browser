// The zoom bubble under the address bar (shell.js opens it): the page's zoom
// with −, + and Reset, like Chrome's. Opened by zooming, it goes away by
// itself after a moment, unless the pointer or the keyboard is on it.
const CLOSE_AFTER = 1500;

let api = null;
let kindNow = () => null;
let auto = false;
let hovered = false;
let timer = 0;

function close(refocus = false) {
  clearTimeout(timer);
  if (kindNow() === 'zoom') api.send('overlay:pick', { kind: 'zoom', refocus });
}
function restart() {
  clearTimeout(timer);
  if (auto && !hovered) timer = setTimeout(() => close(), CLOSE_AFTER);
}

export function renderZoom(card, { percent, auto: closesItself, focus }) {
  auto = !!closesItself;
  hovered = card.matches(':hover'); // the last bubble may have closed under the pointer
  const had = card.contains(document.activeElement) ? document.activeElement.dataset.zoom : null;
  card.innerHTML = `
    <div class="zoom-row" role="group" aria-label="Page zoom">
      <span class="zoom-pct" aria-live="polite">${Number(percent) || 100}%</span>
      <button class="zoom-btn" data-zoom="-1" title="Zoom out" aria-label="Zoom out">−</button>
      <button class="zoom-btn" data-zoom="1" title="Zoom in" aria-label="Zoom in">+</button>
      <button class="acc-btn ghost zoom-reset" data-zoom="0">Reset</button>
    </div>`;
  // Pressing + again and again keeps the keyboard on +.
  const target = (had && card.querySelector(`[data-zoom="${had}"]`)) || (focus && card.querySelector('[data-zoom]'));
  if (target) target.focus();
  restart();
}

export function initZoom(card, bridge, getKind) {
  api = bridge;
  kindNow = getKind;
  card.addEventListener('click', (e) => {
    const btn = getKind() === 'zoom' && e.target.closest('[data-zoom]');
    if (btn) api.send('tab:zoom', Number(btn.dataset.zoom));
  });
  card.addEventListener('mouseenter', () => { hovered = true; clearTimeout(timer); });
  card.addEventListener('mouseleave', () => { hovered = false; if (getKind() === 'zoom') restart(); });
  card.addEventListener('focusin', () => clearTimeout(timer));
  document.addEventListener('keydown', (e) => {
    if (getKind() !== 'zoom') return;
    if (e.key === 'Escape') { e.preventDefault(); close(true); return; }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const buttons = [...card.querySelectorAll('[data-zoom]')];
    const i = buttons.indexOf(document.activeElement);
    e.preventDefault();
    buttons[(i + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  });
}
