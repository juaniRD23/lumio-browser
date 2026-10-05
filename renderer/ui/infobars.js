// Bars across the top of the page, like Chrome's infobars: "Restore pages?"
// after Lumio didn't shut down correctly, and "Lumio isn't your default
// browser". main/infobars.js says which to show and handles the buttons.
// Each bar has its buttons and a close button; Esc on a bar closes it.
import { icons } from './icons.js';

const ICONS = {
  restore: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v4.5h4.5"/></svg>',
  'default-browser': icons.globe,
};

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function initInfobars({ api }) {
  const box = document.getElementById('infobars');
  let shown = '';
  function render(bars) {
    const list = Array.isArray(bars) ? bars : [];
    const html = list.map((b) => `
      <div class="infobar lumio-bar" data-bar="${esc(b.id)}" role="group" aria-label="${esc(b.title || b.text)}">
        <span class="infobar-ic">${ICONS[b.id] || icons.info}</span>
        <span class="infobar-text">${b.title ? `<b>${esc(b.title)}</b> ` : ''}${esc(b.text)}</span>
        <span class="spacer"></span>
        ${(b.actions || []).map((a) => `<button class="btn ${a.primary ? 'primary' : 'ghost'}" data-action="${esc(a.id)}">${esc(a.label)}</button>`).join('')}
        <button class="icon-btn small infobar-x" data-close aria-label="Close" title="Close">${icons.x}</button>
      </div>`).join('');
    if (html === shown) return;
    shown = html;
    box.innerHTML = html;
  }
  const answer = (bar, action) => api.send('window:infobar', { id: bar.dataset.bar, action });
  box.addEventListener('click', (e) => {
    const bar = e.target.closest('.lumio-bar');
    const btn = e.target.closest('button');
    if (!bar || !btn) return;
    answer(bar, btn.hasAttribute('data-close') ? null : btn.dataset.action);
  });
  box.addEventListener('keydown', (e) => {
    const bar = e.target.closest('.lumio-bar');
    if (e.key !== 'Escape' || !bar) return;
    e.preventDefault();
    answer(bar, null);
    api.send('tab:focus-page');
  });
  // Bars set before this window's UI loaded come with the first answer.
  let told = false;
  api.on('infobars', (bars) => { told = true; render(bars); });
  api.invoke('shell:infobars').then((bars) => { if (!told) render(bars); }).catch(() => {});
}
