// The toolbar's media button: it shows while a tab plays sound (in any
// window), with moving bars while something plays, and opens the media
// controls popover (renderer/ui/overlay-media.js; main/media.js does the work).
import { NOTE_ICON } from './overlay-media.js';

const WIDTH = 340;

// activeTab(): switching tabs closes the popover (main hides it).
export function initMedia({ api, overlay, activeTab = () => null, getAccent = () => null }) {
  const btn = document.createElement('button');
  btn.id = 'media-btn';
  btn.className = 'icon-btn';
  btn.hidden = true;
  btn.innerHTML = `${NOTE_ICON}<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>`;
  btn.title = 'Media controls';
  btn.setAttribute('aria-label', 'Media controls');
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.setAttribute('aria-expanded', 'false');
  document.getElementById('downloads').before(btn);
  let state = { count: 0, playing: false };
  let openedOn = null; // the tab in front when the popover opened

  function render() {
    if (overlay.kind === 'media' && activeTab()?.id !== openedOn) overlay.picked();
    const open = overlay.kind === 'media';
    btn.hidden = !state.count && !open;
    btn.classList.toggle('playing', !!state.playing);
    btn.classList.toggle('on', open);
    btn.setAttribute('aria-expanded', String(open));
    btn.title = state.playing ? 'Media controls · playing' : 'Media controls';
  }
  async function open({ focus = false } = {}) {
    const items = await api.invoke('media:list').catch(() => []);
    const r = btn.getBoundingClientRect();
    openedOn = activeTab()?.id ?? null;
    overlay.open('media', { x: r.right - WIDTH - 12 + 6, y: r.bottom + 2, width: WIDTH + 24, height: 200 + (items?.length || 0) * 120 }, { kind: 'media', items, focus, accent: getAccent() });
    if (focus) api.send('media:focus');
    render();
  }
  function close() {
    if (overlay.kind === 'media') overlay.close();
    render();
  }

  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', (e) => (overlay.kind === 'media' ? close() : open({ focus: e.detail === 0 })));
  window.addEventListener('mousedown', (e) => { if (overlay.kind === 'media' && !e.target.closest('#media-btn')) close(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlay.kind === 'media') { e.preventDefault(); close(); } });
  const apply = (s) => {
    state = { count: Number(s?.count) || 0, playing: !!s?.playing };
    if (!state.count && overlay.kind === 'media') close(); // nothing left to control
    render();
  };
  api.on('media', apply);
  api.invoke('media:state').then(apply).catch(() => {}); // a new window, while another plays
  api.on('overlay-picked', (msg) => {
    if (msg?.kind !== 'media') return;
    overlay.picked();
    render();
    if (msg.refocus && !btn.hidden) btn.focus();
  });

  return { render, open, close };
}
