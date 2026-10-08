// Lumio's own address: the browser talks to https://lumio-co.online unless
// LUMIO_ACCOUNT_BASE says otherwise, and the older addresses (still used by
// older apps) stay trusted. Each case runs in its own node process because
// main/account.js reads the environment when it loads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ACCOUNT = fileURLToPath(new URL('../main/account.js', import.meta.url));

function accountWith(env) {
  const clean = { ...process.env };
  delete clean.LUMIO_ACCOUNT_BASE;
  delete clean.LUMIO_AI_BASE;
  const code = `const { LumioAccount, LUMIO_BASE, LUMIO_AI_BASE } = require(${JSON.stringify(ACCOUNT)});
const a = new LumioAccount({ store: { getSecret() {} } });
process.stdout.write(JSON.stringify({ base: LUMIO_BASE, aiBase: LUMIO_AI_BASE, host: a.host, cookie: a.cookieName, account: a.url('/account') }));`;
  return JSON.parse(execFileSync(process.execPath, ['-e', code], { env: { ...clean, ...env }, encoding: 'utf8' }));
}

test('the account and the AI default to lumio-co.online', () => {
  assert.deepEqual(accountWith({}), {
    base: 'https://lumio-co.online',
    aiBase: 'https://lumio-co.online',
    host: 'lumio-co.online',
    cookie: '__Host-lumio_session',
    account: 'https://lumio-co.online/account',
  });
});

test('LUMIO_ACCOUNT_BASE still picks another server, like the older workers.dev address', () => {
  const a = accountWith({ LUMIO_ACCOUNT_BASE: 'https://lumio.gw607953.workers.dev/' });
  assert.equal(a.base, 'https://lumio.gw607953.workers.dev', 'without the trailing slash');
  assert.equal(a.aiBase, a.base);
  assert.equal(a.host, 'lumio.gw607953.workers.dev');
});

test('Lumio’s new and older addresses are never blocked, and copies of the new one are caught', () => {
  const { BRANDS } = require('../main/security-lists.js');
  for (const host of ['lumio-co.online', 'lumio-usa.online', 'lumio.gw607953.workers.dev', 'lumio-browser.gw607953.workers.dev']) {
    assert.ok(BRANDS.includes(host), host);
  }
  const look = require('../main/lookalike.js');
  const of = (host, site = host) => look.lookalikeOf(host, site, look.BRAND_TARGETS)?.site || null;
  assert.equal(of('lumio-co.online'), null);
  assert.equal(of('lumio-usa.online'), null);
  assert.equal(of('lumio-c0.online'), 'lumio-co.online');
  assert.equal(of('lumio-co.online.example.net', 'example.net'), 'lumio-co.online');
});

test('the new tab page’s Lumio tile opens lumio-co.online', () => {
  const { STARTERS } = require('../main/ntp-shortcuts.js');
  assert.deepEqual(STARTERS.filter((s) => s.title === 'Lumio').map((s) => s.url), ['https://lumio-co.online/']);
});
