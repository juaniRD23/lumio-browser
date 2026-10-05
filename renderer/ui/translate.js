// The Translate button in the address bar. It shows when a page isn't in a
// language you read (main/translate.js decides) and opens the translate
// bubble, which the overlay draws (renderer/ui/overlay-translate.js) because
// it hangs over the page. It also lights up while the page is translated.
const ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 6h9M8 4v2c0 4-2.2 7.2-5 8.5"/><path d="M5.5 9.5c1 2.2 3 3.9 5.5 4.6"/><path d="M12.5 20l4-9.5 4 9.5M14 16.8h5"/></svg>';
const SHOWN = ['offer', 'translating', 'translated', 'error', 'signin'];
const WIDTH = 340;

// overlay: the shell's dropdown view — { kind, open(kind, rect, payload), close(), picked() }.
export function initTranslate({ api, activeTab, overlay, isTyping = () => false, getAccent = () => null }) {
  const btn = document.createElement('button');
  btn.id = 'translate-btn';
  btn.className = 'icon-btn small';
  btn.hidden = true;
  btn.innerHTML = ICON;
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.setAttribute('aria-expanded', 'false');
  document.getElementById('star').before(btn);
  let openFor = null; // the tab the bubble is open on

  function render() {
    const t = activeTab();
    if (openFor != null && (overlay.kind !== 'translate' || t?.id !== openFor)) { // closed, or another tab came up
      if (overlay.kind === 'translate') overlay.picked();
      openFor = null;
    }
    const s = t?.translate?.status;
    btn.hidden = !(SHOWN.includes(s) || (openFor != null && t?.id === openFor));
    btn.classList.toggle('on', s === 'translated' || s === 'translating');
    btn.classList.toggle('busy', s === 'translating');
    btn.classList.toggle('err', s === 'error');
    const label = s === 'translated' ? 'Translated · show the original or change the language'
      : s === 'translating' ? 'Translating this page…'
        : s === 'error' ? 'Couldn’t translate this page' : 'Translate this page';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-expanded', String(openFor != null));
  }

  async function open({ focus = false } = {}) {
    const t = activeTab();
    if (!t) return;
    const payload = await api.invoke('translate:bubble', t.id);
    if (!payload || activeTab()?.id !== t.id) return;
    btn.hidden = false; // the bubble hangs from the button
    const r = btn.getBoundingClientRect();
    overlay.open('translate', { x: r.right - WIDTH - 12 + 8, y: r.bottom + 8, width: WIDTH + 24, height: 320 }, { ...payload, focus, accent: getAccent() });
    openFor = t.id;
    if (focus) api.send('translate:focus');
    render();
  }
  function close() {
    if (overlay.kind === 'translate') overlay.close();
    openFor = null;
    render();
  }

  btn.addEventListener('mousedown', (e) => e.preventDefault()); // the address bar keeps focus
  // detail is 0 when Enter or Space pressed the button: keys then go to the bubble.
  btn.addEventListener('click', (e) => (overlay.kind === 'translate' ? close() : open({ focus: e.detail === 0 })));
  window.addEventListener('mousedown', (e) => { if (overlay.kind === 'translate' && !e.target.closest('#translate-btn')) close(); });
  // Found a page in another language (or the menu's Translate Page…).
  api.on('translate-prompt', ({ tabId, force } = {}) => {
    if (activeTab()?.id !== tabId) return;
    if (!force && (overlay.kind || isTyping())) return;
    open({ focus: !!force });
  });
  api.on('overlay-picked', (msg) => {
    if (msg?.kind !== 'translate') return;
    overlay.picked();
    openFor = null;
    render();
    if (msg.refocus) btn.focus();
  });

  return { render, open, close };
}
