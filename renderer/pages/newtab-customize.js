// Customize Lumio: a side sheet on the New Tab page (like Chrome's Customize
// Chrome) for the theme, the accent color, the page's background and what it
// shows. The main process keeps the choices (main/customize.js).
import { THEME_COLORS, accentFor, setAccent } from '/assets/theme-colors.js';

const page = window.lumioPage;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BACKGROUNDS = [
  { id: 'none', name: 'None' },
  { id: 'aurora', name: 'Aurora' },
  { id: 'dusk', name: 'Dusk' },
  { id: 'meadow', name: 'Meadow' },
];
const COLOR_NAMES = { blue: 'Blue', purple: 'Purple', green: 'Green', orange: 'Orange', pink: 'Pink', mono: 'Graphite' };
const PEN = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>';
const IMG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m20.5 16-5-5-8.5 8.5"/></svg>';
const CLOSE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>';

let state = null;

// The page as chosen: background, accent, and which sections show.
function apply() {
  const root = document.documentElement;
  setAccent(root, accentFor(state.theme));
  // A new background fades in (the keyframes alternate so the fade replays).
  if (document.body.dataset.bg && document.body.dataset.bg !== state.background) document.body.classList.toggle('bg-swap');
  document.body.dataset.bg = state.background;
  if (state.background === 'custom' && state.image) document.body.style.setProperty('--nt-image', `url("${state.image}")`);
  else document.body.style.removeProperty('--nt-image');
  document.body.classList.toggle('no-shortcuts', !state.shortcuts);
  document.body.classList.toggle('no-recent', !state.recent);
}

function sheetHtml() {
  const radio = (name, value, checked, label, inner = '', cls = '') => `<label class="${cls}" title="${esc(label)}"><input type="radio" name="${name}" value="${esc(value)}" ${checked ? 'checked' : ''} aria-label="${esc(label)}">${inner}</label>`;
  return `
    <div class="cz-head">
      <h2 id="cz-title">Customize Lumio</h2>
      <button type="button" class="cz-close" aria-label="Close" title="Close (Esc)">${CLOSE}</button>
    </div>
    <div class="cz-body">
      <section>
        <h3 id="cz-theme-h">Theme</h3>
        <div class="cz-seg" role="radiogroup" aria-labelledby="cz-theme-h">
          ${[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([v, n]) => radio('cz-appearance', v, state.appearance === v, n, `<span>${n}</span>`)).join('')}
        </div>
      </section>
      <section>
        <h3 id="cz-color-h">Color</h3>
        <div class="cz-swatches" role="radiogroup" aria-labelledby="cz-color-h">
          ${Object.entries(THEME_COLORS).map(([id, c]) => radio('cz-color', id, state.theme === id, COLOR_NAMES[id] || id, `<i style="--sw-light:${c.light};--sw-dark:${c.dark}"></i>`)).join('')}
        </div>
      </section>
      <section>
        <h3 id="cz-bg-h">Background</h3>
        <div class="cz-bgs" role="radiogroup" aria-labelledby="cz-bg-h">
          ${BACKGROUNDS.map((b) => radio('cz-bg', b.id, state.background === b.id, b.name, `<i class="bg-${b.id}"></i><span>${b.name}</span>`)).join('')}
          ${radio('cz-bg', 'custom', state.background === 'custom', 'Your image', `<i class="bg-custom"${state.image ? ` style="background-image:url('${state.image}')"` : ''}>${state.image ? '' : IMG}</i><span>Your image</span>`)}
        </div>
        <button type="button" class="btn small cz-upload">${IMG}<span>${state.image ? 'Choose another image…' : 'Upload an image…'}</span></button>
        <p class="cz-note" role="status"></p>
      </section>
      <section>
        <h3>New Tab page</h3>
        <label class="cz-row"><span>Show shortcuts</span><span class="switch"><input type="checkbox" data-key="shortcuts" ${state.shortcuts ? 'checked' : ''}><i></i></span></label>
        <label class="cz-row"><span>Show “Pick up where you left off”</span><span class="switch"><input type="checkbox" data-key="recent" ${state.recent ? 'checked' : ''}><i></i></span></label>
      </section>
    </div>`;
}

export async function initCustomize() {
  state = await page.invoke('page:customize').catch(() => null);
  if (!state) return;
  apply();

  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'cz-open';
  button.className = 'cz-open';
  button.innerHTML = `${PEN}<span>Customize</span>`;
  button.setAttribute('aria-haspopup', 'dialog');
  const scrim = document.createElement('div');
  scrim.className = 'cz-scrim';
  const sheet = document.createElement('aside');
  sheet.id = 'cz-sheet';
  sheet.className = 'cz-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', 'cz-title');
  sheet.hidden = true;
  scrim.hidden = true;
  document.body.append(button, scrim, sheet);

  const outside = () => [...document.body.children].filter((el) => el !== sheet && el !== scrim && el.tagName !== 'SCRIPT');
  let closing = 0;
  function open() {
    clearTimeout(closing);
    sheet.innerHTML = sheetHtml();
    sheet.hidden = false;
    scrim.hidden = false;
    outside().forEach((el) => { el.inert = true; });
    button.setAttribute('aria-expanded', 'true');
    sheet.getBoundingClientRect(); // start from the closed place, then slide
    sheet.classList.add('open');
    scrim.classList.add('open');
    (sheet.querySelector('input:checked') || sheet.querySelector('.cz-close')).focus({ preventScroll: true });
  }
  function close() {
    if (sheet.hidden) return;
    sheet.classList.remove('open');
    scrim.classList.remove('open');
    outside().forEach((el) => { el.inert = false; });
    button.setAttribute('aria-expanded', 'false');
    button.focus({ preventScroll: true });
    // Hidden once it has slid out (the exit is shorter than the entrance).
    const ms = parseFloat(getComputedStyle(sheet).transitionDuration) * 1000 || 0;
    closing = setTimeout(() => { sheet.hidden = true; scrim.hidden = true; }, ms + 20);
  }
  button.addEventListener('click', open);
  scrim.addEventListener('click', close);
  sheet.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
  sheet.addEventListener('click', async (e) => {
    if (e.target.closest('.cz-close')) close();
    else if (e.target.closest('.cz-upload')) pickImage();
  });

  async function set(key, value) {
    state = await page.invoke('page:customize-set', key, value);
    apply();
  }
  async function pickImage() {
    const next = await page.invoke('page:customize-image');
    if (!next) return;
    state = next;
    apply();
    const focused = document.activeElement?.className;
    sheet.innerHTML = sheetHtml();
    sheet.querySelector(`.${focused === 'btn small cz-upload' ? 'cz-upload' : 'cz-close'}`)?.focus();
    if (next.error) sheet.querySelector('.cz-note').textContent = next.error;
  }
  sheet.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'cz-appearance') set('appearance', t.value);
    else if (t.name === 'cz-color') set('theme', t.value);
    else if (t.name === 'cz-bg') {
      if (t.value === 'custom' && !state.image) { pickImage(); return; }
      set('background', t.value);
    } else if (t.dataset.key) set(t.dataset.key, t.checked);
  });
}
