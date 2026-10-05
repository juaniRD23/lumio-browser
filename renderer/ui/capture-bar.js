// Capture indicators (main/capture.js keeps track):
//  - a red dot on each tab using your camera, microphone or screen (drawn by
//    shell.js's tab strip, with captureWords for its label);
//  - the bar above the page when the tab you're on shares your screen, a
//    window or another tab, or is itself being shared: "Sharing this tab
//    with meet.example.com", with Stop sharing.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };

// What a tab's capture indicator says, or '' when nothing is in use.
export function captureWords(c) {
  if (!c) return '';
  const parts = [];
  const devices = [c.camera && 'camera', c.microphone && 'microphone'].filter(Boolean);
  if (devices.length) parts.push(`Using your ${devices.join(' and ')}`);
  if (c.screen) parts.push(c.screen === 'screen' ? 'Sharing your screen' : c.screen === 'window' ? 'Sharing a window' : 'Sharing another tab');
  if (c.sharedTo) parts.push(`Being shared with ${c.sharedTo}`);
  return parts.join(' · ');
}

// The bar's words for the tab you're on, as HTML, or '' for no bar.
export function barText(t) {
  const c = t?.capture;
  if (!c) return '';
  if (c.sharedTo) return `Sharing this tab with <b>${esc(c.sharedTo)}</b>`;
  if (!c.screen) return '';
  const site = `<b>${esc(hostOf(t.url) || 'this site')}</b>`;
  if (c.screen === 'screen') return `Sharing your screen with ${site}`;
  if (c.screen === 'window') return `Sharing a window with ${site}`;
  const title = String(c.screen).replace(/^tab:/, '');
  return `Sharing ${title ? `“${esc(title)}”` : 'a tab'} with ${site}`;
}

export function initCaptureBar({ api }) {
  const bar = document.getElementById('capture-bar');
  let shownFor = null;
  // From the tabs message itself: shell.js's state may not have it yet.
  api.on('tabs', (s) => {
    const t = s.tabs.find((x) => x.id === s.activeId);
    const html = barText(t);
    bar.hidden = !html;
    shownFor = html ? t.wcId : null;
    // Forget what was drawn, so the bar is drawn again when it comes back.
    if (!html) { bar.innerHTML = ''; delete bar.dataset.key; return; }
    const key = `${t.wcId}|${html}`;
    if (bar.dataset.key === key) return; // keep the button (and its focus) as it is
    bar.dataset.key = key;
    bar.innerHTML = `<i class="cb-dot" aria-hidden="true"></i><span class="cb-t">${html}</span><button type="button" class="cb-stop">Stop sharing</button>`;
  });
  bar.addEventListener('click', (e) => {
    if (!e.target.closest('.cb-stop') || shownFor == null) return;
    const btn = e.target.closest('.cb-stop');
    btn.disabled = true; // until the capture really ends
    api.send('capture:stop', shownFor);
    // Still sharing a while later (the page didn't stop): let the person try again.
    setTimeout(() => { if (btn.isConnected) btn.disabled = false; }, 5000);
  });
}
