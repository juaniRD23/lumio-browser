// The permission bubble under the address bar's chip (renderer/ui/
// permission-chip.js), drawn in the overlay: a site's question, a quiet
// request, or what Lumio blocked on the page. Arrow keys move between the
// buttons, Esc goes back to the chip, and the answer goes to main/features.js.
import { siteIcon } from '/assets/site-icons.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);

function html(p) {
  if (p.mode === 'ask') {
    const items = p.cats.map((c) => `<div class="pb-item">${siteIcon(c.id)}<span>${esc(c.prompt)}${p.detail ? ` <b>${esc(p.detail)}</b>` : ''}</span></div>`).join('');
    return `<div class="pb-t" id="pb-t"><span><b>${esc(p.host)}</b> wants to</span></div>
      <div class="pb-items">${items}</div>
      <div class="pb-acts">
        <button class="pb-btn" data-d="allow">${p.once ? 'Allow while visiting the site' : 'Allow'}</button>
        ${p.once ? '<button class="pb-btn" data-d="once">Allow this time</button>' : ''}
        <button class="pb-btn" data-d="block">Don’t allow</button>
      </div>`;
  }
  if (p.mode === 'quiet') {
    const c = p.cats[0];
    return `<div class="pb-t" id="pb-t">${siteIcon(c.id, { blocked: true })}<span>${esc(c.blocked)}</span></div>
      <p class="pb-note"><b>${esc(p.host)}</b> wants to ${esc(lower(c.prompt))}. Lumio keeps these requests quiet until you allow them.</p>
      <div class="pb-acts">
        <button class="pb-btn" data-d="allow">Allow for this site</button>
        <button class="pb-btn" data-d="dismiss">Continue blocking</button>
      </div>
      <button class="pb-link" data-manage="${esc(c.id)}">Manage</button>`;
  }
  const one = p.blocked.length === 1;
  const items = p.blocked.map((b) => `<div class="pb-item">${siteIcon(b.cat, { blocked: true })}<span>${esc(b.note)}</span>${one ? '' : `<button class="pb-mini" data-allow="${esc(b.cat)}" aria-label="Allow ${esc(lower(b.label.replace(/ blocked$/, '')))} for this site">Allow</button>`}</div>`).join('');
  return `<div class="pb-t" id="pb-t">${one ? esc(p.blocked[0].label) : 'Blocked on this page'}</div>
    <div class="pb-items">${items}</div>
    <div class="pb-acts">
      ${one ? `<button class="pb-btn" data-allow="${esc(p.blocked[0].cat)}">Allow for this site</button>` : ''}
      <button class="pb-btn" data-close>Done</button>
    </div>
    <button class="pb-link" data-manage="${esc(p.blocked[0].cat)}">Manage</button>`;
}

export function permissionBubble({ api, card }) {
  let current = null;

  card.addEventListener('click', (e) => {
    if (!current) return;
    const btn = e.target.closest('button');
    if (!btn) return;
    const keyboard = e.detail === 0; // Enter or Space
    if (btn.dataset.d) {
      api.send('permission:respond', { id: current.id, decision: btn.dataset.d });
      api.send('overlay:pick', { kind: 'permission', id: current.id, keyboard });
    } else if (btn.dataset.allow) {
      api.send('permission:allow-blocked', { wcId: current.wcId, cat: btn.dataset.allow });
      api.send('overlay:pick', { kind: 'permission', allowed: btn.dataset.allow, keyboard });
    } else if (btn.dataset.manage) {
      api.send('permission:manage', btn.dataset.manage);
      api.send('overlay:pick', { kind: 'permission' });
    } else if ('close' in btn.dataset) {
      api.send('overlay:pick', { kind: 'permission', keyboard });
    }
  });

  card.addEventListener('keydown', (e) => {
    if (!current) return;
    if (e.key === 'Escape') { e.preventDefault(); api.send('permission:bubble-closed', { refocus: true }); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const buttons = [...card.querySelectorAll('button')];
    const i = buttons.indexOf(document.activeElement);
    buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  });

  return {
    show(payload) {
      current = payload;
      card.innerHTML = `<div class="pb" role="dialog" aria-labelledby="pb-t">${html(payload)}</div>`;
      if (payload.focus) requestAnimationFrame(() => card.querySelector('button')?.focus());
    },
    hide() { current = null; },
  };
}
