// The AI panel's composer extras, same as Lumio Chat on the website:
//   +      add photos & files (up to 10) and turn connected apps on or off
//   tray   what's attached to the next message
//   ring   how much of the plan is used (click for details)
//   cards  pictures and files Lumio made (saved in Downloads)
// Files are read here with Lumio Chat's own code (web/attach.js); documents
// Lumio writes are built with web/docmaker.js and sent back to the main process.
import { icons } from './icons.js';

const MAX_FILES = 10;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (s) => document.querySelector(s);

// Connected-app and file looks (match the website).
const GLYPH = {
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m4 7 8 6 8-6"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  cloud: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7.5 19a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18.4 9.1 5 5 0 0 1 17.5 19z"/></svg>',
  drive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="M8.5 3.5h7l6 10.5-3.5 6h-12L2.5 14z"/><path d="M8.5 3.5 15 14H2.5M15.5 3.5 9 14l3 6"/></svg>',
};
const APP_LOOK = {
  google_drive: ['#1E8E3E', GLYPH.drive], gmail: ['#D93025', GLYPH.mail], google_calendar: ['#1A73E8', GLYPH.cal],
  outlook: ['#0F6CBD', GLYPH.mail], outlook_calendar: ['#0F6CBD', GLYPH.cal], onedrive: ['#0364B8', GLYPH.cloud],
  word: ['#185ABD', 'W'], powerpoint: ['#C43E1C', 'P'], excel: ['#107C41', 'X'],
};
const appLogo = (id) => { const [bg, g] = APP_LOOK[id] || ['#444', '?']; return `<span class="logo" style="background:${bg}">${g}</span>`; };
function fileLook(name = '') {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = { pdf: ['PDF', '#D93025'], docx: ['DOC', '#185ABD'], pptx: ['PPT', '#C43E1C'], xlsx: ['XLS', '#107C41'], csv: ['CSV', '#107C41'], md: ['MD', '#555b66'], txt: ['TXT', '#555b66'], html: ['HTML', '#b4570a'] };
  return map[ext] || [ext.slice(0, 4).toUpperCase() || 'FILE', '#555b66'];
}
export const ficon = (name) => { const [label, color] = fileLook(name); return `<span class="ficon" style="background:${color}">${esc(label)}</span>`; };

// Popovers inside the composer: one open at a time.
function popover(btn, pop, onOpen) {
  const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  const open = () => {
    document.querySelectorAll('#composer .popover').forEach((p) => { if (p !== pop) p.hidden = true; });
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    onOpen?.();
  };
  btn.addEventListener('click', () => (pop.hidden ? open() : close()));
  document.addEventListener('mousedown', (e) => { if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) close(); });
  pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); btn.focus(); } });
  return { open, close };
}

const toDataUrl = (blob) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(blob); });
async function thumbOf(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const s = 96 / Math.max(bmp.width, bmp.height);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * s));
    c.height = Math.max(1, Math.round(bmp.height * s));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.7);
  } catch { return null; }
}

export function initExtras({ api, getAi, onChange, notice }) {
  let attachments = []; // { key, name, kind, status: busy|ready|error, items: [{ kind, name, dataUrl?, thumb?, text?, pages? }], preview }
  let web = null;
  const lib = () => (web ??= import('./web/attach.js'));

  // ------------------------------------------------------------ attachments
  const input = $('#file-input');
  lib().then((m) => { input.accept = m.ACCEPT; }).catch(() => {});

  function renderTray() {
    const tray = $('#tray');
    tray.hidden = !attachments.length;
    tray.innerHTML = attachments.map((a) => {
      const pic = a.preview && a.kind === 'image';
      const body = pic ? `<img src="${a.preview}" alt="">`
        : `${ficon(a.name)}<span class="fname"><b>${esc(a.name)}</b><small>${a.status === 'busy' ? 'Reading…' : a.status === 'error' ? 'Couldn’t attach' : esc(a.meta || '')}</small></span>`;
      return `<div class="att ${pic ? 'pic' : ''} ${a.status}" title="${esc(a.error || a.name)}">${body}<button type="button" class="x" data-key="${a.key}" aria-label="Remove ${esc(a.name)}">×</button></div>`;
    }).join('');
    onChange();
  }
  $('#tray').addEventListener('click', (e) => {
    const key = e.target.closest('[data-key]')?.dataset.key;
    if (!key) return;
    const a = attachments.find((x) => x.key === key);
    if (a?.preview) URL.revokeObjectURL(a.preview);
    attachments = attachments.filter((x) => x.key !== key);
    renderTray();
  });

  async function read(file) {
    const m = await lib();
    const kind = m.kindOf(file);
    if (kind === 'heic') throw new Error(`${file.name}: HEIC photos aren’t supported yet. Export it as JPEG first.`);
    if (!kind) throw new Error(`Lumio can’t read ${(file.name.split('.').pop() || 'that').toUpperCase()} files yet.`);
    if (kind === 'image') {
      const img = await m.shrink(file, 1600);
      return { items: [{ kind: 'image', name: file.name, dataUrl: await toDataUrl(img), thumb: await thumbOf(img) }], meta: 'Picture' };
    }
    if (kind === 'text') return { items: [{ kind: 'text', name: file.name, text: await m.readText(file) }], meta: 'Text' };
    if (kind === 'office') {
      if (file.size > 25 * 1024 * 1024) throw new Error(`${file.name} is over 25 MB.`);
      const out = await api.invoke('ai:extract', { name: file.name, type: file.type, data: await file.arrayBuffer() });
      return { items: [{ kind: 'text', name: file.name, text: out.text }], meta: out.kind === 'pptx' ? `${out.parts} slides` : out.kind === 'xlsx' ? `${out.parts} sheets` : 'Word' };
    }
    const pdf = await m.readPdf(file);
    if (pdf.text) return { items: [{ kind: 'text', name: file.name, text: pdf.text, pages: pdf.pages }], meta: `${pdf.pages} page${pdf.pages === 1 ? '' : 's'}` };
    const items = [];
    for (const p of pdf.images) items.push({ kind: 'image', name: p.name, dataUrl: await toDataUrl(p), thumb: await thumbOf(p) });
    return { items, meta: `Scanned, ${items.length} page pictures` };
  }

  function add(files) {
    for (const file of files) {
      if (attachments.length >= MAX_FILES) { notice(`You can attach up to ${MAX_FILES} files per message.`); break; }
      const a = { key: crypto.randomUUID(), name: file.name, kind: file.type.startsWith('image/') ? 'image' : 'file', status: 'busy', items: [], preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null };
      attachments.push(a);
      read(file)
        .then((r) => { a.items = r.items; a.meta = r.meta; a.status = 'ready'; })
        .catch((err) => { a.status = 'error'; a.error = err.message; notice(err.message); })
        .finally(renderTray);
    }
    renderTray();
  }
  input.addEventListener('change', () => { add([...input.files]); input.value = ''; $('#prompt').focus(); });
  $('#prompt').addEventListener('paste', (e) => { const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); add(files); } });
  const panel = $('#panel');
  panel.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); panel.classList.add('dropping'); } });
  panel.addEventListener('dragleave', (e) => { if (!panel.contains(e.relatedTarget)) panel.classList.remove('dropping'); });
  panel.addEventListener('drop', (e) => { panel.classList.remove('dropping'); if (e.dataTransfer?.files?.length) { e.preventDefault(); add([...e.dataTransfer.files]); } });

  // ------------------------------------------------------------ + menu: files and connections
  const plusBtn = $('#plus-btn');
  plusBtn.innerHTML = icons.plus || '+';
  const plus = popover(plusBtn, $('#plus-menu'), () => { loadApps(); $('#add-files').focus(); });
  $('#add-files').addEventListener('click', () => { plus.close(); input.click(); });
  async function loadApps() {
    const list = $('#apps');
    if (!getAi().lumio?.signedIn) { list.innerHTML = '<div class="apps-empty">Sign in to Lumio to connect apps.</div>'; return; }
    const data = await api.invoke('ai:connections').catch(() => null);
    const apps = data?.apps || [];
    list.innerHTML = apps.length ? apps.map((a) => `
      <div class="app-row">${appLogo(a.id)}<span class="an"><b>${esc(a.name)}</b><small>${esc(a.connected ? a.account || 'Connected' : a.blurb)}</small></span>
        ${a.connected ? `<label class="switch" title="Use ${esc(a.name)} in chats"><input type="checkbox" data-app="${esc(a.service === 'files' ? 'OneDrive' : a.name)}" ${a.on ? 'checked' : ''} aria-label="Use ${esc(a.name)}"><i></i></label>`
          : a.available ? `<button type="button" class="connect" data-connect="${esc(a.id)}">Connect</button>` : '<span class="soon">Soon</span>'}
      </div>`).join('') : '<div class="apps-empty">Couldn’t load connections.</div>';
  }
  $('#apps').addEventListener('change', async (e) => {
    const name = e.target.dataset.app;
    if (name) { await api.invoke('ai:set-app', name, e.target.checked); loadApps(); }
  });
  $('#apps').addEventListener('click', (e) => {
    const id = e.target.closest('[data-connect]')?.dataset.connect;
    if (id) { plus.close(); api.send('ai:connect', id); }
  });

  // ------------------------------------------------------------ usage ring
  const RING = 2 * Math.PI * 8.5;
  const ringBtn = $('#usage-btn');
  ringBtn.innerHTML = '<svg class="ring" viewBox="0 0 24 24" aria-hidden="true"><circle class="ring-bg" cx="12" cy="12" r="8.5"/><circle class="ring-fg" cx="12" cy="12" r="8.5"/></svg>';
  const when = (t) => new Date(t).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  function renderUsagePop() {
    const l = getAi().lumio || {};
    const u = l.usage;
    const pop = $('#usage-pop');
    if (!l.signedIn || !u) { pop.innerHTML = '<p>Sign in to Lumio to see your usage.</p>'; return; }
    const used = u.limit ? Math.min(100, Math.round((u.used / u.limit) * 100)) : 100;
    pop.innerHTML = `
      <div class="u-top"><span class="u-plan">Lumio ${esc(l.planName || u.planName || 'Free')}</span>${l.plan !== 'max' ? '<button type="button" class="u-up">Upgrade</button>' : ''}</div>
      <div class="u-label">Weekly usage</div>
      <div class="u-bar"><i style="width:${used}%"></i></div>
      <div class="u-nums"><span><b>${used}%</b> used</span><span>${100 - used}% left</span></div>
      ${u.used > 0 && u.fullAt ? `<p>It refills bit by bit, and fully by <b>${esc(when(u.fullAt))}</b>.</p>` : '<p>Your full weekly usage is available.</p>'}
      <p>Lumio Browser, Chat and pictures share it. No 5-hour limits.</p>`;
    pop.querySelector('.u-up')?.addEventListener('click', () => { usage.close(); api.send('account:open', 'upgrade'); });
  }
  const usage = popover(ringBtn, $('#usage-pop'), renderUsagePop);
  function renderRing() {
    const l = getAi().lumio || {};
    const u = l.usage;
    ringBtn.hidden = !l.signedIn;
    const used = u?.limit ? Math.min(1, u.used / u.limit) : 0;
    const fg = ringBtn.querySelector('.ring-fg');
    fg.style.strokeDasharray = RING;
    fg.style.strokeDashoffset = RING * (1 - used);
    ringBtn.classList.toggle('high', used >= 0.8 && used < 1);
    ringBtn.classList.toggle('full', used >= 1);
    ringBtn.title = u ? `Usage: ${Math.round(used * 100)}% of this week’s used` : 'Usage';
    if (!$('#usage-pop').hidden) renderUsagePop();
  }

  // ------------------------------------------------------------ documents Lumio writes
  api.on('ai-build-doc', async ({ id, spec }) => {
    try {
      const { buildFile } = await import('./web/docmaker.js');
      const blob = await buildFile(spec);
      api.send('ai:doc-built', { id, ok: true, data: await blob.arrayBuffer() });
    } catch (err) {
      api.send('ai:doc-built', { id, ok: false, error: err?.message || String(err) });
    }
  });

  return {
    renderRing,
    busy: () => attachments.some((a) => a.status === 'busy'),
    ready: () => attachments.filter((a) => a.status === 'ready').length > 0,
    // Takes what's ready for sending (and clears it from the tray).
    take() {
      const sending = attachments.filter((a) => a.status === 'ready');
      const items = sending.flatMap((a) => a.items);
      if (items.length > MAX_FILES) { notice(`That’s ${items.length} files (a scanned PDF counts each page). Attach up to ${MAX_FILES}.`); return null; }
      attachments = attachments.filter((a) => !sending.includes(a));
      sending.forEach((a) => a.preview && URL.revokeObjectURL(a.preview));
      renderTray();
      return items;
    },
  };
}

// Files the user attached, above their message.
export function filesEl(files = []) {
  const box = document.createElement('div');
  box.className = 'files';
  box.innerHTML = files.map((f) => (f.kind === 'image'
    ? `<div class="att pic" title="${esc(f.name)}">${f.thumb ? `<img src="${esc(f.thumb)}" alt="">` : ficon(f.name)}</div>`
    : `<div class="att" title="${esc(f.name)}">${ficon(f.name)}<span class="fname"><b>${esc(f.name)}</b><small>${f.pages ? `${f.pages} pages` : esc(fileLook(f.name)[0])}</small></span></div>`)).join('');
  return box;
}

// A picture or file Lumio made, with Open / Show in Finder.
export function madeEl(file, api) {
  const el = document.createElement('div');
  const finder = navigator.platform.startsWith('Mac') ? 'Show in Finder' : 'Show in folder';
  if (file.kind === 'image') {
    el.className = 'made-img';
    el.innerHTML = `<img src="${esc(file.url)}" alt="${esc(file.prompt || file.name)}"><div class="acts"><button type="button" data-act="open">Open</button><button type="button" data-act="show">${finder}</button></div>`;
  } else {
    el.className = 'doc-card';
    el.innerHTML = `${ficon(file.name)}<span class="dn"><b>${esc(file.name)}</b><small>${esc(file.label || 'File')} · Downloads</small></span><button type="button" class="doc-btn" data-act="open">Open</button><button type="button" class="doc-btn ghost" data-act="show" title="${finder}">${icons.folder || '…'}</button>`;
  }
  el.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'open') api.send('ai:open-file', file.path);
    if (act === 'show') api.send('ai:show-file', file.path);
  });
  return el;
}
