// The sign-in page: Continue with Google, or an email and a password. One step
// shows at a time: sign in, create an account, the code from the email, forgot
// password and a new password (docs/email-accounts.md). The server's replies
// set the session cookie and say where to go next; going there is a real
// navigation, so the apps' hand-off (/api/auth/app/finish) can open Lumio.
const $ = (s, root = document) => root.querySelector(s);
const q = new URLSearchParams(location.search);
const next = q.get('next');
const mode = q.get('mode');
const steps = [...document.querySelectorAll('.signin-step')];

// Only paths on this site, the same check as the server's safeNext.
const onSite = (path) => typeof path === 'string' && /^\/(?!\/)[\w\-./?=&#%]*$/.test(path);

// The server's rules, so most mistakes show before anything is sent.
const BAD_EMAIL = 'Enter a valid email address.';
const BAD_PASSWORD = 'Use a password with 8 to 128 characters.';
const BAD_CODE = 'Enter the 6-digit code from the email.';
const cleanEmail = (v) => v.trim().toLowerCase();
const emailOk = (v) => v.length >= 3 && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && !/\p{Cc}/u.test(v);
const passwordOk = (v) => { const n = [...v.normalize('NFC')].length; return n >= 8 && n <= 128; };
const cleanCode = (v) => v.replace(/[\s-]/g, '');

let email = '';     // as typed; it carries from the step you leave to the next
let password = '';  // from Create account or Sign in, for the code step (memory only)
let leaving = false;

// One message at a time: an error, or good news.
function say(text = '', ok = false) {
  const [show, other] = ok ? [$('#notice'), $('#error')] : [$('#error'), $('#notice')];
  other.hidden = true;
  show.hidden = !text;
  show.textContent = text;
}

function go(name) {
  const typed = steps.find((s) => !s.hidden)?.querySelector('input[name=email]');
  if (typed) email = typed.value;
  const step = steps.find((s) => s.dataset.step === name);
  for (const s of steps) s.hidden = s !== step;
  $('.lead', step).after($('#error'), $('#notice'));
  for (const input of step.querySelectorAll('input[name=email]')) input.value = email;
  for (const el of step.querySelectorAll('[data-email]')) el[el.localName === 'input' ? 'value' : 'textContent'] = cleanEmail(email);
  say();
  return step;
}

// A step the person asked for: its first empty field is ready to type in.
function show(name) {
  const fields = [...go(name).querySelectorAll('input:not([tabindex="-1"])')];
  (fields.find((f) => !f.value) || fields[0])?.focus();
}

function wrong(text, field) {
  say(text);
  field.focus();
}

// POST /api/auth/email/<action>: the reply, or { error } to show.
async function call(action, fields) {
  let res;
  try {
    res = await fetch(`/api/auth/email/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...fields, client: 'web', ...(next ? { next } : {}) }) });
  } catch {
    return { error: 'Lumio couldn’t be reached. Check your connection and try again.' };
  }
  const data = await res.json().catch(() => ({}));
  return res.ok ? data : { error: data.error || 'That didn’t work. Try again.' };
}

// Signed in (the cookie is set): go on, as a top-level navigation.
function signedIn(reply) {
  if (!(reply.ok && reply.next)) { say(reply.error || 'That didn’t work. Try again.'); return; }
  leaving = true;
  location.replace(onSite(reply.next) ? reply.next : '/account');
}

const SUBMIT = {
  async signin(form) {
    email = form.email.value;
    if (!emailOk(cleanEmail(email))) return wrong(BAD_EMAIL, form.email);
    const typed = form.password.value;
    if (!typed) return form.password.focus();
    const reply = await call('signin', { email: cleanEmail(email), password: typed });
    if (!reply.needsCode) return signedIn(reply);
    // Signed up, but the email isn't confirmed yet: a new code is on its way.
    password = typed;
    show('code');
    say('Confirm your email to finish signing up. We sent you a new code.', true);
  },
  async create(form) {
    email = form.email.value;
    if (!emailOk(cleanEmail(email))) return wrong(BAD_EMAIL, form.email);
    if (!passwordOk(form.password.value)) return wrong(BAD_PASSWORD, form.password);
    const reply = await call('signup', { email: cleanEmail(email), password: form.password.value });
    if (reply.error) return say(reply.error);
    password = form.password.value;
    show('code');
  },
  async code(form) {
    const code = cleanCode(form.code.value);
    if (!/^\d{6}$/.test(code)) return wrong(BAD_CODE, form.code);
    signedIn(await call('confirm', { email: cleanEmail(email), code, password }));
  },
  async forgot(form) {
    email = form.email.value;
    if (!emailOk(cleanEmail(email))) return wrong(BAD_EMAIL, form.email);
    const reply = await call('forgot', { email: cleanEmail(email) });
    if (reply.error) return say(reply.error);
    show('reset');
  },
  async reset(form) {
    const code = cleanCode(form.code.value);
    if (!/^\d{6}$/.test(code)) return wrong(BAD_CODE, form.code);
    if (!passwordOk(form.password.value)) return wrong(BAD_PASSWORD, form.password);
    signedIn(await call('reset', { email: cleanEmail(email), code, password: form.password.value }));
  },
};

// The button stays off while its request runs (and when the page is leaving).
async function busy(button, work) {
  if (button.disabled) return;
  button.disabled = true;
  try { await work(); } finally { if (!leaving) button.disabled = false; }
}

for (const step of steps) {
  const form = $('form', step);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy($('button[type=submit]', form), () => SUBMIT[step.dataset.step](form));
  });
}
for (const b of document.querySelectorAll('[data-go]')) b.addEventListener('click', () => show(b.dataset.go));
// Send a new code: the sign-up code again, or another reset code.
for (const b of document.querySelectorAll('[data-again]')) {
  b.addEventListener('click', () => busy(b, async () => {
    const reset = b.closest('.signin-step').dataset.step === 'reset';
    const reply = await call(reset ? 'forgot' : 'resend', { email: cleanEmail(email) });
    if (reply.error) say(reply.error);
    else say(reset ? `If ${cleanEmail(email)} has a Lumio account, we sent a new code.` : `We sent a new code to ${cleanEmail(email)}.`, true);
  }));
}

const google = '/api/auth/google/start' + (onSite(next) ? '?next=' + encodeURIComponent(next) : '');
for (const a of document.querySelectorAll('.google-btn')) a.href = google;
go(mode === 'create' || mode === 'forgot' ? mode : 'signin');

// Back from Google sign-in with a problem.
const messages = {
  expired: 'That sign-in took too long. Try again.',
  cancelled: 'Sign-in was cancelled.',
  google: 'Google couldn’t confirm your account. Try again.',
  unavailable: 'Sign-in isn’t available right now. Try again soon.',
};
const error = q.get('error');
if (error) say(messages[error] || 'Sign-in didn’t work. Try again.');
// Already signed in? Go straight on (not after an error, or when a step was asked for).
fetch('/api/account').then((r) => r.json()).then((a) => { if (a.signedIn && !error && !mode) location.replace(onSite(next) ? next : '/account'); }).catch(() => {});
