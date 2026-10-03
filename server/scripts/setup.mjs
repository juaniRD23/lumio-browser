// One-time setup for the Lumio server, run in your own terminal:
//   node scripts/setup.mjs --host lumio.gw607953.workers.dev
//   node scripts/setup.mjs --host lumio.gw607953.workers.dev --stripe   (only the Stripe keys, e.g. test → live)
// Asks for each key with hidden input (Enter skips one) and stores it as a
// Cloudflare Worker secret. With a Stripe key it also creates Lumio's plans
// (Go $10, Plus $20, Pro $100, Max $200 a month), its own billing-portal settings and
// the webhook, all tagged app=lumio, and stores the webhook's signing secret.
// It also creates the key that encrypts connected apps' tokens (once).
// Keys only go to Cloudflare (wrangler) and Stripe; nothing is printed or saved.
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import readline from 'node:readline';

const host = (process.argv[process.argv.indexOf('--host') + 1] || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
if (!process.argv.includes('--host') || !/^[a-z0-9.-]+$/.test(host)) {
  console.error('Usage: node scripts/setup.mjs --host lumio.gw607953.workers.dev');
  process.exit(1);
}
const PLANS = [
  { key: 'lumio_go_monthly', name: 'Lumio Go', amount: 1000 },
  { key: 'lumio_plus_monthly', name: 'Lumio Plus', amount: 2000 },
  { key: 'lumio_pro_monthly', name: 'Lumio Pro', amount: 10000 },
  { key: 'lumio_max_monthly', name: 'Lumio Max', amount: 20000 },
];
// What subscribers see on their card statement: the business name (Stripe requires it) plus the product.
const DESCRIPTOR = 'FIFTY SITES LUMIO';
const onlyStripe = process.argv.includes('--stripe');
const EVENTS = ['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'];

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (s) => { if (!muted) rl.output.write(s); else if (s.includes('\n')) rl.output.write('\n'); };
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
    muted = true;
  });
}

function putSecret(name, value) {
  return new Promise((resolve, reject) => {
    const p = spawn('npx', ['--yes', 'wrangler', 'secret', 'put', name], { stdio: ['pipe', 'ignore', 'inherit'] });
    p.stdin.end(value + '\n');
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`wrangler secret put ${name} failed`))));
  });
}

function form(params, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === 'object' ? form(item, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(item))));
    else if (typeof v === 'object') form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function stripeSetup(key) {
  const call = async (method, path, params = {}) => {
    const body = form(params);
    const res = await fetch(`https://api.stripe.com${path}${method === 'GET' && [...body].length ? `?${body}` : ''}`, {
      method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded' }, body: method === 'POST' ? body : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Stripe ${path}: ${data.error?.message || res.status}`);
    return data;
  };
  const mode = /_test_/.test(key) ? 'TEST' : 'LIVE';
  console.log(`\nStripe (${mode} mode):`);
  // Plans, found again by lookup key on later runs.
  const existing = await call('GET', '/v1/prices', { lookup_keys: PLANS.map((p) => p.key), active: true, limit: 10 });
  const prices = {};
  for (const plan of PLANS) {
    const found = existing.data.find((p) => p.lookup_key === plan.key);
    if (found) {
      prices[plan.key] = found;
      await call('POST', `/v1/products/${found.product}`, { statement_descriptor: DESCRIPTOR });
      console.log(`  ✓ ${plan.name} already exists`);
      continue;
    }
    const product = await call('POST', '/v1/products', { name: plan.name, statement_descriptor: DESCRIPTOR, metadata: { app: 'lumio' } });
    prices[plan.key] = await call('POST', '/v1/prices', {
      product: product.id, currency: 'usd', unit_amount: plan.amount, recurring: { interval: 'month' }, lookup_key: plan.key, metadata: { app: 'lumio' },
    });
    console.log(`  ✓ Created ${plan.name} ($${plan.amount / 100}/month)`);
  }
  // Lumio's own billing portal: switch plans, cancel at period end, card and invoices.
  const configs = await call('GET', '/v1/billing_portal/configurations', { active: true, limit: 100 });
  const portal = {
    business_profile: { headline: 'Lumio', privacy_policy_url: `https://${host}/privacy`, terms_of_service_url: `https://${host}/terms` },
    default_return_url: `https://${host}/account`,
    features: {
      customer_update: { enabled: true, allowed_updates: ['email', 'address'] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: 'at_period_end' },
      subscription_update: {
        enabled: true, default_allowed_updates: ['price'], proration_behavior: 'create_prorations',
        products: PLANS.map((p) => ({ product: prices[p.key].product, prices: [prices[p.key].id] })),
      },
    },
    metadata: { app: 'lumio' },
  };
  const mine = configs.data.find((c) => c.metadata?.app === 'lumio');
  if (mine) { await call('POST', `/v1/billing_portal/configurations/${mine.id}`, portal); console.log('  ✓ Billing portal settings updated'); }
  else { await call('POST', '/v1/billing_portal/configurations', portal); console.log('  ✓ Billing portal settings created (Lumio only; your default portal is untouched)'); }
  // The webhook for this host.
  const url = `https://${host}/api/stripe/webhook`;
  const hooks = await call('GET', '/v1/webhook_endpoints', { limit: 100 });
  const hook = hooks.data.find((h) => h.metadata?.app === 'lumio');
  let webhookSecret = null;
  if (hook) {
    await call('POST', `/v1/webhook_endpoints/${hook.id}`, { url, enabled_events: EVENTS });
    console.log(`  ✓ Webhook now points at ${url} (its signing secret is already stored)`);
  } else {
    const created = await call('POST', '/v1/webhook_endpoints', { url, enabled_events: EVENTS, description: 'Lumio plans', metadata: { app: 'lumio' } });
    webhookSecret = created.secret;
    console.log(`  ✓ Webhook created for ${url}`);
  }
  // Stored only once everything above worked, so a failed run never mixes test and live.
  if (webhookSecret) { await putSecret('STRIPE_WEBHOOK_SECRET', webhookSecret); console.log('  ✓ Webhook signing secret stored'); }
  await putSecret('STRIPE_SECRET_KEY', key);
  console.log(`  ✓ Stripe key stored (card statements say "${DESCRIPTOR}")`);
}

console.log(`Lumio server setup for https://${host}\nPaste each key when asked (typing is hidden). Press Enter to skip one.\n`);
if (!onlyStripe) {
  const openrouter = await ask('OpenRouter API key: ');
  if (openrouter) { await putSecret('OPENROUTER_API_KEY', openrouter); console.log('  ✓ OpenRouter key stored'); }
  const google = await ask('Google OAuth client secret: ');
  if (google) { await putSecret('GOOGLE_CLIENT_SECRET', google); console.log('  ✓ Google client secret stored'); }
}
const stripeKey = await ask('Stripe secret key (sk_test_… to try it first, sk_live_… for real payments): ');
// The publishable key shows Stripe's payment form inside Lumio's own /checkout page.
const publishable = await ask('Stripe publishable key (pk_test_… or pk_live_…, the same mode as the secret key): ');
// Both are checked before anything is stored, so a typo can't leave test and live keys mixed.
const modeOf = (k) => (/_live_/.test(k) ? 'live' : 'test');
if (stripeKey && !/^(sk|rk)_(test|live)_/.test(stripeKey)) { console.error('That doesn’t look like a Stripe secret key (sk_live_… or rk_live_…). Nothing changed.'); process.exit(1); }
if (publishable && !/^pk_(test|live)_[A-Za-z0-9]+$/.test(publishable)) { console.error('That doesn’t look like a publishable key (pk_live_… or pk_test_…). Nothing changed.'); process.exit(1); }
if (stripeKey && publishable && modeOf(stripeKey) !== modeOf(publishable)) { console.error(`The secret key is ${modeOf(stripeKey)} but the publishable key is ${modeOf(publishable)}: use both from the same mode. Nothing changed.`); process.exit(1); }
if (stripeKey && !publishable && modeOf(stripeKey) === 'live') { console.error('Switching to live needs the live publishable key too (pk_live_…), or Lumio’s payment form would still be in test mode. Nothing changed.'); process.exit(1); }
if (stripeKey) await stripeSetup(stripeKey);
if (publishable) { await putSecret('STRIPE_PUBLISHABLE_KEY', publishable); console.log('  ✓ Stripe publishable key stored (payment form inside Lumio)'); }
if (!onlyStripe) {
  const microsoft = await ask('Microsoft app client secret (for Outlook/OneDrive connections): ');
  if (microsoft) { await putSecret('MICROSOFT_CLIENT_SECRET', microsoft); console.log('  ✓ Microsoft client secret stored'); }
}

// Connections need a key to encrypt people's Google/Microsoft tokens. Made
// once, here; never shown. (Replacing it would disconnect everyone.)
let existing = '';
try { existing = execFileSync('npx', ['--yes', 'wrangler', 'secret', 'list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* not deployed yet */ }
if (!existing.includes('"CONNECTIONS_KEY"')) {
  await putSecret('CONNECTIONS_KEY', crypto.randomBytes(32).toString('base64'));
  console.log('  ✓ Connections encryption key created');
}
// Phone notifications (Web Push) need a VAPID key pair. Made once, here;
// never shown. (Replacing it means phones turn notifications on again.)
if (!existing.includes('"VAPID_PRIVATE_KEY"')) {
  const pair = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = Buffer.from(await crypto.webcrypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');
  await putSecret('VAPID_PRIVATE_KEY', JSON.stringify(await crypto.webcrypto.subtle.exportKey('jwk', pair.privateKey)));
  await putSecret('VAPID_PUBLIC_KEY', pub);
  console.log('  ✓ Phone notification keys created');
}
console.log('\nDone.');
