// The "Performance issues" popup under the toolbar button (renderer/ui/perf.js):
// which background tabs use the most, with Fix now (they go to sleep, like
// Memory Saver does) and Not now. Buttons work with the keyboard too.
import { icons } from './icons.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mb = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`);

export function renderPerf(card, { alert, focus }) {
  const rows = alert.tabs.map((t) => `
    <div class="pf-tab">
      <span class="pf-fav">${t.favicon && /^(https?:|data:image\/)/.test(t.favicon) ? `<img src="${esc(t.favicon)}" alt="">` : icons.globe}</span>
      <span class="pf-main"><span class="pf-title">${esc(t.title)}</span><span class="pf-host">${esc(t.host)}</span></span>
      <span class="pf-use">${t.memory >= 512 * 1024 ** 2 || t.cpu < 50 ? esc(mb(t.memory)) : `${t.cpu}% CPU`}</span>
    </div>`).join('');
  const more = alert.count > alert.tabs.length ? `<div class="pf-more">and ${alert.count - alert.tabs.length} more</div>` : '';
  card.innerHTML = `<div role="dialog" aria-labelledby="pf-title">
    <div class="pf-head" id="pf-title">${icons.pulse}<span>Performance issues</span></div>
    <p class="pf-sub">${alert.count === 1 ? 'This tab is' : 'These tabs are'} using a lot of memory or power in the background, which can slow Lumio down.</p>
    <div class="pf-list">${rows}${more}</div>
    <div class="pws-actions">
      <button class="acc-btn ghost" data-pf="settings">Settings</button>
      <span style="flex:1"></span>
      <button class="acc-btn ghost" data-pf="dismiss">Not now</button>
      <button class="acc-btn primary" data-pf="fix">Fix now</button>
    </div></div>`;
  card.querySelectorAll('.pf-fav img').forEach((img) => { img.onerror = () => { img.outerHTML = icons.globe; }; });
  if (focus) card.querySelector('[data-pf=fix]').focus();
}

// Clicks (and Enter or Space on a focused button) in the popup. The browser
// closes the popup.
export function perfAction(e, api) {
  const act = e.target.closest('[data-pf]')?.dataset.pf;
  if (act) api.send(`perf:${act}`);
}
