// Autofill data (main/autofill-store.js): addresses, cards and form entries
// are never on disk in plain text, cards never show their number, the CVC
// isn't kept, and a form someone sent leads to save, update or nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AutofillStore, luhn, cardBrand, cleanCard, addressSummary, sensitiveValue } = require('../main/autofill-store.js');

// Stand-in for Electron's safeStorage: reversible, and never plain text.
const fakeSafe = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('enc:' + Buffer.from(s).toString('hex')),
  decryptString: (b) => Buffer.from(String(b).slice(4), 'hex').toString(),
};
const fresh = (safe = fakeSafe) => new AutofillStore(fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-af-')), safe);
const onDisk = (s) => { s.file.flush(); s.historyFile.flush(); return fs.readFileSync(s.file.file, 'utf8') + fs.readFileSync(s.historyFile.file, 'utf8'); };
const HOME = { name: 'Sam Tester', street: '123 Ocean Drive\nApt 4', city: 'Miami Beach', state: 'FL', zip: '33139', country: 'United States', phone: '+1 (305) 555-0100', email: 'sam@example.com' };

test('card numbers: Luhn check and brands', () => {
  assert.equal(luhn('4242 4242 4242 4242'), true);
  assert.equal(luhn('4242424242424241'), false);
  assert.equal(luhn('1234'), false);
  assert.deepEqual(['4242424242424242', '5555555555554444', '2223003122003222', '378282246310005', '6011111111111117', '3566002020360505', '30569309025904', '6200000000000005'].map(cardBrand),
    ['visa', 'mastercard', 'mastercard', 'amex', 'discover', 'jcb', 'diners', 'unionpay']);
  assert.equal(cleanCard({ number: '4242424242424241' }), null);
  assert.deepEqual(cleanCard({ number: '4242-4242-4242-4242', name: ' Sam ', expMonth: '4', expYear: '29', cvc: '123' }),
    { number: '4242424242424242', name: 'Sam', nickname: '', expMonth: 4, expYear: 2029 }, 'two-digit years; the CVC is dropped');
});

test('addresses and card numbers are never stored in plain text; lists never show a number', () => {
  const s = fresh();
  const a = s.saveAddress(HOME);
  const c = s.saveCard({ number: '4242 4242 4242 4242', name: 'Sam Tester', expMonth: 4, expYear: 2031, cvc: '987' });
  s.recordEntries([{ key: 'nickname', value: 'Sammy the tester' }]);
  const raw = onDisk(s);
  for (const secret of ['Ocean', 'Miami', 'sam@example.com', '4242424242424242', '987', 'Sammy']) assert.ok(!raw.includes(secret), `${secret} is encrypted`);
  assert.equal(s.address(a).street, '123 Ocean Drive\nApt 4');
  assert.equal(addressSummary(s.address(a)), '123 Ocean Drive, Miami Beach, FL 33139');
  const listed = s.cards();
  assert.deepEqual(listed.map((x) => [x.brandName, x.last4, x.name, x.expMonth, x.expYear, x.expired]), [['Visa', '4242', 'Sam Tester', 4, 2031, false]]);
  assert.ok(!JSON.stringify(listed).includes('4242424242424242'), 'cards() has no number');
  assert.ok(!JSON.stringify(s.file.data).includes('987'), 'no security code anywhere');
  assert.equal(s.cardNumber(c), '4242424242424242');
});

test('saving is refused without encryption; bad cards and duplicates are refused', () => {
  const off = fresh({ isEncryptionAvailable: () => false });
  assert.throws(() => off.saveAddress(HOME), /Encryption/);
  assert.throws(() => off.saveCard({ number: '4242424242424242' }), /Encryption/);
  assert.equal(off.recordEntries([{ key: 'city', value: 'Miami' }]), 0);
  const s = fresh();
  assert.throws(() => s.saveCard({ number: '4242424242424241' }), /isn’t valid/);
  assert.throws(() => s.saveCard({ number: '4242424242424242', expMonth: 13, expYear: 2030 }), /expiry/);
  assert.throws(() => s.saveAddress({}), /at least one/);
  const id = s.saveCard({ number: '4242424242424242' });
  assert.throws(() => s.saveCard({ number: '4242 4242 4242 4242' }), /already saved/);
  // Editing without a number keeps it.
  s.saveCard({ name: 'New Name', expMonth: 1, expYear: 2032 }, id);
  assert.equal(s.cardNumber(id), '4242424242424242');
  assert.equal(s.card(id).name, 'New Name');
  assert.equal(s.removeCard(id), true);
  assert.equal(s.cards().length, 0);
});

test('a form that was sent: save, update or nothing', () => {
  const s = fresh();
  assert.equal(s.classifyAddress({ name: 'Sam', email: 'sam@example.com' }).action, 'none', 'not an address');
  assert.equal(s.classifyAddress(HOME).action, 'save');
  const id = s.saveAddress(HOME);
  // Same place, other formatting: nothing to do.
  assert.deepEqual(s.classifyAddress({ name: 'SAM TESTER', street: '123 ocean drive', city: 'Miami beach', zip: '33139', phone: '305 555 0100' }), { action: 'none', id });
  // Same street with a new phone: update, keeping the rest.
  const up = s.classifyAddress({ street: '123 Ocean Drive', city: 'Miami Beach', zip: '33139', phone: '305-555-0199' });
  assert.equal(up.action, 'update');
  assert.equal(up.id, id);
  assert.equal(up.fields.email, 'sam@example.com');
  assert.equal(up.fields.phone, '305-555-0199');
  assert.equal(s.classifyAddress({ name: 'Ana', street: '9 Calle Ocho', city: 'Miami', zip: '33135' }).action, 'save');

  assert.equal(s.classifyCard({ number: '4242424242424242', expMonth: 4, expYear: 2031 }).action, 'save');
  const card = s.saveCard({ number: '4242424242424242', expMonth: 4, expYear: 2031, name: 'Sam' });
  assert.deepEqual(s.classifyCard({ number: '4242 4242 4242 4242', expMonth: 4, expYear: 31 }), { action: 'none', id: card });
  const renewed = s.classifyCard({ number: '4242424242424242', expMonth: 9, expYear: 2034 });
  assert.equal(renewed.action, 'update');
  assert.equal(renewed.card.name, 'Sam');
  assert.equal(s.classifyCard({ number: '1234' }).action, 'none');
});

test('form entries: remembered by field, suggested by what is typed, removable, capped, never sensitive', () => {
  const s = fresh();
  s.recordEntries([{ key: 'City', value: 'Miami' }, { key: 'city', value: 'Madrid' }, { key: 'city', value: 'Miami' }, { key: 'q', value: 'x' }]);
  assert.deepEqual(s.suggestEntries('city', '').map((x) => x.value), ['Miami', 'Madrid'], 'most used first');
  assert.deepEqual(s.suggestEntries('city', 'mad').map((x) => x.value), ['Madrid']);
  assert.deepEqual(s.suggestEntries('city', 'miami').map((x) => x.value), [], 'not what is already typed');
  assert.deepEqual(s.suggestEntries('q', ''), [], 'one letter is not worth remembering');
  // Card numbers and Social Security numbers are never remembered, wherever they're typed.
  assert.equal(sensitiveValue('4242 4242 4242 4242'), true);
  assert.equal(sensitiveValue('123-45-6789'), true);
  assert.equal(sensitiveValue('33139'), false);
  assert.equal(s.recordEntries([{ key: 'notes', value: '4242424242424242' }, { key: 'id', value: '123-45-6789' }]), 0);
  const [miami] = s.suggestEntries('city', 'mi');
  assert.equal(s.removeEntry(miami.id), true);
  assert.deepEqual(s.suggestEntries('city', '').map((x) => x.value), ['Madrid']);
  // At most 40 per field: the least used go first.
  s.recordEntries(Array.from({ length: 45 }, (_, i) => ({ key: 'tag', value: `tag-${i}` })));
  assert.equal(s.entries.filter((e) => e.k === 'tag').length, 40);
  assert.equal(s.clearEntries(), 41);
  assert.equal(s.entries.length, 0);
});

test('never-save sites, per kind', () => {
  const s = fresh();
  s.addNever('card', 'https://shop.example');
  assert.equal(s.isNever('card', 'https://shop.example'), true);
  assert.equal(s.isNever('address', 'https://shop.example'), false);
  s.removeNever('card', 'https://shop.example');
  assert.equal(s.isNever('card', 'https://shop.example'), false);
});
