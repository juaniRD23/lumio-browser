// Certificate errors (main/cert-errors.js): what the warning page shows, which
// errors can be gone past, the per-session list of certificates you chose to
// trust, the HSTS check that keeps "Proceed" away from sites that forbid it,
// and Lumio AI being kept off the warning page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const certs = require('../main/cert-errors.js');

const CERT = {
  fingerprint: 'sha256/AbC123=',
  subject: { commonName: 'expired.example', organizations: ['Example Inc'] },
  subjectName: 'expired.example',
  issuer: { commonName: 'Example CA', organizations: [] },
  issuerName: 'Example CA',
  validStart: Date.UTC(2020, 0, 2) / 1000,
  validExpiry: Date.UTC(2021, 0, 2) / 1000,
  data: '-----BEGIN CERTIFICATE-----…',
};

test('a failed certificate becomes what the warning page shows (never its key)', () => {
  const r = certs.record('https://expired.example:8443/login?x=1', 'net::ERR_CERT_DATE_INVALID', CERT);
  assert.equal(r.host, 'expired.example:8443');
  assert.equal(r.code, 'NET::ERR_CERT_DATE_INVALID');
  assert.equal(r.overridable, true);
  assert.match(r.reason, /expired/);
  assert.deepEqual(r.cert, { subject: 'expired.example, Example Inc', issuer: 'Example CA', validFrom: '2020-01-02', validTo: '2021-01-02', fingerprint: 'sha256/AbC123=' });
  assert.ok(!JSON.stringify(r).includes('BEGIN CERTIFICATE'));
});

test('only the errors Chrome lets you skip offer Proceed', () => {
  for (const e of ['ERR_CERT_COMMON_NAME_INVALID', 'ERR_CERT_DATE_INVALID', 'ERR_CERT_AUTHORITY_INVALID']) assert.equal(certs.record('https://a.example/', `net::${e}`, CERT).overridable, true, e);
  for (const e of ['ERR_CERT_REVOKED', 'ERR_CERT_INVALID', 'ERR_CERT_CONTAINS_ERRORS', 'ERR_SSL_PINNED_KEY_NOT_IN_CERT_CHAIN', 'ERR_SOMETHING_NEW']) assert.equal(certs.record('https://a.example/', `net::${e}`, CERT).overridable, false, e);
});

test('trusting a certificate is per session, per site and per certificate, and can be undone', () => {
  const normal = {};
  const incognito = {};
  assert.equal(certs.isAllowed(normal, 'a.example', 'sha256/one'), false, 'never trusted by itself');
  certs.allow(normal, 'a.example', 'sha256/one');
  assert.equal(certs.isAllowed(normal, 'a.example', 'sha256/one'), true);
  assert.equal(certs.isAllowed(normal, 'a.example', 'sha256/two'), false, 'a different certificate asks again');
  assert.equal(certs.isAllowed(normal, 'b.example', 'sha256/one'), false);
  assert.equal(certs.isAllowed(incognito, 'a.example', 'sha256/one'), false, 'incognito keeps its own list');
  assert.equal(certs.isAllowed(normal, 'a.example', ''), false);
  // The address bar says "Not secure" on that site's https pages.
  assert.equal(certs.bypassed(normal, 'https://a.example/page'), true);
  assert.equal(certs.bypassed(normal, 'https://b.example/'), false);
  assert.equal(certs.bypassed(normal, 'http://a.example/'), false);
  assert.equal(certs.bypassed(null, 'https://a.example/'), false);
  certs.revoke(normal, 'a.example');
  assert.equal(certs.isAllowed(normal, 'a.example', 'sha256/one'), false);
  assert.equal(certs.bypassed(normal, 'https://a.example/page'), false);
});

// A stand-in for Electron's net.request: answers like the network stack would.
function fakeRequest(answer) {
  const made = [];
  const request = (opts) => {
    const req = new EventEmitter();
    req.abort = () => { req.aborted = true; };
    req.end = () => setImmediate(() => answer(req, opts));
    made.push({ opts, req });
    return req;
  };
  return { request, made };
}

test('HSTS: a site the network stack upgrades to https by itself gets no Proceed', async () => {
  const { request, made } = fakeRequest((req) => req.emit('redirect', 307, 'GET', 'https://hsts.example/', { 'Non-Authoritative-Reason': ['HSTS'], Location: ['https://hsts.example/'] }));
  const ses = {};
  assert.equal(await certs.usesHsts(ses, 'hsts.example', { request }), true);
  assert.deepEqual(made[0].opts, { url: 'http://hsts.example/', session: ses, redirect: 'manual', credentials: 'omit' });
  assert.equal(made[0].req.aborted, true, 'never followed');
  assert.equal(await certs.usesHsts(ses, 'hsts.example:8443', { request }), true, 'remembered per host, any port');
  assert.equal(made.length, 1);
});

test('HSTS: a normal answer, a server redirect, an error or silence mean no HSTS; IP addresses are never asked', async () => {
  const ses = {};
  const cases = [
    ['plain.example', (req) => req.emit('response', { statusCode: 200 })],
    ['moved.example', (req) => req.emit('redirect', 301, 'GET', 'https://moved.example/', { location: ['https://moved.example/'] })],
    ['down.example', (req) => req.emit('error', new Error('net::ERR_CONNECTION_REFUSED'))],
    ['quiet.example', () => {}],
  ];
  for (const [host, answer] of cases) {
    const { request } = fakeRequest(answer);
    assert.equal(await certs.usesHsts(ses, host, { request, timeout: 50 }), false, host);
  }
  const { request, made } = fakeRequest(() => assert.fail('asked'));
  assert.equal(await certs.usesHsts(ses, '127.0.0.1:8443', { request }), false);
  assert.equal(await certs.usesHsts(ses, '[::1]:8443', { request }), false);
  assert.equal(made.length, 0);
});

test('Lumio AI can’t read or operate the warning page, so going past it stays the person’s call', async () => {
  const { tools } = require('../main/ai/tools/browser.js');
  const url = 'lumio://error/cert.html?code=-201&desc=ERR_CERT_DATE_INVALID&url=https%3A%2F%2Fexpired.example%2F';
  const tab = { id: 4, url, view: { webContents: { getURL: () => url, getTitle: () => 'Privacy error' } } };
  const ctx = { tabs: { get: (id) => (id === 4 ? tab : null), active: tab, activeId: 4, ensureView() {}, activate() {} } };
  for (const name of ['read_page', 'click', 'press_key']) {
    const tool = tools.find((t) => t.name === name);
    await assert.rejects(async () => tool.run({ tab_id: 4, ref: 'e1', key: 'Enter' }, ctx), /security warning[\s\S]*ask the user/, name);
  }
});
