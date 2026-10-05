// Lookalike sites and spoofed addresses (pure functions, no Electron).
//
//  - displayHost/displayUrl: what the address bar shows. Chromium keeps
//    international names in punycode (xn--…); Lumio shows them in their own
//    letters only when that can't be mistaken for another site, using a
//    simple version of Chrome's rules: one script per label (or the
//    combinations Japanese, Chinese and Korean use), no labels made only of
//    letters that look Latin (like Cyrillic "аррӏе"), no symbols that look
//    like "/" or ".", and no accented copies of well-known sites.
//  - lookalikeOf: is a site a close copy of a well-known site or of one the
//    person visits often ("paypa1.com", "rnicrosoft.com", "раураl.com",
//    "paypal.com.account-help.net")? Lumio then asks "Did you mean …?".
const { domainToUnicode } = require('url');
const { BRANDS, LOOKALIKE_OK } = require('./security-lists');

const OK_SITES = new Set(LOOKALIKE_OK);

// Letters from other scripts (and a few Latin ones) that look like Latin
// letters, after lowercasing and removing accents.
const CONFUSABLE = {
  // Cyrillic
  а: 'a', в: 'b', е: 'e', з: '3', і: 'i', ј: 'j', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  ѕ: 's', һ: 'h', ԁ: 'd', ԛ: 'q', ԝ: 'w', ӏ: 'l', ү: 'y', ь: 'b', ԍ: 'g', ɡ: 'g',
  // Greek
  α: 'a', β: 'b', γ: 'y', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w',
  // Armenian
  օ: 'o', ո: 'n', ս: 'u', հ: 'h', զ: 'q', ց: 'g',
  // Latin letters that pass for plain ones
  ı: 'i', ɑ: 'a', ǀ: 'l', ꞁ: 'l', ʏ: 'y', ᴏ: 'o', ꜱ: 's', ᴠ: 'v', ᴡ: 'w', ᴢ: 'z',
};
// The same, for the letters of a whole label in one of these scripts.
const LATIN_LOOKING = {
  Cyrillic: /^[аеорсухіјѕһԁԛԝӏү0-9-]+$/u,
  Greek: /^[αικνοτυχω0-9-]+$/u,
  Armenian: /^[օոսհզց0-9-]+$/u,
};
// Top-level domains of the countries that write in those scripts, where a
// whole label of them is normal.
const SCRIPT_TLDS = {
  Cyrillic: new Set(['ru', 'рф', 'su', 'ua', 'укр', 'by', 'бел', 'bg', 'бг', 'kz', 'қаз', 'mk', 'мкд', 'mn', 'мон', 'rs', 'срб', 'kg', 'tj', 'uz', 'me', 'ba']),
  Greek: new Set(['gr', 'ελ', 'cy']),
  Armenian: new Set(['am', 'հայ']),
};
const SCRIPTS = ['Latin', 'Cyrillic', 'Greek', 'Armenian', 'Georgian', 'Hebrew', 'Arabic', 'Han', 'Hiragana', 'Katakana', 'Hangul', 'Bopomofo',
  'Thai', 'Lao', 'Khmer', 'Myanmar', 'Devanagari', 'Bengali', 'Gurmukhi', 'Gujarati', 'Oriya', 'Tamil', 'Telugu', 'Kannada', 'Malayalam',
  'Sinhala', 'Tibetan', 'Ethiopic', 'Thaana', 'Mongolian'];
const SCRIPT_RE = Object.fromEntries(SCRIPTS.map((s) => [s, new RegExp(`\\p{Script=${s}}`, 'u')]));
// Scripts that are read together in one word.
const MIXES = [new Set(['Latin', 'Han', 'Hiragana', 'Katakana']), new Set(['Latin', 'Han', 'Bopomofo']), new Set(['Latin', 'Han', 'Hangul'])];

function scriptOf(ch) {
  if (/[0-9-]/.test(ch) || /\p{Script=Common}|\p{Script=Inherited}/u.test(ch)) return null;
  return SCRIPTS.find((s) => SCRIPT_RE[s].test(ch)) || 'Other';
}

// A label's "skeleton": what it looks like, ignoring case, accents and
// letters that pass for others ("pаypa1" and "paypal" look the same).
function skeleton(label) {
  let s = String(label || '').toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
  s = [...s].map((ch) => CONFUSABLE[ch] || ch).join('');
  return s.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/cl/g, 'd').replace(/[1|]/g, 'l').replace(/0/g, 'o');
}

// Brand labels by skeleton ("google" for google.com, "amazon" for amazon.de).
const brandLabels = new Set(BRANDS.map((d) => skeleton(d.split('.')[0])).filter((l) => l.length >= 4));

// May one label of an international name be shown in its own letters?
function labelSafe(label, tld) {
  if (!/[^\x00-\x7f]/.test(label)) return true;
  // Letters, digits, marks and hyphens only: no look-alike slashes, dots or invisible characters.
  if (!/^[\p{L}\p{M}\p{N}-]+$/u.test(label) || /\p{Default_Ignorable_Code_Point}/u.test(label)) return false;
  // Digits from one numbering system (each one's ten digits share a block of 16).
  const digitSystems = new Set([...label].filter((ch) => /\p{Nd}/u.test(ch)).map((ch) => ch.codePointAt(0) >> 4));
  if (digitSystems.size > 1) return false;
  // Latin letters made to pass for plain ones (dotless i, small capitals).
  if (/[ıɑǀꞁʏᴏꜱᴠᴡᴢɡ]/u.test(label)) return false;
  const scripts = new Set([...label].map(scriptOf).filter(Boolean));
  if (scripts.has('Other')) return false;
  if (scripts.size > 1 && !MIXES.some((mix) => [...scripts].every((s) => mix.has(s)))) return false;
  // A whole label of Latin-looking letters from another script.
  const [only] = scripts;
  if (scripts.size === 1 && LATIN_LOOKING[only]?.test(label.toLowerCase()) && !SCRIPT_TLDS[only].has(tld)) return false;
  // An accented copy of a well-known site ("faceboók").
  if (brandLabels.has(skeleton(label))) return false;
  return true;
}

// What the address bar shows for a host (Chromium gives it in punycode).
const cache = new Map();
function displayHost(host) {
  const h = String(host || '').toLowerCase();
  if (!/(^|\.)xn--/.test(h)) return h;
  if (cache.has(h)) return cache.get(h);
  let shown = h;
  const uni = domainToUnicode(h);
  if (uni && uni !== h) {
    const labels = uni.split('.');
    const tld = labels.at(-1);
    if (labels.every((l) => labelSafe(l, tld))) shown = uni;
  }
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  cache.set(h, shown);
  return shown;
}

// A URL with its host as the address bar should show it.
function displayUrl(url) {
  const m = /^(https?:\/\/)([^/?#:@]+)(.*)$/i.exec(String(url || ''));
  if (!m) return url;
  const host = displayHost(m[2]);
  return host === m[2].toLowerCase() ? url : m[1] + host + m[3];
}

// Damerau (adjacent swaps count as one) edit distance, stopping early above 1.
function withinOneEdit(a, b) {
  if (a === b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return { at: i, x: a[i], y: b[i] };
    if (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2)) return { at: i, swap: true };
    return false;
  }
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  return long.slice(i + 1) === short.slice(i) ? { at: i, x: long[i], y: '' } : false;
}

// Pairs that differ by one character but are usually different sites:
// another digit ("site1"/"site2"), a hyphen, or the first letter.
function likelyDifferent(edit) {
  if (edit.at === 0) return true;
  if (edit.swap) return false;
  return (/\d/.test(edit.x) && /\d/.test(edit.y)) || edit.x === '-' || edit.y === '-';
}

// targets: [{ site, brand }] (registrable domains). site: the navigated
// host's registrable domain. Returns { site, reason } for the site it
// copies, or null.
function lookalikeOf(host, site, targets) {
  host = String(host || '').toLowerCase();
  site = String(site || '').toLowerCase();
  if (!site.includes('.') || /^[\d.]+$|:/.test(site) || OK_SITES.has(site)) return null;
  const label = site.split('.')[0];
  // The site itself, or the same name in another country (amazon.de).
  if (targets.some((t) => t.site === site || t.site.split('.')[0] === label)) return null;
  const uniLabel = (domainToUnicode(site) || site).split('.')[0];
  const skel = skeleton(uniLabel);
  for (const t of targets) {
    const tLabel = t.site.split('.')[0];
    if (tLabel === label || tLabel.length < 4) continue;
    if (skeleton(tLabel) === skel) return { site: t.site, reason: 'skeleton' };
  }
  if (/^[a-z0-9-]+$/.test(label)) {
    for (const t of targets) {
      const tLabel = t.site.split('.')[0];
      if (tLabel.length < 6 || tLabel === label) continue;
      const edit = withinOneEdit(label, tLabel);
      if (edit && !likelyDifferent(edit)) return { site: t.site, reason: 'edit' };
    }
  }
  // A well-known site's name inside another site's address:
  // paypal.com.secure-login.net or paypal-com.example.net.
  const inner = host.endsWith('.' + site) ? host.slice(0, -site.length - 1) : '';
  if (inner) {
    const parts = inner.split('.');
    for (const t of targets.filter((x) => x.brand)) {
      const tParts = t.site.split('.');
      const dashed = t.site.replace(/\./g, '-');
      const joined = parts.join('.');
      if (`.${joined}.`.includes(`.${t.site}.`) || parts.includes(dashed) || parts.some((p) => p.startsWith(dashed + '-'))) return { site: t.site, reason: 'embedded' };
      // www.paypal.example.net
      if (tParts.length === 2 && tParts[0].length >= 5 && parts.at(-1) === tParts[0] && parts.at(-2) === 'www') return { site: t.site, reason: 'embedded' };
    }
  }
  return null;
}

// The built-in targets: well-known sites.
const BRAND_TARGETS = BRANDS.filter((d) => !/workers\.dev$/.test(d)).map((site) => ({ site, brand: true }));

module.exports = { displayHost, displayUrl, labelSafe, skeleton, lookalikeOf, withinOneEdit, BRAND_TARGETS };
