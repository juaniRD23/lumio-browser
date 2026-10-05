import './keys.js';
const page = window.lumioPage;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const size = (n) => (!n ? '' : n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' B');

let items = [];

function dayLabel(t) {
  const d = new Date(t);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

function row(d) {
  const ext = d.danger ? '!' : (d.name.split('.').pop() || '').slice(0, 4);
  let sub;
  let acts = '';
  let cls = '';
  let bar = '';
  let why = '';
  if (d.danger) {
    // A risky file waits for Keep or Discard (main/security.js says why).
    cls = 'danger';
    sub = `${d.danger.title} · ${host(d.url)}`;
    why = `<div class="why">${esc(d.danger.detail)}</div>`;
    acts = '<button class="btn small danger-fill" data-act="discard">Discard</button><button class="btn small" data-act="keep">Keep</button>';
  } else if (d.state === 'progressing') {
    const pct = d.total ? Math.round((d.received / d.total) * 100) : 0;
    sub = `${d.paused ? 'Paused · ' : ''}${size(d.received)}${d.total ? ` of ${size(d.total)}` : ''} · ${host(d.url)}`;
    acts = `${d.paused ? '<button class="btn small" data-act="resume">Resume</button>' : '<button class="btn small" data-act="pause">Pause</button>'}<button class="btn small" data-act="cancel">Cancel</button>`;
    bar = `<div class="bar"><i style="width:${pct}%"></i></div>`;
  } else if (d.state === 'completed' && d.exists === false) {
    cls = 'gone';
    sub = `Deleted · ${host(d.url)}`;
    acts = '<button class="btn small" data-act="retry">Download again</button>';
  } else if (d.state === 'completed') {
    sub = `${size(d.total || d.received)} · ${host(d.url)}`;
    acts = `<button class="btn small" data-act="show">${/Mac/.test(navigator.platform) ? 'Show in Finder' : 'Show in folder'}</button>`;
  } else {
    cls = 'failed';
    sub = `${d.state === 'cancelled' ? 'Cancelled' : 'Failed'} · ${host(d.url)}`;
    acts = '<button class="btn small" data-act="retry">Retry</button>';
  }
  const name = d.state === 'completed' && d.exists !== false ? `<a href="#" data-act="open">${esc(d.name)}</a>` : esc(d.name);
  return `<div class="dl ${cls}" data-id="${esc(d.id)}"><span class="file">${esc(ext)}</span><div class="meta"><div class="name">${name}</div><div class="sub">${esc(sub)}</div>${why}${bar}</div><div class="acts">${acts}<button class="iconbtn" data-act="remove" title="Remove from list">✕</button></div></div>`;
}

function render() {
  const q = $('#search').value.trim().toLowerCase();
  const list = q ? items.filter((d) => d.name.toLowerCase().includes(q) || (d.url || '').toLowerCase().includes(q)) : items;
  if (!list.length) { $('#list').innerHTML = `<div class="empty">${q ? 'No downloads match' : 'Files you download show up here.'}</div>`; return; }
  let html = '';
  let last = '';
  for (const d of list) {
    const label = dayLabel(d.time);
    if (label !== last) { html += `<div class="day">${esc(label)}</div>`; last = label; }
    html += row(d);
  }
  $('#list').innerHTML = html;
}

async function load() {
  items = await page.invoke('page:downloads');
  render();
}

$('#list').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const id = e.target.closest('.dl')?.dataset.id;
  if (!act || !id) return;
  e.preventDefault();
  await page.invoke('page:download-action', id, act);
  setTimeout(load, act === 'retry' ? 400 : 60);
});
$('#search').addEventListener('input', render);
$('#clear').addEventListener('click', async () => { await page.invoke('page:downloads-clear'); load(); });

await load();
// Keep progress fresh while something is downloading.
setInterval(() => { if (items.some((d) => d.state === 'progressing') || document.hasFocus()) load(); }, 1000);
