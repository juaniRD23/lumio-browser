// The share popover under the address bar's Share button (renderer/ui/share.js
// opens it; main/share.js does the sharing): copy the link, a QR code made
// right here (renderer/assets/qr.js), send it to your other computers,
// screenshot, save, install as an app, and on the Mac the system's share
// sheet. A website's Share button (navigator.share) opens it too.
// Also the Install app / Create shortcut dialog (main/apps.js).
import { qrMatrix } from '/assets/qr.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pretty = (u) => String(u || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
const svg = (d, size = 17) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const SHARE_ICON = svg('<path d="M12 3.5v11M8 7.5l4-4 4 4"/><path d="M8.5 10.5H7a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1.5"/>', 16);
const I = {
  link: svg('<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>'),
  text: svg('<path d="M5 6.5h14M5 11h14M5 15.5h9"/>'),
  qr: svg('<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 19.5v.5M20 14v.5"/>'),
  devices: svg('<rect x="3" y="5" width="14" height="10" rx="1.5"/><path d="M1.5 18.5h17"/><rect x="18" y="9" width="4.5" height="10" rx="1"/>'),
  camera: svg('<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.5" r="3.5"/>'),
  save: svg('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  app: svg('<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/>'),
  shortcut: svg('<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M10 14l5-5M10.5 9H15v4.5"/>'),
  more: svg('<circle cx="6" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.3" fill="currentColor" stroke="none"/>'),
  next: svg('<path d="M9 6l6 6-6 6"/>', 14),
  back: svg('<path d="M15 18l-6-6 6-6"/>', 16),
  x: svg('<path d="M7 7l10 10M17 7L7 17"/>', 14),
  globe: svg('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17"/>', 16),
  mac: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6M12 16v4"/>'),
  pc: svg('<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>'),
};

function ago(t) {
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 2) return 'Active now';
  if (m < 60) return `Active ${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `Active ${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `Active ${d} day${d === 1 ? '' : 's'} ago`;
}

// ---------------------------------------------------------------- QR codes
// Black on white in both appearances (scanners need dark on light), with
// Lumio's mark in the middle when there's enough error correction to cover it.
const QUIET = 4;
export function drawQr(canvas, text, { px = 512 } = {}) {
  const m = qrMatrix(text, { ecc: 'Q' });
  if (!m) return null;
  const n = m.size + QUIET * 2;
  const scale = Math.max(2, Math.floor(px / n));
  canvas.width = canvas.height = n * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111111';
  m.modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) ctx.fillRect((x + QUIET) * scale, (y + QUIET) * scale, scale, scale); }));
  if (m.ecc === 'Q' || m.ecc === 'H') {
    const box = Math.round(m.size * 0.22) * scale;
    const c = canvas.width / 2;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect(c - box / 2, c - box / 2, box, box, box * 0.24);
    ctx.fill();
    const mark = box * 0.72;
    ctx.save();
    ctx.translate(c - mark / 2, c - mark / 2);
    ctx.scale(mark / 64, mark / 64);
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#111111';
    ctx.stroke(new Path2D('M35 12a21 21 0 1 0 17 19'));
    ctx.fillStyle = '#2563eb';
    ctx.beginPath();
    ctx.arc(48, 17, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  return m;
}

const canvasPng = (canvas) => new Promise((resolve) => canvas.toBlob(async (b) => resolve(b ? new Uint8Array(await b.arrayBuffer()) : null), 'image/png'));

// ---------------------------------------------------------------- views
function header(p) {
  const fav = p.favicon ? `<img src="${esc(p.favicon)}" alt="">` : I.globe;
  const title = p.web ? (p.title || p.host || 'Shared text') : (p.title || p.host || pretty(p.url));
  return `<div class="sh-head">
      <span class="sh-fav">${fav}</span>
      <span class="sh-meta"><b class="sh-title" id="sh-title">${esc(title)}</b><span class="sh-url">${esc(p.url ? pretty(p.url) : p.web?.text || '')}</span></span>
      <button type="button" class="sh-x" data-act="close" title="Close (Esc)" aria-label="Close">${I.x}</button>
    </div>`;
}
const row = (attr, icon, label, extra = '') => `<button type="button" class="sh-row" role="menuitem" ${attr}><span class="ic">${icon}</span><span class="t">${esc(label)}</span>${extra}</button>`;

function mainView(p) {
  const rows = [];
  const hasUrl = !!p.url;
  rows.push(row('data-act="copy"', hasUrl ? I.link : I.text, hasUrl ? 'Copy link' : 'Copy text'));
  if (hasUrl) rows.push(row('data-view="qr"', I.qr, 'QR code', `<span class="go">${I.next}</span>`));
  if (hasUrl && p.devices?.length) rows.push(row('data-view="devices"', I.devices, 'Send to your devices', `<span class="go">${I.next}</span>`));
  const page = p.page || {};
  const tools = [
    page.screenshot && row('data-act="screenshot"', I.camera, 'Screenshot'),
    page.save && row('data-act="save"', I.save, 'Save page as…'),
    page.apps && row('data-act="install"', I.app, 'Install page as app…'),
    page.apps && row('data-act="shortcut"', I.shortcut, 'Create shortcut…'),
  ].filter(Boolean);
  if (tools.length) rows.push('<div class="sh-sep" role="separator"></div>', ...tools);
  if (p.native) rows.push('<div class="sh-sep" role="separator"></div>', row('data-act="native"', I.more, 'More…'));
  const asked = p.web ? `<div class="sh-web"><b>${esc(p.web.host)}</b> wants to share${p.web.text && p.url ? `<q>${esc(p.web.text)}</q>` : ''}</div>` : '';
  return `<div class="sh" role="dialog" aria-labelledby="sh-title">${header(p)}${asked}<div class="sh-list" role="menu" aria-label="Share">${rows.join('')}</div></div>`;
}

function subHead(title, id) {
  return `<div class="sh-head sub">
      <button type="button" class="sh-x" data-view="main" title="Back" aria-label="Back">${I.back}</button>
      <b class="sh-title" id="${id}">${esc(title)}</b><span class="spacer"></span>
      <button type="button" class="sh-x" data-act="close" title="Close (Esc)" aria-label="Close">${I.x}</button>
    </div>`;
}

function qrView(p) {
  return `<div class="sh" role="dialog" aria-labelledby="qr-title">${subHead('QR code', 'qr-title')}
    <div class="qr-box"><canvas class="qr" role="img" aria-label="QR code for ${esc(pretty(p.url))}"></canvas><p class="qr-err" hidden>This link is too long for a QR code.</p></div>
    <div class="qr-url" title="${esc(p.url)}">${esc(pretty(p.url))}</div>
    <div class="qr-note">Scan it with a phone’s camera. It’s made on this computer.</div>
    <div class="pws-actions"><span class="spacer"></span><button type="button" class="acc-btn ghost" data-act="qr-copy">Copy</button><button type="button" class="acc-btn primary" data-act="qr-save">Download</button></div>
  </div>`;
}

function devicesView(p) {
  const list = (p.devices || []).map((d) => `<button type="button" class="sh-row dev" role="menuitem" data-act="send" data-device="${esc(d.id)}">
      <span class="ic">${d.platform === 'mac' ? I.mac : I.pc}</span><span class="t"><b>${esc(d.name)}</b><small>${esc(ago(d.lastSeen))}</small></span></button>`).join('');
  return `<div class="sh" role="dialog" aria-labelledby="dev-title">${subHead('Send to your devices', 'dev-title')}
    <div class="sh-list" role="menu" aria-label="Your devices">${list}</div>
    <div class="qr-note dev-note">They get a notification and can open the page there.</div>
  </div>`;
}

// Arrows move between the popover's buttons and fields.
function arrowKeys(card, e) {
  if (!['ArrowDown', 'ArrowUp'].includes(e.key) || e.target.matches('input[type=text], textarea, select')) return;
  const list = [...card.querySelectorAll('button:not(:disabled), input')];
  const i = list.indexOf(e.target);
  const next = list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length];
  if (next) { e.preventDefault(); next.focus(); }
}

// Wires the share popover into the overlay's card; render() draws each payload.
export function initShareBubble(card, api, isOpen, reportSize) {
  let p = null;
  let view = 'main';
  const close = (refocus = false) => {
    if (refocus) api.send('share:refocus');
    api.send('overlay:pick', { kind: 'share', refocus });
  };
  function draw(focusFirst) {
    card.innerHTML = view === 'qr' ? qrView(p) : view === 'devices' ? devicesView(p) : mainView(p);
    if (view === 'qr') {
      const ok = drawQr(card.querySelector('canvas.qr'), p.url);
      if (!ok) { card.querySelector('canvas.qr').hidden = true; card.querySelector('.qr-err').hidden = false; card.querySelectorAll('[data-act^="qr-"]').forEach((b) => { b.disabled = true; }); }
    }
    card.querySelectorAll('.sh-fav img').forEach((img) => { img.onerror = () => { img.outerHTML = I.globe; }; });
    reportSize();
    if (focusFirst) (card.querySelector('.sh-list .sh-row, .pws-actions .primary:not(:disabled)') || card.querySelector('button'))?.focus();
  }

  card.addEventListener('click', async (e) => {
    if (!isOpen('share')) return;
    const keyboard = e.detail === 0;
    const toView = e.target.closest('[data-view]')?.dataset.view;
    if (toView) { view = toView; draw(true); return; }
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'close') { close(keyboard); return; }
    const base = { tabId: p.tabId, url: p.url, title: p.title };
    if (act === 'qr-copy' || act === 'qr-save') {
      const png = await canvasPng(card.querySelector('canvas.qr'));
      if (png) api.send('share:action', { ...base, action: act, png, name: `QR code ${p.host || 'link'}` });
      return;
    }
    api.send('share:action', { ...base, action: act, ...(el.dataset.device ? { deviceId: el.dataset.device } : {}) });
  });
  card.addEventListener('keydown', (e) => {
    if (!isOpen('share')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (view !== 'main') { view = 'main'; draw(true); } else close(true);
      return;
    }
    if (e.key === 'ArrowLeft' && view !== 'main') { e.preventDefault(); view = 'main'; draw(true); return; }
    arrowKeys(card, e);
  });

  return {
    render(payload) {
      p = payload;
      view = payload.view || 'main';
      if (view === 'devices' && !payload.devices?.length) view = 'main';
      draw(!!payload.focus);
    },
  };
}

// ---------------------------------------------------------------- Install app / Create shortcut
// A tile with the site's first letter, for sites without a good icon.
const TILE = ['#2563eb', '#7c3aed', '#0f766e', '#c2410c', '#be185d', '#4d7c0f', '#0e7490', '#b45309'];
export function letterIcon(canvas, name, host, size = 256) {
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  let h = 0;
  for (const ch of host || name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  ctx.fillStyle = TILE[h % TILE.length];
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, size * 0.22);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = `600 ${Math.round(size * 0.5)}px Geist, -apple-system, 'Segoe UI', sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(([...String(name || host || '?').trim()][0] || '?').toUpperCase(), size / 2, size / 2 + size * 0.03);
}

export function initInstallDialog(card, api, isOpen, reportSize) {
  let p = null;
  const close = (refocus = false) => {
    if (refocus) api.send('share:refocus');
    api.send('overlay:pick', { kind: 'install', refocus });
  };
  async function install() {
    const name = card.querySelector('#ins-name').value.trim();
    if (!name) { card.querySelector('#ins-name').focus(); return; }
    const win = p.shortcut ? card.querySelector('#ins-window').checked : true;
    let iconPng = null;
    if (!p.icon) {
      const c = document.createElement('canvas');
      letterIcon(c, name, p.host);
      iconPng = await canvasPng(c);
    }
    api.send('apps:install', { token: p.token, name, window: win, iconPng });
  }
  card.addEventListener('click', (e) => {
    if (!isOpen('install')) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'cancel') close(e.detail === 0);
    else if (act === 'install') install();
  });
  card.addEventListener('keydown', (e) => {
    if (!isOpen('install')) return;
    if (e.key === 'Escape') { e.preventDefault(); close(true); return; }
    if (e.key === 'Enter' && e.target.matches('#ins-name, #ins-window')) { e.preventDefault(); install(); return; }
    arrowKeys(card, e);
  });
  // A letter tile as you type the name (for sites without an icon).
  card.addEventListener('input', (e) => {
    if (!isOpen('install') || !e.target.matches('#ins-name') || p.icon) return;
    letterIcon(card.querySelector('canvas.ins-icon'), e.target.value, p.host, 128);
  });

  return {
    render(payload) {
      p = payload;
      const where = payload.platform === 'darwin' ? 'Lumio adds it to Applications › Lumio Apps. Drag it to the Dock to keep it there.' : 'Find it later in Lumio’s Apps page.';
      card.innerHTML = `<div class="ins" role="dialog" aria-labelledby="ins-title" aria-describedby="ins-note">
        <div class="ins-title" id="ins-title">${payload.shortcut ? 'Create shortcut?' : 'Install app?'}</div>
        <div class="ins-app">
          ${payload.icon ? `<img class="ins-icon" src="${esc(payload.icon)}" alt="">` : '<canvas class="ins-icon" aria-hidden="true"></canvas>'}
          <div class="ins-fields">
            <label class="pws-field"><span>Name</span><input id="ins-name" type="text" maxlength="60" spellcheck="false" autocomplete="off" value="${esc(payload.name)}"></label>
            <div class="ins-host">${esc(payload.host)}</div>
          </div>
        </div>
        ${payload.shortcut ? '<label class="tb-check ins-check"><input type="checkbox" id="ins-window" checked><span>Open as window</span></label>' : ''}
        <p class="ins-note" id="ins-note">${payload.shortcut ? 'It opens this page' : 'It opens in its own window, without tabs'}. ${esc(where)}</p>
        <div class="pws-actions"><span class="spacer"></span><button type="button" class="acc-btn ghost" data-act="cancel">Cancel</button><button type="button" class="acc-btn primary" data-act="install">${payload.shortcut ? 'Create' : 'Install'}</button></div>
      </div>`;
      if (!payload.icon) letterIcon(card.querySelector('canvas.ins-icon'), payload.name, payload.host, 128);
      reportSize();
      const input = card.querySelector('#ins-name');
      input.focus();
      input.select();
    },
  };
}
