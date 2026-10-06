// Settings › Addresses, Payment methods, and form entries (under Passwords
// and autofill). The browser side is main/autofill.js. A card's number only
// comes to this page after the person confirms it's them, to edit it.
const page = window.lumioPage;
const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const svg = (d) => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const PIN = svg('<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>');
const PENCIL = svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>');
const TRASH = svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>');

const EMPTY = { available: true, addresses: [], cards: [], entries: 0, never: { address: [], card: [] }, autofillAddresses: true, autofillCards: true, formHistory: true, platform: '' };
let st = (await page.invoke('page:autofill')) || EMPTY;
let editing = null; // { kind: 'address' | 'card', id } (id null for a new one)
let revealed = null; // { id, number } after the person confirmed it's them

const AUTH = st.platform === 'darwin' ? 'Touch ID or your Mac password' : st.platform === 'win32' ? 'Windows Hello' : 'your OK';
const expText = (c) => (c.expMonth && c.expYear ? `${String(c.expMonth).padStart(2, '0')}/${c.expYear}` : '');
const cardTitle = (c) => `${c.nickname ? `${c.nickname} · ` : ''}${c.brandName} •••• ${c.last4}`;
const addrTitle = (a) => a.name || a.street.split('\n')[0] || a.email || 'Address';

// ---------------------------------------------------------------- forms
let countries = null;
function countryOptions() {
  if (countries) return countries;
  const names = new Set();
  try {
    const dn = new Intl.DisplayNames([navigator.language || 'en'], { type: 'region' });
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (const a of A) for (const b of A) { const n = dn.of(a + b); if (n && n !== a + b && !/unknown/i.test(n)) names.add(n); }
  } catch { /* no list: typing still works */ }
  countries = [...names].sort((x, y) => x.localeCompare(y)).map((n) => `<option value="${esc(n)}">`).join('');
  return countries;
}

function addressForm(a = {}) {
  const f = (name, label, extra = '', wide = false) => `<label class="af-f${wide ? ' wide' : ''}"><span>${label}</span><input class="field" name="${name}" value="${esc(a[name])}" spellcheck="false" ${extra}></label>`;
  return `<form class="af-form" data-form="address" aria-label="${a.id ? 'Edit address' : 'New address'}">
    ${f('name', 'Name', 'maxlength="200" autocomplete="off"', true)}
    ${f('organization', 'Organization', 'maxlength="200" autocomplete="off"', true)}
    <label class="af-f wide"><span>Street address</span><textarea class="field" name="street" rows="2" maxlength="400" spellcheck="false">${esc(a.street)}</textarea></label>
    ${f('city', 'City', 'maxlength="100" autocomplete="off"')}
    ${f('state', 'State or province', 'maxlength="100" autocomplete="off"')}
    ${f('zip', 'ZIP or postal code', 'maxlength="20" autocomplete="off"')}
    ${f('country', 'Country', 'maxlength="100" autocomplete="off" list="af-countries"')}
    ${f('phone', 'Phone', 'type="tel" maxlength="40" autocomplete="off"')}
    ${f('email', 'Email', 'type="email" maxlength="200" autocomplete="off"')}
    <datalist id="af-countries">${countryOptions()}</datalist>
    <div class="af-actions wide"><span class="desc err" role="alert"></span><button type="button" class="btn ghost" data-cancel>Cancel</button><button type="submit" class="btn primary">Save</button></div>
  </form>`;
}

function cardForm(c = {}) {
  const year = new Date().getFullYear();
  const months = Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${c.expMonth === i + 1 ? 'selected' : ''}>${String(i + 1).padStart(2, '0')}</option>`).join('');
  const years = [...new Set([...(c.expYear && c.expYear < year ? [c.expYear] : []), ...Array.from({ length: 16 }, (_, i) => year + i)])]
    .map((y) => `<option value="${y}" ${c.expYear === y ? 'selected' : ''}>${y}</option>`).join('');
  const shown = revealed && revealed.id === c.id ? revealed.number : '';
  return `<form class="af-form" data-form="card" aria-label="${c.id ? 'Edit card' : 'New card'}">
    <label class="af-f wide"><span>Card number</span><span class="af-num">
      <input class="field" name="number" inputmode="numeric" autocomplete="off" spellcheck="false" maxlength="23" value="${esc(shown)}" placeholder="${c.id ? `•••• •••• •••• ${esc(c.last4)}` : '1234 5678 9012 3456'}" ${c.id ? (shown ? '' : 'aria-describedby="af-keep"') : 'required'}>
      ${c.id && !shown ? '<button type="button" class="btn" data-reveal>Show</button>' : ''}
    </span>${c.id && !shown ? '<span class="af-hint" id="af-keep">Leave it empty to keep the saved number.</span>' : ''}</label>
    <label class="af-f wide"><span>Name on card</span><input class="field" name="name" value="${esc(c.name)}" maxlength="100" autocomplete="off" spellcheck="false"></label>
    <div class="af-f"><span id="af-exp-l">Expires</span><span class="af-exp" role="group" aria-labelledby="af-exp-l">
      <select class="field" name="expMonth" aria-label="Month"><option value="">MM</option>${months}</select>
      <select class="field" name="expYear" aria-label="Year"><option value="">YYYY</option>${years}</select>
    </span></div>
    <label class="af-f"><span>Nickname (optional)</span><input class="field" name="nickname" value="${esc(c.nickname)}" maxlength="60" autocomplete="off"></label>
    <p class="af-hint wide">The security code (CVC) is never saved. You type it at checkout.</p>
    <div class="af-actions wide"><span class="desc err" role="alert"></span><button type="button" class="btn ghost" data-cancel>Cancel</button><button type="submit" class="btn primary">Save</button></div>
  </form>`;
}

// ---------------------------------------------------------------- lists
const toggle = (id, title, desc, on) => `<label class="row" style="cursor:pointer">
  <div class="grow"><div class="title">${title}</div><div class="desc">${desc}</div></div>
  <span class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} aria-label="${title}"><i></i></span></label>`;
// Sites where the person said "Never for this site", each with a way to undo it.
const neverRow = (kind) => {
  const sites = st.never?.[kind] || [];
  if (!sites.length) return '';
  const host = (x) => esc(x.replace(/^https?:\/\//, ''));
  return `<div class="row"><div class="grow"><div class="title">Never offered on</div><div class="af-sites">${sites.map((x) => `<button class="af-site" data-never="${esc(x)}" aria-label="Offer again on ${host(x)}" title="Offer again">${host(x)}<span aria-hidden="true">×</span></button>`).join('')}</div></div></div>`;
};
const noCrypto = (what) => (st.available ? '' : `<div class="row"><div class="desc err">Encryption isn’t available on this system, so Lumio can’t save ${what}.</div></div>`);
const isEditing = (kind, id) => editing && editing.kind === kind && editing.id === id;

function renderAddresses() {
  const rows = st.addresses.map((a) => `<div class="row af-item">
      <span class="af-ic">${PIN}</span>
      <div class="grow"><div class="title">${esc(addrTitle(a))}</div><div class="desc">${esc([a.summary, a.phone, a.email].filter((x) => x && x !== addrTitle(a)).join(' · '))}</div></div>
      <button class="btn icon-btn" data-edit="${esc(a.id)}" aria-label="Edit ${esc(addrTitle(a))}" title="Edit">${PENCIL}</button>
      <button class="btn icon-btn danger" data-delete="${esc(a.id)}" aria-label="Delete ${esc(addrTitle(a))}" title="Delete">${TRASH}</button>
    </div>${isEditing('address', a.id) ? addressForm(a) : ''}`).join('');
  $('#addr-card').innerHTML = `
    ${toggle('af-addresses', 'Save and fill addresses', 'Lumio offers to save addresses you enter in forms, and fills one in when you pick it under a field.', st.autofillAddresses)}
    ${noCrypto('addresses')}${rows}${neverRow('address')}${isEditing('address', null) ? addressForm() : `
    <div class="row"><div class="grow desc">${st.addresses.length ? '' : 'No saved addresses yet.'}</div><button class="btn" data-add ${st.available ? '' : 'disabled'}>Add address</button></div>`}`;
}

function renderCards() {
  const rows = st.cards.map((c) => `<div class="row af-item">
      <span class="af-brand" aria-hidden="true">${esc(c.brand === 'card' ? 'Card' : c.brand === 'amex' ? 'Amex' : c.brandName)}</span>
      <div class="grow"><div class="title">${esc(cardTitle(c))}${c.expired ? ' <span class="pill bad">Expired</span>' : ''}</div><div class="desc">${esc([c.name, expText(c) && `Expires ${expText(c)}`].filter(Boolean).join(' · '))}</div></div>
      <button class="btn icon-btn" data-edit="${esc(c.id)}" aria-label="Edit ${esc(cardTitle(c))}" title="Edit">${PENCIL}</button>
      <button class="btn icon-btn danger" data-delete="${esc(c.id)}" aria-label="Delete ${esc(cardTitle(c))}" title="Delete">${TRASH}</button>
    </div>${isEditing('card', c.id) ? cardForm(c) : ''}`).join('');
  $('#pay-card').innerHTML = `
    ${toggle('af-cards', 'Save and fill payment methods', `Lumio offers to save cards you use at checkout and asks for ${AUTH} before filling one. Card numbers never go to Lumio AI.`, st.autofillCards)}
    ${noCrypto('cards')}${rows}${neverRow('card')}${isEditing('card', null) ? cardForm() : `
    <div class="row"><div class="grow desc">${st.cards.length ? '' : 'No saved cards yet.'}</div><button class="btn" data-add ${st.available ? '' : 'disabled'}>Add card</button></div>`}`;
}

function renderHistory() {
  $('#form-history').checked = st.formHistory;
  $('#form-history-count').textContent = st.entries ? `${st.entries} saved ${st.entries === 1 ? 'entry' : 'entries'}. In a form, highlight one and press Shift+Delete to remove it.` : 'None saved.';
  $('#form-history-clear').disabled = !st.entries;
}

function render() {
  renderAddresses();
  renderCards();
  renderHistory();
  const form = document.querySelector('.af-form');
  form?.querySelector('input:not([type=hidden]), textarea')?.focus();
}

async function reload() {
  st = (await page.invoke('page:autofill')) || st;
  render();
}

// ---------------------------------------------------------------- actions
function wire(box, kind) {
  box.addEventListener('change', async (e) => {
    if (e.target.id === 'af-addresses' || e.target.id === 'af-cards') {
      st = (await page.invoke('page:autofill-set', kind === 'address' ? 'autofillAddresses' : 'autofillCards', e.target.checked)) || st;
    }
  });
  box.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.matches('[data-add]')) { editing = { kind, id: null }; revealed = null; render(); return; }
    if (btn.dataset.never) { st = (await page.invoke('page:autofill-never-remove', kind, btn.dataset.never)) || st; render(); box.querySelector('[data-add]')?.focus(); return; }
    if (btn.matches('[data-cancel]')) { const id = editing?.id; editing = null; revealed = null; render(); refocus(box, id); return; }
    if (btn.dataset.edit) { editing = { kind, id: btn.dataset.edit }; revealed = null; render(); return; }
    if (btn.matches('[data-reveal]')) {
      const res = await page.invoke('page:card-reveal', editing.id);
      if (!res?.ok) return;
      // Redraw with the number, keeping what was already changed in the form.
      const kept = formValues(btn.closest('form'));
      revealed = { id: editing.id, number: res.number };
      render();
      restore(box, kept);
      box.querySelector('[name=number]')?.focus();
      return;
    }
    if (btn.dataset.delete) {
      const item = kind === 'address' ? st.addresses.find((a) => a.id === btn.dataset.delete) : st.cards.find((c) => c.id === btn.dataset.delete);
      if (!item || !confirm(`Delete ${kind === 'address' ? addrTitle(item) : cardTitle(item)}?`)) return;
      await page.invoke(kind === 'address' ? 'page:address-delete' : 'page:card-delete', item.id);
      if (editing?.id === item.id) editing = null;
      await reload();
      box.querySelector('[data-add]')?.focus();
    }
  });
  box.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const values = formValues(form);
    if (kind === 'card') { values.expMonth = Number(values.expMonth) || null; values.expYear = Number(values.expYear) || null; }
    const res = await page.invoke(kind === 'address' ? 'page:address-save' : 'page:card-save', values, editing?.id || null);
    if (!res?.ok) { form.querySelector('.err').textContent = res?.error || 'Couldn’t save that.'; return; }
    const id = res.id;
    editing = null;
    revealed = null;
    await reload();
    refocus(box, id);
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.target.closest('.af-form')) { e.preventDefault(); box.querySelector('[data-cancel]')?.click(); }
  });
}
const formValues = (form) => Object.fromEntries(new FormData(form).entries());
function restore(box, values) {
  for (const [k, v] of Object.entries(values)) { const el = box.querySelector(`.af-form [name=${k}]`); if (el && k !== 'number') el.value = v; }
}
// After closing a form, the keyboard goes back to that item (or Add).
function refocus(box, id) {
  (id && box.querySelector(`[data-edit="${CSS.escape(id)}"]`) || box.querySelector('[data-add]'))?.focus();
}

wire($('#addr-card'), 'address');
wire($('#pay-card'), 'card');
$('#form-history').addEventListener('change', async (e) => { st = (await page.invoke('page:autofill-set', 'formHistory', e.target.checked)) || st; });
$('#form-history-clear').addEventListener('click', async () => {
  if (!confirm('Delete all saved form entries?')) return;
  await page.invoke('page:form-history-clear');
  await reload();
});

render();
if (['#addresses', '#payments'].includes(location.hash)) document.querySelector(location.hash).scrollIntoView();
// Saved from a page meanwhile ("Save address?"): show it when coming back.
document.addEventListener('visibilitychange', () => { if (!document.hidden && !editing) reload(); });
