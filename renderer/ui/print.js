// Print preview (main/print.js): the page printed to PDF, shown with pdf.js,
// and the settings for it. Changing the layout, paper, margins, scale,
// headers or background prints the preview again; the pages to print,
// pages per sheet and color only change what's shown. Save as PDF asks
// where to save; a printer prints right away. Esc cancels.
const api = window.lumio;
const $ = (sel) => document.querySelector(sel);
const IS_MAC = /Mac/.test(navigator.platform);

// Paper sizes in inches (portrait), and how pages are arranged per sheet
// (2 and 6 turn the sheet sideways, like printers do).
const PAPER = { Letter: [8.5, 11], Legal: [8.5, 14], Tabloid: [11, 17], A3: [11.69, 16.54], A4: [8.27, 11.69], A5: [5.83, 8.27] };
const GRID = { 1: [1, 1], 2: [2, 1], 4: [2, 2], 6: [3, 2], 9: [3, 3], 16: [4, 4] };
const SHEET_WIDTH = 560; // the widest a sheet is drawn, in CSS pixels
const REPRINT = ['layout', 'paper', 'margins', 'scale', 'headers', 'background'];

const form = $('#form');
const s = {
  destination: 'pdf', pages: 'all', ranges: '', copies: 1, layout: 'portrait', color: 'color',
  paper: 'A4', perSheet: 1, margins: 'default', scaleMode: 'default', scale: 100, headers: false, background: false,
};
let doc = null; // pdf.js document of the whole printout
let total = 0; // its pages
let selected = []; // page numbers to print (1-based)
let generation = 0; // bumps when the preview is printed again or redrawn
let busy = false;

// ---------------------------------------------------------------- pdf.js
let pdfjs = null;
async function loadPdf() {
  if (!pdfjs) {
    pdfjs = await import('./web/vendor/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('web/vendor/pdf.worker.min.mjs', location.href).href;
  }
  return pdfjs;
}

// ---------------------------------------------------------------- pages to print
// "1-5, 8, 11-13" (also "-3" and "9-") as page numbers, or an error.
function parseRanges(text, count) {
  const pages = new Set();
  const parts = String(text).split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return { error: 'Use page numbers like 1-5, 8, 11-13.' };
  for (const part of parts) {
    const m = /^(\d*)\s*(?:-\s*(\d*))?$/.exec(part);
    if (!m || (!m[1] && !m[2])) return { error: 'Use page numbers like 1-5, 8, 11-13.' };
    const from = m[1] ? Number(m[1]) : 1;
    const to = m[2] !== undefined ? (m[2] ? Number(m[2]) : count) : from;
    if (from < 1 || to < from) return { error: 'Use page numbers like 1-5, 8, 11-13.' };
    if (from > count || to > count) return { error: count === 1 ? 'There’s only 1 page.' : `There are only ${count} pages.` };
    for (let p = from; p <= to; p++) pages.add(p);
  }
  return { pages: [...pages].sort((a, b) => a - b) };
}

// Page numbers as ranges: [1, 2, 3, 5] -> [[1, 3], [5, 5]].
function toRanges(pages) {
  const out = [];
  for (const p of pages) {
    const last = out[out.length - 1];
    if (last && p === last[1] + 1) last[1] = p; else out.push([p, p]);
  }
  return out;
}

function choosePages() {
  const all = Array.from({ length: total }, (_, i) => i + 1);
  $('#ranges').hidden = s.pages !== 'custom';
  let error = '';
  if (s.pages === 'odd') selected = all.filter((p) => p % 2 === 1);
  else if (s.pages === 'even') selected = all.filter((p) => p % 2 === 0);
  else if (s.pages === 'custom' && total) {
    const r = parseRanges(s.ranges, total);
    error = s.ranges.trim() ? r.error || '' : '';
    selected = r.pages || (s.ranges.trim() ? [] : all);
  } else selected = all;
  $('#ranges-err').textContent = error;
  $('#ranges').setAttribute('aria-invalid', String(!!error));
  // A Mac's print system honors only one range.
  $('#mac-range').hidden = !(IS_MAC && s.destination !== 'pdf' && toRanges(selected).length > 1);
  return !error && selected.length > 0;
}

// What main/print.js gets: the chosen pages as ranges (null: all of them).
function settings({ withPages = true } = {}) {
  const everything = selected.length === total;
  return {
    destination: s.destination,
    ranges: withPages && !everything ? toRanges(selected) : null,
    copies: s.copies,
    layout: s.layout,
    color: s.color,
    paper: s.paper,
    perSheet: s.destination === 'pdf' ? 1 : s.perSheet,
    margins: s.margins,
    scale: s.scaleMode === 'custom' ? s.scale : 100,
    headers: s.headers && s.margins !== 'none',
    background: s.background,
  };
}

// ---------------------------------------------------------------- drawing
function setStatus(text, { error = false, spinner = false } = {}) {
  const el = $('#status');
  el.classList.toggle('idle', !text);
  el.innerHTML = text ? `${spinner ? '<span class="spinner" aria-hidden="true"></span>' : ''}<span class="${error ? 'err' : ''}"></span>` : '';
  if (text) el.lastElementChild.textContent = text;
}

function renderCount() {
  const pdf = s.destination === 'pdf';
  const perSheet = pdf ? 1 : s.perSheet;
  const sheets = Math.ceil(selected.length / perSheet) * (pdf ? 1 : s.copies);
  $('#count').textContent = !total ? '' : pdf
    ? (selected.length === 1 ? '1 page' : `${selected.length} pages`)
    : (sheets === 1 ? '1 sheet of paper' : `${sheets} sheets of paper`);
}

// Sheets of paper with the chosen pages on them, drawn as they scroll into view.
let observer = null;
function layoutSheets() {
  const gen = ++generation;
  observer?.disconnect();
  const box = $('#sheets');
  box.innerHTML = '';
  renderCount();
  if (!doc || !selected.length) return;
  const perSheet = s.destination === 'pdf' ? 1 : s.perSheet;
  const [cols, rows] = GRID[perSheet];
  let [pw, ph] = PAPER[s.paper] || PAPER.A4;
  if (s.layout === 'landscape') [pw, ph] = [ph, pw];
  if (perSheet === 2 || perSheet === 6) [pw, ph] = [ph, pw]; // the sheet turns sideways
  const width = Math.min(SHEET_WIDTH, box.clientWidth - 56);
  const height = Math.round((width * ph) / pw);
  const bw = s.destination !== 'pdf' && s.color === 'bw';
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { observer.unobserve(e.target); drawSheet(e.target, gen); }
  }, { root: $('#preview'), rootMargin: '800px 0px' });
  for (let i = 0; i < selected.length; i += perSheet) {
    const pages = selected.slice(i, i + perSheet);
    const wrap = document.createElement('div');
    wrap.className = 'sheet-wrap';
    const sheet = document.createElement('div');
    sheet.className = 'sheet' + (bw ? ' bw' : '');
    sheet.style.cssText = `width:${width}px;height:${height}px;grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},1fr);${perSheet > 1 ? 'padding:4%;gap:3%;' : ''}`;
    sheet.dataset.pages = pages.join(',');
    sheet.setAttribute('role', 'img');
    sheet.setAttribute('aria-label', pages.length === 1 ? `Page ${pages[0]}` : `Pages ${pages.join(', ')}`);
    const label = document.createElement('div');
    label.className = 'sheet-label';
    label.textContent = perSheet === 1 ? `Page ${pages[0]}` : `Sheet ${i / perSheet + 1}`;
    wrap.append(sheet, label);
    box.append(wrap);
    observer.observe(wrap);
  }
}

async function drawSheet(wrap, gen) {
  const sheet = wrap.querySelector('.sheet');
  const pages = sheet.dataset.pages.split(',').map(Number);
  const perSheet = s.destination === 'pdf' ? 1 : s.perSheet;
  const [cols, rows] = GRID[perSheet];
  const cellW = (sheet.clientWidth * (perSheet > 1 ? 0.92 : 1)) / cols;
  const cellH = (sheet.clientHeight * (perSheet > 1 ? 0.92 : 1)) / rows;
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  for (const n of pages) {
    if (gen !== generation) return;
    const cell = document.createElement('div');
    cell.className = 'cell';
    sheet.append(cell);
    try {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const fit = Math.min(cellW / base.width, cellH / base.height);
      const viewport = page.getViewport({ scale: fit * ratio });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      canvas.style.width = `${Math.round(base.width * fit)}px`;
      canvas.style.height = `${Math.round(base.height * fit)}px`;
      cell.append(canvas);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    } catch { /* a page that won't draw stays blank */ }
  }
}

// Prints the page to PDF again with the current settings.
let previewTimer = null;
let previewSeq = 0;
function reprint(delay = 250) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const seq = ++previewSeq;
    $('#preview').setAttribute('aria-busy', 'true');
    if (!doc) setStatus('Loading preview…', { spinner: true });
    const res = await api.invoke('print:preview', settings({ withPages: false })).catch(() => null);
    if (seq !== previewSeq) return;
    if (!res?.ok) {
      doc = null;
      total = 0;
      $('#sheets').innerHTML = '';
      $('#preview').setAttribute('aria-busy', 'false');
      setStatus('Couldn’t make a preview of this page.', { error: true });
      renderCount();
      return;
    }
    try {
      const lib = await loadPdf();
      const next = await lib.getDocument({ data: res.pdf, isEvalSupported: false }).promise;
      if (seq !== previewSeq) { next.destroy(); return; }
      doc?.destroy();
      doc = next;
      total = doc.numPages;
      setStatus('');
    } catch {
      setStatus('Couldn’t make a preview of this page.', { error: true });
    }
    $('#preview').setAttribute('aria-busy', 'false');
    choosePages();
    layoutSheets();
    syncButtons();
    // Ready: Enter prints (unless you've moved on to a setting).
    if (document.activeElement === document.body && !$('#go').disabled) $('#go').focus();
  }, delay);
}

// ---------------------------------------------------------------- the form
function syncForm() {
  const pdf = s.destination === 'pdf';
  form.classList.toggle('pdf', pdf);
  $('#go').textContent = busy ? (pdf ? 'Saving…' : 'Printing…') : pdf ? 'Save' : 'Print';
  $('#scale-wrap').hidden = s.scaleMode !== 'custom';
  $('#headers').disabled = s.margins === 'none';
  $('#headers').checked = s.headers && s.margins !== 'none';
}

function syncButtons() {
  const scaleOk = s.scaleMode !== 'custom' || (s.scale >= 10 && s.scale <= 200);
  $('#go').disabled = busy || !doc || !selected.length || !!$('#ranges-err').textContent || !scaleOk;
  $('#cancel').disabled = busy;
}

function fill(values) {
  for (const [id, key] of [['layout', 'layout'], ['color', 'color'], ['paper', 'paper'], ['per-sheet', 'perSheet'], ['margins', 'margins']]) {
    if (values[key] == null) continue;
    const el = $('#' + id);
    if ([...el.options].some((o) => o.value === String(values[key]))) { el.value = String(values[key]); s[key] = key === 'perSheet' ? Number(el.value) : el.value; }
  }
  if (Number(values.scale) && Number(values.scale) !== 100) { s.scaleMode = 'custom'; s.scale = Number(values.scale); $('#scale-mode').value = 'custom'; $('#scale').value = String(s.scale); }
  s.headers = !!values.headers;
  s.background = !!values.background;
  $('#headers').checked = s.headers;
  $('#background').checked = s.background;
}

form.addEventListener('change', (e) => {
  const el = e.target;
  const key = { dest: 'destination', pages: 'pages', layout: 'layout', color: 'color', paper: 'paper', 'per-sheet': 'perSheet', margins: 'margins', 'scale-mode': 'scaleMode', headers: 'headers', background: 'background' }[el.id];
  if (!key) return;
  s[key] = el.type === 'checkbox' ? el.checked : key === 'perSheet' ? Number(el.value) : el.value;
  if (key === 'margins' && s.margins === 'none') s.headers = false;
  syncForm();
  if (key === 'pages') { choosePages(); layoutSheets(); if (s.pages === 'custom') $('#ranges').focus(); }
  else if (REPRINT.includes(key) || (key === 'scaleMode')) reprint();
  else { choosePages(); layoutSheets(); }
  syncButtons();
});
$('#ranges').addEventListener('input', (e) => { s.ranges = e.target.value; choosePages(); layoutSheets(); syncButtons(); });
$('#copies').addEventListener('input', (e) => { s.copies = Math.min(999, Math.max(1, Math.round(Number(e.target.value) || 1))); renderCount(); });
$('#scale').addEventListener('input', (e) => {
  s.scale = Math.round(Number(e.target.value) || 0);
  const ok = s.scale >= 10 && s.scale <= 200;
  $('#scale-err').textContent = ok ? '' : 'Choose a scale from 10% to 200%.';
  $('#scale').setAttribute('aria-invalid', String(!ok));
  if (ok) reprint(400);
  syncButtons();
});
$('#more').addEventListener('click', () => {
  const open = $('#more').getAttribute('aria-expanded') !== 'true';
  $('#more').setAttribute('aria-expanded', String(open));
  $('#more-settings').hidden = !open;
});

// ---------------------------------------------------------------- actions
const close = () => api.send('print:close');
$('#cancel').addEventListener('click', close);
$('#system').addEventListener('click', () => api.send('print:system'));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !busy) { e.preventDefault(); close(); }
});
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if ($('#go').disabled) return;
  busy = true;
  syncForm();
  syncButtons();
  const pdf = s.destination === 'pdf';
  const res = await api.invoke(pdf ? 'print:save-pdf' : 'print:print', settings()).catch((err) => ({ ok: false, error: err?.message }));
  // Done: the browser closes this panel. Canceled or failed: try again.
  busy = false;
  syncForm();
  syncButtons();
  if (!res?.ok && !res?.canceled) setStatus(pdf ? 'Couldn’t save the PDF. Try again.' : 'Couldn’t print. Check the printer and try again.', { error: true });
  $('#go').focus();
});

// ---------------------------------------------------------------- start
$('#system-keys').textContent = IS_MAC ? '(⌥⌘P)' : '(Ctrl+Shift+P)';
const init = await api.invoke('print:init');
document.title = init.title ? `Print: ${init.title}` : 'Print';
fill(init.settings || {});
syncForm();
reprint(0);

// Printers can take a moment to list; Save as PDF works meanwhile.
api.invoke('print:printers').then((printers) => {
  const dest = $('#dest');
  for (const p of printers || []) {
    const o = document.createElement('option');
    o.value = p.name;
    o.textContent = p.displayName;
    o.setAttribute('translate', 'no');
    dest.append(o);
  }
  const want = init.settings?.destination;
  if (want && want !== 'pdf' && (printers || []).some((p) => p.name === want)) {
    dest.value = want;
    s.destination = want;
    syncForm();
    choosePages();
    layoutSheets();
    syncButtons();
  }
}).catch(() => {});

let resizeTimer = null;
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (doc) layoutSheets(); }, 120); }).observe($('#preview'));
