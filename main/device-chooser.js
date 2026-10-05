// Device choosers: a site asks for a USB, HID (game controllers, special
// keyboards), serial or Bluetooth device, and Lumio lists the matching ones
// over the tab (overlay kind 'device', renderer/ui/overlay-security.js). The
// person picks one to connect, or cancels. Sites blocked in Site settings
// get no chooser. Chromium remembers a connected device for the site until
// Lumio quits.
//
// Also: a site's file picker (File System Access) pointed at a folder with
// system files is refused, with a choice to pick another one.
const { webContents: allWebContents, dialog, BrowserWindow } = require('electron');
const { originOf } = require('./site-settings');

const hex = (n) => Number(n || 0).toString(16).padStart(4, '0');

// What the chooser lists for a device.
function describe(kind, d) {
  if (kind === 'usb') return { id: d.deviceId, name: d.productName || `Unknown device (${hex(d.vendorId)}:${hex(d.productId)})`, sub: d.manufacturerName || '' };
  if (kind === 'hid') return { id: d.deviceId, name: d.name || `Unknown device (${hex(d.vendorId)}:${hex(d.productId)})`, sub: '' };
  if (kind === 'serial') return { id: d.portId, name: d.displayName || d.portName || 'Serial port', sub: d.displayName && d.portName ? d.portName : '' };
  return { id: d.deviceId, name: d.deviceName || `Unknown or unsupported device (${d.deviceId})`, sub: '' };
}

// The chooser's rows: one per device (a device can show up more than once,
// one for each of its interfaces).
const listed = (kind, devices) => [...new Map(devices.map((d) => describe(kind, d)).map((it) => [it.id, it])).values()];

const KIND_NAMES = { usb: 'a USB device', hid: 'a HID device', serial: 'a serial port', bluetooth: 'a Bluetooth device' };

class DeviceChoosers {
  // settings: the profile's SiteSettings. findTab(wc) → { w, tab } | null.
  constructor({ session, settings, findTab }) {
    this.settings = settings;
    this.findTab = findTab;
    this.pending = new Map(); // id -> { id, kind, callback, devices, w, wcId, host }
    this.nextId = 1;
    const frameWc = (frame) => { try { return frame ? allWebContents.fromFrame(frame) : null; } catch { return null; } };
    this.listeners = [
      ['select-usb-device', (e, details, cb) => { e.preventDefault(); this.ask('usb', frameWc(details.frame), details.deviceList, cb); }],
      ['select-hid-device', (e, details, cb) => { e.preventDefault(); this.ask('hid', frameWc(details.frame), details.deviceList, cb); }],
      ['select-serial-port', (e, ports, wc, cb) => { e.preventDefault(); this.ask('serial', wc, ports, cb); }],
      ['usb-device-added', (_e, device, wc) => this.update('usb', wc?.id, device, true)],
      ['usb-device-removed', (_e, device, wc) => this.update('usb', wc?.id, device, false)],
      ['hid-device-added', (_e, d) => this.update('hid', frameWc(d.frame)?.id, d.device, true)],
      ['hid-device-removed', (_e, d) => this.update('hid', frameWc(d.frame)?.id, d.device, false)],
      ['serial-port-added', (_e, port, wc) => this.update('serial', wc?.id, port, true)],
      ['serial-port-removed', (_e, port, wc) => this.update('serial', wc?.id, port, false)],
      ['file-system-access-restricted', (_e, details, cb) => this.restricted(details, cb)],
    ];
    this.session = session;
    for (const [name, fn] of this.listeners) session.on(name, fn);
  }

  dispose() { for (const [name, fn] of this.listeners) this.session.removeListener(name, fn); }

  // Web Bluetooth is asked per tab, again each time more devices turn up.
  attach(tab) {
    const wc = tab.view?.webContents;
    if (!wc || wc.lumioDevices) return;
    wc.lumioDevices = true;
    wc.on('select-bluetooth-device', (e, devices, cb) => { e.preventDefault(); this.ask('bluetooth', wc, devices, cb); });
    wc.on('did-start-navigation', (d) => { if (d.isMainFrame && !d.isSameDocument) this.cancelFor(wc.id); });
    wc.once('destroyed', () => this.cancelFor(wc.id));
  }

  ask(kind, wc, devices, callback) {
    const found = wc && !wc.isDestroyed() ? this.findTab(wc) : null;
    const origin = found ? originOf(wc.getURL()) : null;
    if (!found || !origin || this.settings.value(origin, kind) === 'block') { this.answerWith(kind, callback, null); return; }
    let p = [...this.pending.values()].find((x) => x.wcId === wc.id && x.kind === kind);
    if (p) {
      // Bluetooth: the same question with more devices found.
      p.callback = callback;
      p.devices = devices.slice();
    } else {
      for (const other of this.pending.values()) if (other.w === found.w) this.answer(other.id, null);
      p = { id: this.nextId++, kind, callback, devices: devices.slice(), w: found.w, wcId: wc.id, host: new URL(origin).host };
      this.pending.set(p.id, p);
    }
    this.render(p);
  }

  // A device came or went while the chooser is open.
  update(kind, wcId, device, added) {
    const p = [...this.pending.values()].find((x) => x.kind === kind && (wcId == null || x.wcId === wcId));
    if (!p || !device) return;
    const id = describe(kind, device).id;
    p.devices = p.devices.filter((d) => describe(kind, d).id !== id);
    if (added) p.devices.push(device);
    this.render(p);
  }

  render(p) {
    const w = p.w;
    if (w.closed) return;
    const tab = w.tabs.tabs.find((t) => t.view?.webContents.id === p.wcId);
    const b = tab?.view?.getBounds() || { x: 0, y: 90, width: 900, height: 600 };
    const width = Math.min(440, b.width - 24);
    const first = w.overlayKind !== 'device';
    w.showOverlay(
      { x: b.x + Math.round((b.width - width) / 2), y: b.y + 12, width, height: Math.min(420, b.height - 24) },
      { kind: 'device', focus: first, device: { id: p.id, kind: p.kind, host: p.host, what: KIND_NAMES[p.kind], scanning: p.kind === 'bluetooth', items: listed(p.kind, p.devices) } },
    );
    if (first) w.overlay.webContents.focus();
  }

  // Connect to deviceId, or null to cancel.
  answer(id, deviceId) {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    const ok = deviceId && p.devices.some((d) => describe(p.kind, d).id === deviceId);
    this.answerWith(p.kind, p.callback, ok ? deviceId : null);
    return true;
  }

  // Each event wants "no device" said its own way.
  answerWith(kind, callback, deviceId) {
    try {
      if (deviceId) callback(deviceId);
      else if (kind === 'serial' || kind === 'bluetooth') callback('');
      else callback();
    } catch { /* the page went away */ }
  }

  // The chooser closed (Esc, a click elsewhere) or its window did.
  closed(w) { for (const p of [...this.pending.values()]) if (p.w === w) this.answer(p.id, null); }

  cancelFor(wcId) {
    for (const p of [...this.pending.values()]) {
      if (p.wcId !== wcId) continue;
      this.answer(p.id, null);
      if (!p.w.closed && p.w.overlayKind === 'device') p.w.hideOverlay();
    }
  }

  // The site's file picker chose a folder Lumio won't share (like the
  // system folder): pick another, or cancel. The event doesn't say which
  // tab asked; the picker was over the window in front.
  async restricted(details, callback) {
    const parent = BrowserWindow.getFocusedWindow();
    const opts = {
      type: 'warning',
      buttons: [details.isDirectory ? 'Choose another folder' : 'Choose another file', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: details.isDirectory ? 'Lumio can’t open this folder' : 'Lumio can’t open this file',
      detail: 'It contains system files. Choose something else to share with the site.',
    };
    const { response } = await (parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts)).catch(() => ({ response: 1 }));
    callback(response === 0 ? 'tryAgain' : 'deny');
  }
}

module.exports = { DeviceChoosers, describe, listed };
