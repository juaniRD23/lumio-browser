// Safe Browsing (Settings › Privacy and security › Security), Lumio's own
// version of Chrome's "Standard protection": open lists of phishing and
// malware sites, downloaded once a day and checked on this computer. The
// addresses you visit never leave it.
//
// The lists (both allow use in any product):
//  - Phishing.Database, active phishing domains (MIT license)
//  - ShadowWhisperer's BlockLists, malware sites (Unlicense)
// Google Safe Browsing isn't free for products like Lumio, and URLhaus and
// OpenPhish now need a key or a paid plan for this use.
//
// Each list is kept as sorted 64-bit SHA-256 prefixes of its host names
// (about 3 MB for 400,000 sites), so looking up a host is a binary search.
// A host is checked with its parent domains down to its registrable site.
// Well-known sites (main/security-lists.js) are never blocked: lists name
// pages on them, like docs.google.com, that host other people's content.
//
// It also judges downloads: from a listed site, with a misleading name
// ("invoice.pdf.exe"), or over plain http from a secure page.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { BRANDS, INFRA, SHARED } = require('./security-lists');

const SOURCES = [
  { id: 'phishing', threat: 'phishing', url: 'https://raw.githubusercontent.com/Phishing-Database/Phishing.Database/master/phishing-domains-ACTIVE.txt' },
  { id: 'malware', threat: 'malware', url: 'https://raw.githubusercontent.com/ShadowWhisperer/BlockLists/master/Lists/Malware' },
];
const DAY = 864e5;
const MAX_BYTES = 40 * 1024 * 1024;

// Sites never blocked, and list entries ignored (a list naming a hosting
// service itself is a mistake; its customers' subdomains can be listed).
const NEVER_SITES = new Set([...BRANDS, ...INFRA]);
const NEVER_ENTRIES = new Set([...BRANDS, ...INFRA, ...SHARED]);

const HOST_RE = /^(?=.{3,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+(?:[a-z][a-z0-9-]{0,61}[a-z0-9]|xn--[a-z0-9-]{1,59})$/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// Hosts that only reach this computer or its network: never listed.
function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h.startsWith('fe80:') || /^f[cd][0-9a-f]{2}:/.test(h)) return true;
  const m = IPV4_RE.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

// A host name from one line of a list: a plain line, a hosts-file line
// ("0.0.0.0 example.com") or a filter line ("||example.com^"). Null for
// comments and anything else.
function parseLine(line) {
  line = line.replace(/[#!].*$/, '').trim().toLowerCase();
  if (!line) return null;
  const parts = line.split(/\s+/);
  let host = parts.length > 1 && /^(0\.0\.0\.0|127\.0\.0\.1|::1?)$/.test(parts[0]) ? parts[1] : parts[0];
  host = host.replace(/^\|\|/, '').replace(/\^.*$/, '').replace(/^\*\./, '').replace(/\.$/, '');
  return (HOST_RE.test(host) || IPV4_RE.test(host)) && !isPrivateHost(host) ? host : null;
}
const parseList = (text) => String(text).split(/\r?\n/).map(parseLine).filter(Boolean);

const hashHost = (host) => crypto.createHash('sha256').update(host).digest().readBigUInt64BE(0);

// Sorted, de-duplicated prefixes of a list's hosts. It yields to the event
// loop now and then, so a big list doesn't freeze the browser while it's built.
async function buildHashes(text, { chunk = 4000 } = {}) {
  const lines = String(text).split(/\r?\n/);
  const arr = new BigUint64Array(lines.length);
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    const host = parseLine(lines[i]);
    if (host && !NEVER_ENTRIES.has(host)) arr[n++] = hashHost(host);
    if (i % chunk === chunk - 1) await new Promise((r) => setImmediate(r));
  }
  const sorted = arr.subarray(0, n).sort();
  let k = 0;
  for (let i = 0; i < sorted.length; i++) if (i === 0 || sorted[i] !== sorted[k - 1]) sorted[k++] = sorted[i];
  return sorted.slice(0, k);
}

class HashList {
  constructor(hashes) { this.hashes = hashes; }
  get size() { return this.hashes.length; }
  has(hash) {
    const a = this.hashes;
    let lo = 0;
    let hi = a.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (a[mid] === hash) return true;
      if (a[mid] < hash) lo = mid + 1; else hi = mid - 1;
    }
    return false;
  }
}

// The host and its parents, down to its registrable site (or to two labels
// when the site isn't known): a.b.evil.com → a.b.evil.com, b.evil.com, evil.com.
function candidates(host, site) {
  const labels = host.split('.');
  const min = site && host.endsWith(site) ? site.split('.').length : 2;
  const out = [];
  for (let i = 0; labels.length - i >= Math.min(min, labels.length); i++) out.push(labels.slice(i).join('.'));
  return out;
}

class SafeBrowsing {
  // dir: where the lists are kept. fetchImpl(url, init) → Response.
  constructor({ dir, fetchImpl, sources = SOURCES, now = () => Date.now(), log = (...a) => console.error('[lumio] safe browsing:', ...a) }) {
    this.dir = dir;
    this.fetch = fetchImpl;
    this.sources = sources;
    this.now = now;
    this.log = log;
    this.lists = new Map(); // id -> HashList
    this.meta = {};
    this.refreshing = null;
    this.listeners = new Set();
  }

  file(id) { return path.join(this.dir, `${id}.bin`); }
  metaFile() { return path.join(this.dir, 'lists.json'); }

  // Told when the lists change (Settings shows when they were updated).
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  // The lists saved last time, so protection starts right away.
  load() {
    try { this.meta = JSON.parse(fs.readFileSync(this.metaFile(), 'utf8')) || {}; } catch { this.meta = {}; }
    for (const s of this.sources) {
      try {
        const buf = fs.readFileSync(this.file(s.id));
        const copy = new ArrayBuffer(buf.length - (buf.length % 8));
        new Uint8Array(copy).set(buf.subarray(0, copy.byteLength));
        this.lists.set(s.id, new HashList(new BigUint64Array(copy)));
      } catch { /* not downloaded yet */ }
    }
    return this;
  }

  saveMeta() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.metaFile() + '.tmp', JSON.stringify(this.meta));
    fs.renameSync(this.metaFile() + '.tmp', this.metaFile());
  }

  // Downloads lists older than a day (or all of them with force). Only one
  // refresh runs at a time.
  refresh({ force = false } = {}) {
    this.refreshing ??= this.refreshAll(force).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async refreshAll(force) {
    let changed = false;
    for (const s of this.sources) {
      const m = this.meta[s.id] || {};
      if (!force && this.lists.has(s.id) && this.now() - (m.checked || 0) < DAY) continue;
      try {
        const res = await this.fetch(s.url, { headers: m.etag && this.lists.has(s.id) ? { 'If-None-Match': m.etag } : {}, cache: 'no-store' });
        if (res.status === 304) { this.meta[s.id] = { ...m, checked: this.now(), error: null }; continue; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const size = Number(res.headers.get('content-length')) || 0;
        if (size > MAX_BYTES) throw new Error('list too big');
        const text = await res.text();
        if (text.length > MAX_BYTES) throw new Error('list too big');
        const hashes = await buildHashes(text);
        if (!hashes.length) throw new Error('empty list');
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(this.file(s.id) + '.tmp', Buffer.from(hashes.buffer, hashes.byteOffset, hashes.byteLength));
        fs.renameSync(this.file(s.id) + '.tmp', this.file(s.id));
        this.lists.set(s.id, new HashList(hashes));
        this.meta[s.id] = { checked: this.now(), updated: this.now(), etag: res.headers.get('etag') || null, count: hashes.length, error: null };
        changed = true;
      } catch (err) {
        this.meta[s.id] = { ...m, checked: this.now(), error: String(err?.message || err) };
        this.log(s.id, err?.message || err);
      }
    }
    try { this.saveMeta(); } catch (err) { this.log(err.message); }
    for (const fn of this.listeners) fn(this.status());
    return changed;
  }

  // Refresh now and then (each list once a day), starting a little after
  // launch so it doesn't slow the first pages down.
  start({ delay = 20_000 } = {}) {
    this.load();
    const tick = () => this.refresh().catch(() => {});
    this.timer = setInterval(tick, 60 * 60 * 1000);
    this.timer.unref?.();
    setTimeout(tick, delay).unref?.();
    return this;
  }
  stop() { clearInterval(this.timer); }

  // { threat: 'phishing' | 'malware', list } when a list names the host
  // (or a parent of it), else null. site: the host's registrable domain.
  check(host, site = '') {
    const h = String(host || '').toLowerCase().replace(/\.$/, '');
    if (!h || isPrivateHost(h) || NEVER_SITES.has(site) || NEVER_SITES.has(h)) return null;
    const hashes = candidates(h, site).map(hashHost);
    for (const s of this.sources) {
      const list = this.lists.get(s.id);
      if (list && hashes.some((x) => list.has(x))) return { threat: s.threat, list: s.id };
    }
    return null;
  }

  status() {
    const metas = this.sources.map((s) => this.meta[s.id] || {});
    const updated = metas.map((m) => m.updated || 0);
    return {
      ready: this.lists.size > 0,
      count: this.sources.reduce((n, s) => n + (this.lists.get(s.id)?.size || 0), 0),
      updated: updated.every(Boolean) ? Math.min(...updated) : Math.max(0, ...updated) || null,
      error: metas.find((m) => m.error)?.error || null,
    };
  }
}

// ---------------------------------------------------------------- downloads
// Programs, scripts and installers.
const RUNNABLE = /\.(exe|scr|com|pif|bat|cmd|msi|msix|msp|vbs|vbe|js|jse|wsf|wsh|ps1|psm1|jar|hta|cpl|msc|lnk|reg|scf|inf|app|dmg|pkg|mpkg|command|sh|apk|appx|appxbundle|dll)$/i;
// A document's name in front of a program's ("invoice.pdf.exe").
const DOC_EXT = /\.(pdf|docx?|xlsx?|pptx?|rtf|txt|csv|jpe?g|png|gif|bmp|webp|heic|mp3|wav|mp4|mov|avi|mkv|zip|rar|7z|html?)$/i;
const potentiallyTrustworthy = (url) => { try { const u = new URL(url); return u.protocol === 'https:' || isPrivateHost(u.hostname); } catch { return false; } };

// Why a download is risky, or null. listed(url) → threat | null.
function downloadDanger({ url, chain = [], filename = '', pageUrl = '', listed = () => null }) {
  const urls = [...new Set([...chain, url].filter(Boolean))];
  if (urls.some((u) => listed(u)) || (pageUrl && /^https?:/.test(pageUrl) && listed(pageUrl))) {
    return { kind: 'dangerous', title: 'Dangerous file blocked', detail: 'It comes from a site on Lumio’s lists of dangerous sites. It could harm your computer or steal your information.' };
  }
  const name = String(filename);
  const stem = name.replace(RUNNABLE, '');
  if ((RUNNABLE.test(name) && DOC_EXT.test(stem.trimEnd())) || (/[‪-‮⁦-⁩]/.test(name)) || (RUNNABLE.test(name) && /\s{5,}\S*$/.test(stem))) {
    return { kind: 'deceptive', title: 'This file’s name is misleading', detail: 'It looks like a document, but it’s a program that could harm your computer.' };
  }
  const plainHop = urls.some((u) => /^http:/i.test(u) && !potentiallyTrustworthy(u));
  if (plainHop && /^https:/i.test(pageUrl)) {
    return { kind: 'insecure', title: 'Insecure download blocked', detail: 'This file was sent over a connection that isn’t secure, so someone could have changed it on the way.' };
  }
  return null;
}

module.exports = { SafeBrowsing, SOURCES, parseLine, parseList, hashHost, buildHashes, HashList, candidates, isPrivateHost, downloadDanger, NEVER_SITES };
