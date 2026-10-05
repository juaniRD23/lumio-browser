// Certificates (Settings › Privacy and security › Security):
//  - Manage certificates opens the computer's own certificate manager:
//    Keychain Access on the Mac, the certificate manager (certmgr.msc) on
//    Windows. Lumio uses the certificates trusted there.
//  - Client certificates: a site that asks you to prove who you are with a
//    certificate shows a chooser over the tab (overlay kind 'clientcert',
//    renderer/ui/overlay-security.js) listing yours, each with its details.
//    The choice, or "none", is remembered for that site until Lumio quits
//    (separately for incognito).
const fs = require('fs');
const path = require('path');

// Keychain Access moved in newer macOS versions.
const KEYCHAIN = ['/System/Applications/Utilities/Keychain Access.app', '/System/Library/CoreServices/Applications/Keychain Access.app', '/Applications/Utilities/Keychain Access.app'];

// Where the certificate manager is, or null when Lumio can't open one here.
function certificateManager(platform = process.platform, exists = fs.existsSync) {
  if (platform === 'darwin') return KEYCHAIN.find((p) => exists(p)) || null;
  if (platform === 'win32') return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'certmgr.msc');
  return null;
}

// What the chooser shows about a certificate (Electron's Certificate).
function certInfo(c, i) {
  const who = (p) => p ? [p.commonName, ...(p.organizations || []), ...(p.organizationUnits || []), p.locality, p.state, p.country].filter(Boolean) : [];
  return {
    index: i,
    subject: c.subject?.commonName || c.subjectName || 'Certificate',
    issuer: c.issuer?.commonName || c.issuerName || '',
    subjectLines: who(c.subject),
    issuerLines: who(c.issuer),
    validStart: (c.validStart || 0) * 1000,
    validExpiry: (c.validExpiry || 0) * 1000,
    serial: c.serialNumber || '',
    fingerprint: c.fingerprint || '',
  };
}

class ClientCertificates {
  // findTab(wc) → { w, tab } | null.
  constructor({ findTab }) {
    this.findTab = findTab;
    this.remembered = new WeakMap(); // session -> Map(host -> fingerprint | null)
    this.pending = new Map(); // id -> { callbacks, list, w, host, ses }
    this.nextId = 1;
  }

  // app 'select-client-certificate'.
  select(event, wc, url, list, callback) {
    event.preventDefault();
    let host = '';
    try { host = new URL(url).host; } catch { /* keep empty */ }
    const ses = wc?.session;
    const memory = ses && this.remembered.get(ses);
    if (memory?.has(host)) {
      const fp = memory.get(host);
      const cert = fp && list.find((c) => c.fingerprint === fp);
      // The chosen certificate is gone (removed from the keychain): ask again.
      if (!fp || cert) { callback(cert || undefined); return; }
    }
    this.ask(wc, host, list, callback);
  }

  ask(wc, host, list, callback) {
    const found = wc && !wc.isDestroyed() ? this.findTab(wc) : null;
    // Only a tab can show the chooser (Lumio's own windows never need one).
    if (!found || !list.length) { callback(); return; }
    const { w, tab } = found;
    // The same site asking again while the chooser is open gets the same answer.
    for (const p of this.pending.values()) {
      if (p.w === w && p.host === host && p.ses === wc.session) { p.callbacks.push(callback); return; }
    }
    this.closed(w); // another site's chooser in this window gives way
    const id = this.nextId++;
    this.pending.set(id, { callbacks: [callback], list, w, host, ses: wc.session });
    const b = tab.view?.getBounds() || { x: 0, y: 90, width: 900, height: 600 };
    const width = Math.min(460, b.width - 24);
    w.showOverlay(
      { x: b.x + Math.round((b.width - width) / 2), y: b.y + 12, width, height: Math.min(460, b.height - 24) },
      { kind: 'clientcert', focus: true, cert: { id, host, items: list.map(certInfo) } },
    );
    w.overlay.webContents.focus();
  }

  // index: the chosen certificate, or null for none. Either is remembered
  // for the site until Lumio quits.
  answer(id, index) {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    const cert = Number.isInteger(index) ? p.list[index] : null;
    if (p.ses) {
      if (!this.remembered.has(p.ses)) this.remembered.set(p.ses, new Map());
      this.remembered.get(p.ses).set(p.host, cert ? cert.fingerprint : null);
    }
    for (const cb of p.callbacks) { try { cb(cert || undefined); } catch { /* the request went away */ } }
    return true;
  }

  // The chooser closed without an answer: no certificate this time (not remembered).
  closed(w) {
    for (const [id, p] of this.pending) {
      if (p.w !== w) continue;
      this.pending.delete(id);
      for (const cb of p.callbacks) { try { cb(); } catch { /* gone */ } }
    }
  }
}

module.exports = { ClientCertificates, certificateManager, certInfo };
