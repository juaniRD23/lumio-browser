// The address bar's Share button. Its popover hangs over the page, so the
// overlay view draws it (renderer/ui/overlay-share.js); main/share.js does
// the sharing. The menus, the right-click menu's QR codes and websites'
// Share buttons open it too (the 'share-open' message).
import { SHARE_ICON } from './overlay-share.js';

const WIDTH = 320;
const shareable = (url) => /^(https?|file):/i.test(url || '');

// overlay: the shell's dropdown view — { kind, open(kind, rect, payload), close(), picked() }.
export function initShare({ api, activeTab, overlay, getAccent = () => null }) {
  const btn = document.createElement('button');
  btn.id = 'share-btn';
  btn.className = 'icon-btn small';
  btn.hidden = true;
  btn.innerHTML = SHARE_ICON;
  btn.title = 'Share';
  btn.setAttribute('aria-label', 'Share this page');
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.setAttribute('aria-expanded', 'false');
  document.getElementById('star').before(btn);
  let openFor = null; // the tab the popover is open on

  function render() {
    const t = activeTab();
    if (openFor != null && (overlay.kind !== 'share' || t?.id !== openFor)) { // closed, or another tab came up
      if (overlay.kind === 'share') overlay.picked();
      openFor = null;
    }
    btn.hidden = !(shareable(t?.url) || openFor != null);
    btn.classList.toggle('on', openFor != null);
    btn.setAttribute('aria-expanded', String(openFor != null));
  }

  async function open({ view = 'main', focus = false, url, title } = {}) {
    const t = activeTab();
    if (!t) return;
    btn.hidden = false; // the popover hangs from the button
    const r = btn.getBoundingClientRect();
    const payload = await api.invoke('share:info', { tabId: t.id, view, url, title, anchor: { x: r.left, y: r.bottom + 4 } });
    if (!payload || activeTab()?.id !== t.id) { render(); return; }
    overlay.open('share', { x: r.right - WIDTH - 12 + 8, y: r.bottom + 8, width: WIDTH + 24, height: 380 }, { ...payload, focus, accent: getAccent() });
    openFor = t.id;
    if (focus) api.send('share:focus');
    render();
  }
  function close() {
    if (overlay.kind === 'share') overlay.close();
    openFor = null;
    render();
  }

  btn.addEventListener('mousedown', (e) => e.preventDefault()); // the address bar keeps focus
  // detail is 0 when Enter or Space pressed the button: keys then go to the popover.
  btn.addEventListener('click', (e) => (overlay.kind === 'share' ? close() : open({ focus: e.detail === 0 })));
  window.addEventListener('mousedown', (e) => { if (overlay.kind === 'share' && !e.target.closest('#share-btn')) close(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlay.kind === 'share') { e.preventDefault(); close(); } });
  api.on('share-open', ({ tabId, view, url, title } = {}) => {
    if (activeTab()?.id !== tabId) return;
    open({ view, url, title, focus: true });
  });
  api.on('overlay-picked', (msg) => {
    if (msg?.kind !== 'share') return;
    overlay.picked();
    openFor = null;
    render();
    if (msg.refocus && !btn.hidden) btn.focus();
  });

  return { render, open, close };
}
