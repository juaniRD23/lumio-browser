// The account page: profile, plan and allowance, connections, plans with
// upgrade/switch (Stripe Checkout or the billing portal), billing and sign-out.
import { appLogo } from '/applook.js';
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DESCS = {
  free: 'Try Lumio AI in Chat and the browser, a little every week.',
  plus: 'Thousands of messages and browser tasks a week, about 100 pictures, and Claude Sonnet, GPT-6.1 Sol, Gemini and Grok in Chat.',
  pro: 'About 6× Plus, and every model, including Claude Opus and GPT-6 Astra.',
  max: 'About 12× Plus, and every model.',
};
const ORDER = ['free', 'plus', 'pro', 'max'];

function showError(text) { const e = $('#error'); e.hidden = !text; e.textContent = text || ''; }

async function post(url, body = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'That didn’t work. Try again.');
  return data;
}

function avatar(el, a) {
  const name = a.profile?.name || a.email || '?';
  el.innerHTML = a.profile?.picture ? `<img src="${esc(a.profile.picture)}" alt="" referrerpolicy="no-referrer">` : esc(name.trim()[0]?.toUpperCase() || '?');
}

function renderUsage(u) {
  $('#plan-name').textContent = `Lumio ${u.planName}`;
  const when = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  $('#meters').innerHTML = (u.windows || []).map((w) => {
    const left = w.limit ? Math.max(0, Math.round((w.remaining / w.limit) * 100)) : 0;
    const full = w.used > 0 && w.fullAt ? ` · fully refilled by ${esc(when(w.fullAt))}` : '';
    return `<div class="meter"><div class="row"><span>${esc(w.label)}</span><span>${left}% left${full}</span></div><div class="bar"><i style="width:${left}%"></i></div></div>`;
  }).join('');
}

// Connections: Google Drive, Gmail, Calendar; Outlook, OneDrive (Word, PowerPoint, Excel).
async function renderConnections() {
  const data = await fetch('/api/connections').then((r) => r.json()).catch(() => null);
  const apps = data?.apps || [];
  $('#conn-list').innerHTML = apps.map((a) => `<div class="conn">${appLogo(a.id)}<span class="cn"><b>${esc(a.name)}</b><small>${esc(a.connected ? `Connected${a.account ? ` as ${a.account}` : ''}` : a.blurb)}</small></span>
    ${a.connected ? `<button class="btn small" data-off="${a.id}">Disconnect</button>` : a.available ? `<a class="btn small" href="/api/connect/${a.id}/start?next=${encodeURIComponent('/account')}">Connect</a>` : '<span class="email">Soon</span>'}</div>`).join('') || '<div class="email">Couldn’t load connections.</div>';
  $('#conn-list').querySelectorAll('[data-off]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    await post(`/api/connections/${b.dataset.off}/disconnect`).catch((err) => showError(err.message));
    renderConnections();
  }));
}

function renderPlans(plans, current, wanted) {
  $('#plan-cards').innerHTML = plans.map((p) => {
    const here = p.id === current;
    const higher = ORDER.indexOf(p.id) > ORDER.indexOf(current);
    const action = here ? '<button class="btn small" disabled>Your plan</button>'
      : p.id === 'free' ? (current !== 'free' ? '<button class="btn small" data-portal>Cancel in billing</button>' : '')
        : `<button class="btn small ${higher ? 'accent' : ''}" data-plan="${p.id}">${current === 'free' ? `Get ${esc(p.name)}` : higher ? `Upgrade to ${esc(p.name)}` : `Switch to ${esc(p.name)}`}</button>`;
    return `<article class="plan ${here ? 'current' : ''} ${wanted === p.id && !here ? 'wanted' : ''}">
      <div class="p-name">${esc(p.name)}</div>
      <div class="p-price">$${p.price}<small>${p.price ? ' / month' : ''}</small></div>
      <div class="p-desc">${esc(DESCS[p.id] || '')}</div>
      ${action}
    </article>`;
  }).join('');
  $('#plan-cards').querySelectorAll('[data-plan]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    b.textContent = 'Opening Stripe…';
    try { location.href = (await post('/api/billing/checkout', { plan: b.dataset.plan })).url; } catch (err) { showError(err.message); b.disabled = false; renderAll(); }
  }));
  $('#plan-cards').querySelectorAll('[data-portal]').forEach((b) => b.addEventListener('click', openPortal));
}

async function openPortal() {
  try { location.href = (await post('/api/billing/portal')).url; } catch (err) { showError(err.message); }
}

let plansList = null;
async function renderAll() {
  const [account, usage] = await Promise.all([fetch('/api/account').then((r) => r.json()), fetch('/api/usage').then((r) => r.json())]);
  if (!account.signedIn) { location.replace('/signin?next=' + encodeURIComponent(location.pathname + location.search + location.hash)); return null; }
  plansList ??= (await fetch('/api/billing/plans').then((r) => r.json())).plans;
  $('#page').hidden = false;
  avatar($('#avatar'), account);
  $('#name').textContent = account.profile?.name || account.email;
  $('#email').textContent = account.email;
  const u = usage.usage;
  renderUsage(u);
  const p = account.plan || {};
  const when = p.renewsAt ? new Date(p.renewsAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const status = u.plan === 'free' ? null
    : p.status === 'canceling' ? { text: when ? `Ends ${when}` : 'Ends at period end', warn: true }
      : p.status === 'past_due' ? { text: 'Payment issue: update your card in billing', warn: true }
        : when ? { text: `Renews ${when}` } : null;
  $('#plan-status').hidden = !status;
  $('#plan-status').textContent = status?.text || '';
  $('#plan-status').classList.toggle('warn', !!status?.warn);
  $('#billing').hidden = u.plan === 'free';
  const wanted = new URLSearchParams(location.search).get('plan');
  renderPlans(plansList, u.plan, wanted);
  return u;
}

$('#billing').addEventListener('click', openPortal);
$('#sign-out').addEventListener('click', async () => {
  await post('/api/auth', { action: 'logout' }).catch(() => {});
  location.href = '/';
});

(async () => {
  const q = new URLSearchParams(location.search);
  let u = await renderAll();
  if (!u) return;
  renderConnections();
  if (q.has('connected') || q.has('connect_error')) {
    $('#welcome').hidden = false;
    $('#welcome').textContent = q.has('connected') ? 'Connected. Lumio can use it in Chat and in Lumio Browser when you ask.' : 'That app wasn’t connected. Try again, and allow access when asked.';
    history.replaceState(null, '', '/account#connections');
    document.getElementById('connections').scrollIntoView({ behavior: 'smooth' });
  }
  if (q.has('upgraded') || q.has('changed')) {
    // Stripe tells us about the new plan a moment later; wait for it.
    const before = u.plan;
    $('#welcome').hidden = false;
    $('#welcome').textContent = 'Thanks! Updating your plan…';
    for (let i = 0; i < 10 && u.plan === before && q.has('upgraded') && before === 'free'; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      u = await renderAll();
    }
    $('#welcome').textContent = u.plan === 'free' ? 'Payment received. Your plan will update in a moment; refresh if it doesn’t.' : `You’re on Lumio ${u.planName}. Enjoy!`;
    history.replaceState(null, '', '/account');
  }
  if (location.hash === '#plans' || q.get('plan')) document.getElementById('plans').scrollIntoView({ behavior: 'smooth' });
})();
