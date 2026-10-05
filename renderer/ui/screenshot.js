// The screenshot view over the page (main/screenshot.js). First the page is
// frozen: drag over an area, or take the visible part or the whole page.
// Then a small editor marks it up (pen, highlighter, arrow, text) and copies,
// downloads or asks Lumio about it. The picture is copied as soon as it's taken.
const api = window.lumio;
const $ = (s) => document.querySelector(s);

// Markup colors are drawn into the picture, so they're the same in light and dark.
export const COLORS = [['Red', '#ff3b30'], ['Yellow', '#ffcc00'], ['Green', '#34c759'], ['Blue', '#0a84ff'], ['Black', '#111111'], ['White', '#ffffff']];
const svg = (d, size = 17) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  pen: svg('<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  marker: svg('<path d="M9 14.5l-3 3V20h2.5l3-3"/><path d="M9 14.5 16.5 7a2.1 2.1 0 0 1 3 3L12 17.5z"/><path d="M14 20h6"/>'),
  arrow: svg('<path d="M5 19 19 5M10 5h9v9"/>'),
  text: svg('<path d="M5 6V4.5h14V6M12 4.5v15M9 19.5h6"/>'),
  undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  close: svg('<path d="M7 7l10 10M17 7L7 17"/>', 15),
};

let shot = null; // { url (blob of the frozen page), width, height, title, host }
let pickStart = null;

// ---------------------------------------------------------------- choosing
const pick = $('#pick');
const frozen = $('#frozen');
const sel = $('#sel');
const hint = $('#hint');
pick.querySelector('[data-act="close"]').innerHTML = ICONS.close;

function rectOf(a, b) {
  const r = pick.getBoundingClientRect();
  const x1 = Math.max(0, Math.min(a.x, b.x)); const y1 = Math.max(0, Math.min(a.y, b.y));
  const x2 = Math.min(r.width, Math.max(a.x, b.x)); const y2 = Math.min(r.height, Math.max(a.y, b.y));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}
function showSel(r) {
  sel.hidden = false;
  Object.assign(sel.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
  pick.classList.add('selecting');
}
pick.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('.bar')) return;
  pickStart = { x: e.clientX, y: e.clientY };
  pick.setPointerCapture(e.pointerId);
  showSel(rectOf(pickStart, pickStart));
});
pick.addEventListener('pointermove', (e) => { if (pickStart) showSel(rectOf(pickStart, { x: e.clientX, y: e.clientY })); });
pick.addEventListener('pointerup', (e) => {
  if (!pickStart) return;
  const r = rectOf(pickStart, { x: e.clientX, y: e.clientY });
  pickStart = null;
  if (r.width < 8 || r.height < 8) { sel.hidden = true; pick.classList.remove('selecting'); return; } // a click, not a drag
  const k = frozen.naturalWidth / frozen.clientWidth;
  crop({ x: r.x * k, y: r.y * k, width: r.width * k, height: r.height * k });
});
pick.addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'visible') crop(null);
  else if (act === 'full') fullPage();
  else if (act === 'close') api.send('shot:close');
});

async function crop(r) {
  const img = await createImageBitmap(frozen);
  const box = r ? { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } : { x: 0, y: 0, width: img.width, height: img.height };
  const c = new OffscreenCanvas(Math.max(1, box.width), Math.max(1, box.height));
  c.getContext('2d').drawImage(img, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
  edit(c.transferToImageBitmap());
}

async function fullPage() {
  pick.classList.add('busy');
  hint.textContent = 'Capturing the whole page…';
  const res = await api.invoke('shot:full').catch(() => null);
  pick.classList.remove('busy');
  if (!res?.png) { hint.textContent = res?.error || 'Couldn’t capture the whole page.'; return; }
  const img = await createImageBitmap(new Blob([res.png], { type: 'image/png' }));
  edit(img, res.clipped ? 'This page is very long, so the picture stops partway down.' : '', { fit: false });
}

// ---------------------------------------------------------------- the editor
const editEl = $('#edit');
const canvas = $('#canvas');
const ctx = canvas.getContext('2d');
const statusEl = $('#status');
const undoBtn = editEl.querySelector('[data-act="undo"]');
let base = null;
let ops = [];
let current = null;
let tool = 'pen';
let color = COLORS[0][1];
let textBox = null;

editEl.querySelectorAll('[data-tool]').forEach((b) => { b.innerHTML = ICONS[b.dataset.tool]; });
undoBtn.innerHTML = ICONS.undo;
editEl.querySelector('[data-act="close"]').innerHTML = ICONS.close;
editEl.querySelector('.colors').innerHTML = COLORS.map(([name, c]) => `<button type="button" class="swatch" role="radio" data-color="${c}" style="--sw:${c}" title="${name}" aria-label="${name}"></button>`).join('');

function setTool(t) {
  commitText();
  tool = t;
  editEl.querySelectorAll('[data-tool]').forEach((b) => { const on = b.dataset.tool === t; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
  canvas.dataset.tool = t;
}
function setColor(c) {
  color = c;
  editEl.querySelectorAll('[data-color]').forEach((b) => { const on = b.dataset.color === c; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
}

// Sizes follow the picture, so markup looks the same on a small crop and a whole page.
const unit = () => Math.max(2, Math.round(Math.min(canvas.width, 2400) / 320));

function drawOp(o) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = o.color;
  ctx.fillStyle = o.color;
  if (o.tool === 'pen' || o.tool === 'marker') {
    if (o.tool === 'marker') { ctx.globalAlpha = 0.38; ctx.globalCompositeOperation = 'multiply'; }
    ctx.lineWidth = o.tool === 'marker' ? o.size * 5 : o.size;
    ctx.beginPath();
    o.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (o.points.length === 1) ctx.lineTo(o.points[0].x + 0.1, o.points[0].y);
    ctx.stroke();
  } else if (o.tool === 'arrow') {
    const [a, b] = [o.points[0], o.points[o.points.length - 1]];
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const head = o.size * 5;
    ctx.lineWidth = o.size * 1.3;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x - Math.cos(angle) * head * 0.6, b.y - Math.sin(angle) * head * 0.6);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - head * Math.cos(angle - 0.45), b.y - head * Math.sin(angle - 0.45));
    ctx.lineTo(b.x - head * Math.cos(angle + 0.45), b.y - head * Math.sin(angle + 0.45));
    ctx.closePath();
    ctx.fill();
  } else if (o.tool === 'text') {
    ctx.font = `600 ${o.size * 9}px Geist, -apple-system, 'Segoe UI', sans-serif`;
    ctx.textBaseline = 'top';
    // A thin outline keeps words readable on any background.
    ctx.lineWidth = Math.max(2, o.size * 0.9);
    ctx.strokeStyle = o.color === '#111111' ? '#ffffff' : '#111111';
    ctx.globalAlpha = 0.85;
    o.text.split('\n').forEach((line, i) => ctx.strokeText(line, o.x, o.y + i * o.size * 11));
    ctx.globalAlpha = 1;
    o.text.split('\n').forEach((line, i) => ctx.fillText(line, o.x, o.y + i * o.size * 11));
  }
  ctx.restore();
}
function redraw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(base, 0, 0);
  ops.forEach(drawOp);
  if (current) drawOp(current);
  undoBtn.disabled = !ops.length;
}

function edit(img, note = '', { fit = true } = {}) {
  base = img;
  canvas.width = img.width;
  canvas.height = img.height;
  ops = [];
  pick.hidden = true;
  editEl.hidden = false;
  // Shown at its real size on this screen, or smaller to fit: an area or the
  // visible part fits the window's height too; a whole page scrolls.
  let width = img.width / devicePixelRatio;
  if (fit) width = Math.min(width, Math.max(80, $('#stage').clientHeight - 24) * (img.width / img.height));
  canvas.style.width = `${Math.max(1, Math.round(width))}px`;
  setTool('pen');
  setColor(COLORS[0][1]);
  redraw();
  copy(note ? `Copied to the clipboard. ${note}` : 'Copied to the clipboard');
  editEl.querySelector('[data-act="copy"]').focus();
}

const at = (e) => {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * canvas.width, y: ((e.clientY - r.top) / r.height) * canvas.height };
};
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  if (tool === 'text') { placeText(e); return; }
  commitText();
  canvas.setPointerCapture(e.pointerId);
  current = { tool, color, size: unit(), points: [at(e)] };
  redraw();
});
canvas.addEventListener('pointermove', (e) => {
  if (!current) return;
  if (current.tool === 'arrow') current.points = [current.points[0], at(e)];
  else current.points.push(at(e));
  redraw();
});
canvas.addEventListener('pointerup', () => {
  if (!current) return;
  const done = current;
  current = null;
  const [a, b] = [done.points[0], done.points[done.points.length - 1]];
  if (done.tool !== 'arrow' || Math.hypot(b.x - a.x, b.y - a.y) > unit() * 3) ops.push(done);
  redraw();
});

// Text: a box where you clicked; Enter puts it in the picture, Esc drops it.
function placeText(e) {
  commitText();
  const p = at(e);
  const r = canvas.getBoundingClientRect();
  const k = r.width / canvas.width;
  textBox = document.createElement('textarea');
  textBox.className = 'text-box';
  textBox.rows = 1;
  textBox.setAttribute('aria-label', 'Text to add');
  textBox.spellcheck = false;
  textBox.dataset.x = p.x;
  textBox.dataset.y = p.y;
  textBox.dataset.ink = color;
  Object.assign(textBox.style, { left: `${e.clientX - $('#stage').getBoundingClientRect().left + $('#stage').scrollLeft}px`, top: `${e.clientY - $('#stage').getBoundingClientRect().top + $('#stage').scrollTop}px`, font: `600 ${unit() * 9 * k}px Geist, -apple-system, sans-serif`, color });
  $('#stage').append(textBox);
  textBox.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); commitText(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); textBox.remove(); textBox = null; }
  });
  // Focused at once so quick typing isn't lost; a blur that the click itself
  // caused is undone, and only a real one puts the text in.
  const box = textBox;
  box.addEventListener('blur', () => setTimeout(() => { if (textBox === box && document.activeElement !== box) commitText(); }, 0));
  box.focus();
  setTimeout(() => { if (textBox === box) box.focus(); }, 0);
}
function commitText() {
  const box = textBox;
  if (!box) return;
  textBox = null;
  const text = box.value.trim();
  box.remove();
  if (text) { ops.push({ tool: 'text', color: box.dataset.ink, size: unit(), text, x: Number(box.dataset.x), y: Number(box.dataset.y) }); redraw(); }
}

async function png() {
  commitText();
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}
function status(text) { statusEl.textContent = text; }
async function copy(text = 'Copied') {
  const ok = await api.invoke('shot:copy', await png()).catch(() => false);
  status(ok ? text : 'Couldn’t copy the picture');
}

editEl.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-tool]')?.dataset.tool;
  if (t) { setTool(t); return; }
  const c = e.target.closest('[data-color]')?.dataset.color;
  if (c) { setColor(c); return; }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'undo') { ops.pop(); redraw(); }
  else if (act === 'copy') copy();
  else if (act === 'save') { const res = await api.invoke('shot:save', await png()).catch(() => null); if (res?.ok) status('Saved'); else if (res?.error) status(res.error); }
  else if (act === 'ask') api.send('shot:ask', await png());
  else if (act === 'close') api.send('shot:close');
});
// Arrows move between the choices in a group (tools, colors).
editEl.addEventListener('keydown', (e) => {
  const group = e.target.closest('[role="radiogroup"]');
  if (!group || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  const items = [...group.querySelectorAll('[role="radio"]')];
  const next = items[(items.indexOf(e.target) + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
  e.preventDefault();
  next.focus();
  next.click();
});

document.addEventListener('keydown', (e) => {
  if (e.target === textBox) return;
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === 'Escape') { e.preventDefault(); api.send('shot:close'); return; }
  if (!pick.hidden) {
    if (e.key === 'Enter' && !e.target.closest('button')) { e.preventDefault(); crop(null); }
    return;
  }
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); ops.pop(); redraw(); }
  else if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); copy(); }
  else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); editEl.querySelector('[data-act="save"]').click(); }
  else if (!mod && !e.altKey && { p: 'pen', h: 'marker', a: 'arrow', t: 'text' }[e.key.toLowerCase()]) setTool({ p: 'pen', h: 'marker', a: 'arrow', t: 'text' }[e.key.toLowerCase()]);
});

// ---------------------------------------------------------------- from main
api.on('shot-data', (d) => {
  if (shot?.url) URL.revokeObjectURL(shot.url);
  shot = { ...d, url: URL.createObjectURL(new Blob([d.png], { type: 'image/png' })) };
  frozen.src = shot.url;
  document.title = d.host ? `Screenshot of ${d.host}` : 'Screenshot';
  editEl.hidden = true;
  pick.hidden = false;
  sel.hidden = true;
  pick.classList.remove('selecting');
  hint.textContent = 'Drag to select an area';
  pick.querySelector('[data-act="visible"]').focus();
});
