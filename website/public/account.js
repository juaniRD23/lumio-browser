// The account page: profile, plan and allowance, connections, plans with
// upgrade/switch (Stripe Checkout or the billing portal), billing and sign-out.
import { appLogo } from '/applook.js';
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DESCS = {
  free: 'Try Lumio AI in Chat and the browser, a little every week.',
  go: 'Thousands of messages, about 120 browser tasks and 55 pictures a week, with GPT-6 Luna, Ling and DeepSeek.',
  plus: 'Thousands of messages and hundreds of browser tasks a week, about 100 pictures, and Claude Sonnet, GPT-6.1 Sol, Gemini and Grok in Chat.',
  pro: 'About 6× Plus, and every model, including Claude Opus and GPT-6 Astra.',
  max: 'About 11× Plus, and every model.',
};
const ORDER = ['free', 'go', 'plus', 'pro', 'max'];

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

// Why people cancel (the server sends the same list to Stripe as feedback).
const REASONS = [
  ['too_expensive', 'It costs too much'], ['unused', 'I don’t use it enough'], ['missing_features', 'It’s missing something I need'],
  ['low_quality', 'Lumio AI’s answers or actions weren’t good enough'], ['too_complex', 'It’s hard to use'],
  ['switched_service', 'I’m switching to another app'], ['customer_service', 'I had a billing or support problem'], ['other', 'Something else'],
];

// viaCode: the plan came from a code (not paid), so any plan can still be bought.
function renderPlans(plans, current, wanted, canceling, viaCode = false) {
  $('#plan-cards').innerHTML = plans.map((p) => {
    const here = p.id === current;
    const higher = ORDER.indexOf(p.id) > ORDER.indexOf(current);
    const action = here ? (canceling ? `<button class="btn small accent" data-resume>Keep ${esc(p.name)}</button>` : '<button class="btn small" disabled>Your plan</button>')
      : p.id === 'free' ? (current !== 'free' && !canceling && !viaCode ? '<button class="btn small" data-cancel>Cancel plan</button>' : '')
        : `<button class="btn small ${higher ? 'accent' : ''}" data-plan="${p.id}">${current === 'free' || viaCode ? `Get ${esc(p.name)}` : higher ? `Upgrade to ${esc(p.name)}` : `Switch to ${esc(p.name)}`}</button>`;
    return `<article class="plan ${here ? 'current' : ''} ${wanted === p.id && !here ? 'wanted' : ''}">
      <div class="p-name">${esc(p.name)}</div>
      <div class="p-price">$${p.price}<small>${p.price ? ' / month' : ''}</small></div>
      <div class="p-desc">${esc(DESCS[p.id] || '')}</div>
      ${action}
    </article>`;
  }).join('');
  $('#plan-cards').querySelectorAll('[data-plan]').forEach((b) => b.addEventListener('click', async () => {
    const plan = b.dataset.plan;
    // Free: Lumio's own payment page. Subscribed: switch in place, after a second click to confirm.
    if (current === 'free' || viaCode) { location.href = `/checkout?plan=${plan}`; return; }
    if (!b.dataset.sure) {
      b.dataset.sure = '1';
      const up = ORDER.indexOf(plan) > ORDER.indexOf(current);
      b.textContent = up ? 'Confirm: pay the difference now' : 'Confirm switch';
      b.title = up ? 'You pay the difference for the rest of this month now, and the bigger allowance starts right away.' : 'Your allowance changes now; the unused part of this month is credited to your next bill.';
      return;
    }
    b.disabled = true;
    b.textContent = 'Switching…';
    try {
      await post('/api/billing/change', { plan });
      notice(`You’re on Lumio ${plans.find((p) => p.id === plan)?.name || plan} now.`);
      await renderAll();
    } catch (err) { showError(err.message); renderAll(); }
  }));
  $('#plan-cards').querySelector('[data-cancel]')?.addEventListener('click', () => { $('#cancel-panel').hidden = false; $('#cancel-panel').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  $('#plan-cards').querySelector('[data-resume]')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { await post('/api/billing/resume'); notice('Your plan continues. Nothing else changes.'); await renderAll(); } catch (err) { showError(err.message); renderAll(); }
  });
}

function notice(text) { const n = $('#welcome'); n.hidden = false; n.textContent = text; showError(''); }

// The cancel form: why, then cancel at the end of the paid month.
$('#cancel-reasons').innerHTML = REASONS.map(([id, label]) => `<label class="reason"><input type="radio" name="reason" value="${id}"><span>${esc(label)}</span></label>`).join('');
$('#cancel-keep').addEventListener('click', () => { $('#cancel-panel').hidden = true; });
$('#cancel-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const reason = new FormData(e.target).get('reason');
  if (!reason) { $('#cancel-msg').textContent = 'Choose a reason first. It helps us make Lumio better.'; return; }
  const go = $('#cancel-go');
  go.disabled = true;
  try {
    const r = await post('/api/billing/cancel', { reason, comment: $('#cancel-comment').value });
    $('#cancel-panel').hidden = true;
    e.target.reset();
    notice(r.endsAt ? `Canceled. You keep your plan until ${new Date(r.endsAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}, then you’re on Free. Thanks for the feedback.` : 'Canceled. Thanks for the feedback.');
    await renderAll();
  } catch (err) { $('#cancel-msg').textContent = err.message; } finally { go.disabled = false; }
});

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
  // No name (an account made with email): the email once, as the name.
  $('#name').textContent = account.profile?.name || account.email;
  $('#email').textContent = account.profile?.name ? account.email : '';
  const u = usage.usage;
  renderUsage(u);
  const p = account.plan || {};
  const when = p.renewsAt ? new Date(p.renewsAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const status = u.plan === 'free' ? null
    : p.status === 'code' ? { text: when ? `From a code · until ${when}` : 'From a code' }
    : p.status === 'canceling' ? { text: when ? `Ends ${when}` : 'Ends at period end', warn: true }
      : p.status === 'past_due' ? { text: 'Payment issue: update your card (Card and invoices)', warn: true }
        : when ? { text: `Renews ${when}` } : null;
  $('#plan-status').hidden = !status;
  $('#plan-status').textContent = status?.text || '';
  $('#plan-status').classList.toggle('warn', !!status?.warn);
  $('#billing').hidden = u.plan === 'free' || p.status === 'code';
  const wanted = new URLSearchParams(location.search).get('plan');
  renderPlans(plansList, u.plan, wanted, p.status === 'canceling', p.status === 'code');
  return u;
}

$('#billing').addEventListener('click', openPortal);

// A plan code: a month of a plan, from the people who make Lumio.
$('#code-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#code-msg');
  const code = $('#code-input').value.trim();
  if (!code) { $('#code-input').focus(); return; }
  $('#code-go').disabled = true;
  msg.className = 'code-msg';
  msg.textContent = 'Checking…';
  try {
    const r = await post('/api/billing/redeem', { code });
    const until = new Date(r.until).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
    $('#code-input').value = '';
    msg.textContent = '';
    notice(`You’re on Lumio ${r.planName} until ${until}. Enjoy!`);
    await renderAll();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    msg.className = 'code-msg bad';
    msg.textContent = err.message;
  } finally {
    $('#code-go').disabled = false;
  }
});
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
