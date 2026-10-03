// Lumio's payment page: Stripe's payment form shown inside Lumio (Embedded
// Checkout), so people never leave for Stripe's site. Lumio Browser opens it
// in its own window with ?app=1 (and closes it when the payment is done).
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PERKS = {
  go: ['Thousands of messages and about 100 browser tasks a week', 'About 50 pictures a week', 'GPT-6 Luna, Ling and DeepSeek in Chat'],
  plus: ['Thousands of messages and hundreds of browser tasks a week', 'About 100 pictures a week', 'Claude Sonnet, GPT-6.1 Sol, Gemini and Grok in Chat'],
  pro: ['About 6× the usage of Plus', 'Every model, including Claude Opus and GPT-6 Astra', 'For people who use Lumio all day'],
  max: ['About 11× the usage of Plus', 'Every model', 'The most Lumio AI there is'],
};
const NAMES = { go: 'Go', plus: 'Plus', pro: 'Pro', max: 'Max' };
const PRICES = { go: 10, plus: 20, pro: 100, max: 200 };

const q = new URLSearchParams(location.search);
const inApp = q.has('app');
if (inApp) document.body.classList.add('in-app');
const back = inApp ? null : '/account';

function problem(text, again) {
  $('#summary').hidden = true;
  $('#form').hidden = true;
  $('#problem').hidden = false;
  $('#problem-text').textContent = text;
  const b = $('#problem-btn');
  if (again) { b.textContent = 'Try again'; b.href = again; } else if (inApp) { b.textContent = 'Close'; b.onclick = (e) => { e.preventDefault(); window.close(); }; }
}

async function finished(sessionId) {
  const res = await fetch(`/api/billing/checkout-status?session_id=${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { problem(data.error || 'We couldn’t check this payment. Look at your plan in Settings.'); return; }
  if (data.status !== 'complete') { problem('The payment didn’t finish, and you weren’t charged.', `/checkout?plan=${encodeURIComponent(q.get('plan') || 'plus')}${inApp ? '&app=1' : ''}`); return; }
  $('#done').hidden = false;
  $('#done-title').textContent = `You’re on Lumio ${data.planName}`;
  if (inApp) {
    $('#done-text').textContent = 'Your bigger weekly allowance is ready. This window closes by itself.';
    $('#done-btn').onclick = (e) => { e.preventDefault(); window.close(); };
    setTimeout(() => window.close(), 2500);
  }
}

async function start(plan) {
  const account = await fetch('/api/account', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({}));
  if (!account.signedIn) { location.replace(`/signin?next=${encodeURIComponent(location.pathname + location.search)}`); return; }
  $('#summary').hidden = false;
  $('#form').hidden = false;
  $('#plan-name').textContent = NAMES[plan];
  $('#price').textContent = `$${PRICES[plan]}`;
  $('#perks').innerHTML = PERKS[plan].map((p) => `<li>${esc(p)}</li>`).join('');
  document.title = `Lumio ${NAMES[plan]} · Subscribe`;

  const res = await fetch('/api/billing/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan, embedded: true, app: inApp }) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 409) { problem(data.error); return; }
  if (!res.ok) { $('#error').hidden = false; $('#error').textContent = data.error || 'The payment form didn’t load. Try again.'; $('#checkout').innerHTML = ''; return; }
  if (data.url) { location.href = data.url; return; } // Stripe's own page, until the payment form is set up
  if (typeof window.Stripe !== 'function') { $('#error').hidden = false; $('#error').textContent = 'The payment form couldn’t load. Check your connection and try again.'; return; }
  const checkout = await window.Stripe(data.publishableKey).initEmbeddedCheckout({ fetchClientSecret: async () => data.clientSecret });
  $('#checkout').innerHTML = '';
  checkout.mount('#checkout');
}

const sessionId = q.get('session_id');
const plan = q.get('plan');
if (sessionId) finished(sessionId);
else if (NAMES[plan]) start(plan);
else problem('Choose a plan to subscribe to.', back || undefined);
