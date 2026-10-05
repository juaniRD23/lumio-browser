// Choosers drawn in the overlay, over the tab that asked:
//  - device: a site wants a USB, HID, serial or Bluetooth device
//    (main/device-chooser.js). Pick one and Connect, or Cancel.
//  - clientcert: a site asks you to prove who you are with a certificate
//    (main/certificates.js). Pick one (its details can be opened) and OK,
//    or Cancel to send none.
// The list works like a listbox: arrow keys move, Enter confirms, Esc
// cancels. The answer goes to main/security.js ('security:choose').
import { siteIcon } from '/assets/site-icons.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const date = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
const KINDS = new Set(['device', 'clientcert']);

function deviceHtml(d, selected) {
  const items = d.items.map((it) => `<div class="sc-opt" role="option" id="sc-o-${esc(it.id)}" data-id="${esc(it.id)}" aria-selected="${it.id === selected}">
      <span class="sc-ic">${siteIcon(d.kind)}</span><span class="sc-txt"><b>${esc(it.name)}</b>${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span></div>`).join('');
  const empty = d.scanning ? '<div class="sc-empty"><span class="sc-spin" aria-hidden="true"></span>Looking for devices…</div>' : '<div class="sc-empty">No compatible devices found.</div>';
  return `<div class="sc-t" id="sc-t"><b>${esc(d.host)}</b> wants to connect to ${esc(d.what)}</div>
    <div class="sc-list" role="listbox" tabindex="0" aria-labelledby="sc-t">${items || empty}</div>
    <div class="sc-acts"><button class="acc-btn ghost" data-act="cancel">Cancel</button><button class="acc-btn primary" data-act="ok" ${selected ? '' : 'disabled'}>Connect</button></div>`;
}

function certHtml(c, selected, open) {
  const items = c.items.map((it) => `<div class="sc-opt" role="option" id="sc-o-${it.index}" data-id="${it.index}" aria-selected="${String(it.index) === selected}">
      <span class="sc-ic">${siteIcon('certificate')}</span><span class="sc-txt"><b>${esc(it.subject)}</b><small>${esc(it.issuer ? `Issued by ${it.issuer}` : '')}${it.validExpiry ? ` · Valid until ${esc(date(it.validExpiry))}` : ''}</small></span></div>`).join('');
  const cur = c.items.find((it) => String(it.index) === selected);
  const row = (k, v) => (v ? `<dt>${k}</dt><dd>${v}</dd>` : '');
  const details = cur ? `<dl class="sc-dl">
      ${row('Issued to', esc(cur.subjectLines.join(', ') || cur.subject))}
      ${row('Issued by', esc(cur.issuerLines.join(', ') || cur.issuer))}
      ${row('Valid from', esc(date(cur.validStart)))}
      ${row('Valid until', esc(date(cur.validExpiry)))}
      ${row('Serial number', `<code>${esc(cur.serial)}</code>`)}
      ${row('Fingerprint', `<code>${esc(cur.fingerprint)}</code>`)}
    </dl>` : '';
  return `<div class="sc-t" id="sc-t"><b>${esc(c.host)}</b> wants you to sign in with a certificate</div>
    <p class="sc-d">Choose one to identify yourself to the site. It stays chosen for this site until you quit Lumio.</p>
    <div class="sc-list" role="listbox" tabindex="0" aria-labelledby="sc-t">${items}</div>
    <button class="sc-link" data-act="details" aria-expanded="${open}" aria-controls="sc-details" ${cur ? '' : 'disabled'}>${open ? 'Hide certificate details' : 'Certificate details'}</button>
    <div class="sc-details" id="sc-details" ${open ? '' : 'hidden'}>${details}</div>
    <div class="sc-acts"><button class="acc-btn ghost" data-act="cancel">Cancel</button><button class="acc-btn primary" data-act="ok" ${cur ? '' : 'disabled'}>OK</button></div>`;
}

// onResize(): the chooser's height changed (the overlay measures itself again).
export function securityChoosers({ api, card, onResize = () => {} }) {
  let current = null; // { kind, data }
  let selected = '';
  let detailsOpen = false;

  const list = () => card.querySelector('.sc-list');
  function render({ keepFocus = false } = {}) {
    const hadFocus = keepFocus && card.contains(document.activeElement) ? (document.activeElement.dataset.act || 'list') : null;
    const body = current.kind === 'device' ? deviceHtml(current.data, selected) : certHtml(current.data, selected, detailsOpen);
    card.innerHTML = `<div class="sc" role="dialog" aria-labelledby="sc-t">${body}</div>`;
    const l = list();
    if (selected && l) l.setAttribute('aria-activedescendant', `sc-o-${selected}`);
    if (hadFocus) (hadFocus === 'list' ? l : card.querySelector(`[data-act="${hadFocus}"]`))?.focus();
  }
  function select(id) {
    selected = id;
    render({ keepFocus: true });
    if (!card.contains(document.activeElement)) list()?.focus();
    card.querySelector('.sc-opt[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }
  function answer(value) {
    if (!current) return;
    const id = current.data.id;
    const kind = current.kind;
    current = null;
    api.send('security:choose', { kind, id, value });
  }
  const confirm = () => {
    if (!selected) return;
    answer(current.kind === 'device' ? selected : Number(selected));
  };

  card.addEventListener('click', (e) => {
    if (!current) return;
    const opt = e.target.closest('.sc-opt');
    if (opt) { if (e.detail >= 2 && opt.dataset.id === selected) confirm(); else select(opt.dataset.id); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'ok') confirm();
    else if (act === 'cancel') answer(null);
    else if (act === 'details') { detailsOpen = !detailsOpen; render({ keepFocus: true }); onResize(); }
  });

  card.addEventListener('keydown', (e) => {
    if (!current) return;
    if (e.key === 'Escape') { e.preventDefault(); answer(null); return; }
    const inList = e.target.closest?.('.sc-list');
    if (e.key === 'Enter' && inList) { e.preventDefault(); confirm(); return; }
    if (!inList || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const ids = [...card.querySelectorAll('.sc-opt')].map((o) => o.dataset.id);
    if (!ids.length) return;
    const i = ids.indexOf(selected);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : i < 0 ? 0 : Math.max(0, Math.min(ids.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    select(ids[next]);
  });

  return {
    owns: (kind) => KINDS.has(kind),
    // True when the payload is one of these choosers (then it's drawn).
    show(payload) {
      if (!KINDS.has(payload.kind)) { current = null; return false; }
      const data = payload.kind === 'device' ? payload.device : payload.cert;
      const same = current && current.kind === payload.kind && current.data.id === data.id;
      if (!same) {
        // A certificate is always chosen (the first); a device only when the person picks one.
        selected = payload.kind === 'clientcert' && data.items.length ? String(data.items[0].index) : '';
        detailsOpen = false;
      } else if (payload.kind === 'device' && !data.items.some((it) => it.id === selected)) {
        selected = ''; // the chosen device went away while the list was open
      }
      current = { kind: payload.kind, data };
      render({ keepFocus: same });
      if (payload.focus) requestAnimationFrame(() => list()?.focus());
      return true;
    },
  };
}
