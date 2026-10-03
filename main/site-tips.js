// Site tips: short notes on how to get things done on a site ("Google Sheets:
// select a cell with the Name Box, then paste rows"), so Lumio starts the next
// task there with the shortcut instead of exploring. Lumio saves them itself
// (the save_site_tip tool) when it learns something; a few come built in.
// Kept on this computer in site-tips.json; the user sees and deletes them in
// Settings › Lumio AI.
const fs = require('fs');
const path = require('path');

const MAX_PER_SITE = 6;
const MAX_SITES = 200;
const MAX_TIP = 300;

// Built in: sites where the obvious way is slow or doesn't work.
const BUILT_IN = [
  {
    host: 'docs.google.com', path: '/spreadsheets',
    tip: 'Google Sheets: cells are drawn on a canvas, so read_page doesn’t list them. To go to a cell, type it (like B2) into the Name Box at the top left with submit=true. To fill many cells, go to the top-left cell that way, then paste_text all the rows at once (tabs between columns, new lines between rows): one value per cell, short (put notes in their own column). After typing into a single cell, press Enter so it isn’t left in editing. To check cells, use screenshot_tab.',
  },
  {
    host: 'docs.google.com', path: '/document',
    tip: 'Google Docs: the text is drawn on a canvas. Click inside the page to place the cursor, then type or paste_text (paste_text is much faster for long text). To check the document, use screenshot_tab.',
  },
];

const siteOf = (url) => {
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch { return ''; }
};

// No personal data in a tip: emails, phone or card-like numbers, addresses with digits.
function looksPersonal(text) {
  return /[\w.+-]+@[\w-]+\.[\w.]+/.test(text) || /\d[\d\s-]{7,}\d/.test(text) || /\b(password|passcode|ssn|social security)\b/i.test(text);
}

class SiteTips {
  constructor(dir) {
    this.file = dir ? path.join(dir, 'site-tips.json') : null;
    this.sites = {};
    this.listeners = new Set();
    try { this.sites = JSON.parse(fs.readFileSync(this.file, 'utf8')).sites || {}; } catch { /* none yet */ }
  }

  save() {
    if (this.file) {
      try {
        fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ sites: this.sites }, null, 2));
        fs.renameSync(`${this.file}.tmp`, this.file);
      } catch { /* not critical */ }
    }
    for (const fn of this.listeners) fn();
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  // Lumio learned something: keep it (newest first, a few per site).
  add(site, tip) {
    const host = siteOf(site);
    const text = String(tip || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TIP);
    if (!host || !host.includes('.')) throw new Error('Give the site, like docs.google.com.');
    if (text.length < 12) throw new Error('Write the tip as a short sentence.');
    if (looksPersonal(text)) throw new Error('Tips can’t include personal details (emails, numbers, passwords). Describe how the site works instead.');
    const list = (this.sites[host] || []).filter((t) => t.tip.toLowerCase() !== text.toLowerCase());
    list.unshift({ tip: text, at: Date.now() });
    this.sites[host] = list.slice(0, MAX_PER_SITE);
    const hosts = Object.keys(this.sites);
    if (hosts.length > MAX_SITES) {
      const oldest = hosts.sort((a, b) => (this.sites[a][0]?.at || 0) - (this.sites[b][0]?.at || 0))[0];
      delete this.sites[oldest];
    }
    this.save();
    return { site: host, tip: text };
  }

  remove(site, tip) {
    const host = siteOf(site);
    if (!this.sites[host]) return false;
    this.sites[host] = this.sites[host].filter((t) => t.tip !== tip);
    if (!this.sites[host].length) delete this.sites[host];
    this.save();
    return true;
  }

  // Everything saved (for Settings), newest site first.
  list() {
    return Object.entries(this.sites)
      .map(([site, tips]) => ({ site, tips: tips.map((t) => ({ tip: t.tip, at: t.at })) }))
      .sort((a, b) => (b.tips[0]?.at || 0) - (a.tips[0]?.at || 0));
  }

  // The tips for a page: built-in ones that match its address, then saved ones.
  forUrl(url) {
    let u;
    try { u = new URL(url); } catch { return []; }
    if (!/^https?:$/.test(u.protocol)) return [];
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const builtIn = BUILT_IN.filter((b) => b.host === host && u.pathname.startsWith(b.path)).map((b) => b.tip);
    return [...builtIn, ...(this.sites[host] || []).map((t) => t.tip)];
  }
}

// What the model reads: a short block, marked as coming from Lumio Browser.
function tipsNote(site, tips) {
  return `[Lumio Browser, not the user] Tips for ${site} (from earlier tasks; use them if they fit, ignore them if the site changed):\n${tips.map((t) => `- ${t}`).join('\n')}`;
}

module.exports = { SiteTips, tipsNote, siteOf, looksPersonal, BUILT_IN };
