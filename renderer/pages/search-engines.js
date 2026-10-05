// Settings › Search engine: the default engine, "Manage search engines and
// site search" (add, edit, delete, make default; turn on engines found on
// websites) and Settings › Privacy's "Autocomplete searches and URLs".
// Saved by main/omnibox-service.js (page:search-…).
const page = window.lumioPage;
const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PENCIL = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
const TRASH = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';

let state = await page.invoke('page:search-engines').catch(() => null);
const select = $('#engine');
const panel = $('#se-panel');
const manage = $('#se-manage');
const suggestToggle = $('#search-suggest');

const shortUrl = (u) => String(u).replace(/^https?:\/\/(www\.)?/, '');

function renderSelect() {
  if (!state || !select) return;
  const all = [...state.engines, ...state.custom];
  select.innerHTML = all.map((e) => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('');
  select.value = state.default;
}

function row(e, kind) {
  const isDefault = e.id === state.default;
  const acts = [];
  if (kind === 'found') acts.push('<button class="btn" data-act="activate">Turn on</button>');
  else if (isDefault) acts.push('<span class="pill">Default</span>');
  else acts.push('<button class="btn ghost" data-act="default">Make default</button>');
  if (kind === 'custom') acts.push(`<button class="btn ghost icon-btn" data-act="edit" title="Edit" aria-label="Edit ${esc(e.name)}">${PENCIL}</button>`);
  if (kind !== 'builtin') acts.push(`<button class="btn ghost icon-btn" data-act="delete" title="Delete" aria-label="Delete ${esc(e.name)}" ${isDefault ? 'disabled' : ''}>${TRASH}</button>`);
  return `<div class="row se-row" data-id="${esc(e.id)}" data-kind="${kind}">
    <div class="grow"><div class="title">${esc(e.name)}</div><div class="desc"><span class="se-key">${esc(e.keyword)}</span> · ${esc(shortUrl(e.url))}</div></div>
    <div class="acts">${acts.join('')}</div>
  </div>`;
}

function renderPanel() {
  if (!state || !panel) return;
  panel.innerHTML = `
    <h3>Search engines</h3>
    <div class="card">${state.engines.map((e) => row(e, 'builtin')).join('')}</div>
    <h3 class="se-head"><span>Site search</span><button class="btn" id="se-add">Add</button></h3>
    <div class="card" id="se-custom">${state.custom.map((e) => row(e, 'custom')).join('')
      || '<div class="row"><div class="desc">Add a site to search it from the address bar: type its shortcut and a space, or press Tab after it.</div></div>'}</div>
    <p class="note">Type a shortcut and a space in the address bar to search there, like “yt cats”. Type @tabs, @bookmarks, @history or @lumio to search those.</p>
    ${state.found.length ? `<h3>Inactive shortcuts</h3>
    <div class="card">${state.found.map((e) => row(e, 'found')).join('')}</div>
    <p class="note">Sites you visited that offer their own search. Turn one on to use its shortcut.</p>` : ''}`;
}

function render() {
  renderSelect();
  renderPanel();
  if (suggestToggle && state) suggestToggle.checked = state.suggest;
}

// The add / edit form, under its row (or at the top of Site search).
function openForm(e = null, after = null) {
  panel.querySelector('.se-form')?.remove();
  const form = document.createElement('form');
  form.className = 'sched-form se-form';
  form.setAttribute('aria-label', e ? `Edit ${e.name}` : 'Add a site search');
  form.innerHTML = `
    <div class="se-fields">
      <label><span>Name</span><input class="field" name="name" maxlength="60" value="${esc(e?.name || '')}" placeholder="MDN Web Docs" autocomplete="off"></label>
      <label><span>Shortcut</span><input class="field" name="keyword" maxlength="40" value="${esc(e?.keyword || '')}" placeholder="mdn" autocomplete="off" spellcheck="false"></label>
    </div>
    <label><span>URL with %s in place of the search</span><input class="field" name="url" maxlength="2048" value="${esc(e?.url || '')}" placeholder="https://developer.mozilla.org/search?q=%s" autocomplete="off" spellcheck="false"></label>
    <div class="sched-actions"><span class="desc err" role="alert"></span><button type="button" class="btn ghost" data-cancel>Cancel</button><button type="submit" class="btn primary">${e ? 'Save' : 'Add'}</button></div>`;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = new FormData(form);
    const res = await page.invoke('page:search-engine-save', { id: e?.id, name: f.get('name'), keyword: f.get('keyword'), url: f.get('url') });
    if (!res?.ok) { form.querySelector('.err').textContent = res?.error || 'Couldn’t save it.'; return; }
    state = res.state;
    render();
    panel.querySelector(`.se-row[data-id="${CSS.escape(res.state.custom.find((x) => x.keyword === f.get('keyword').trim())?.id || '')}"] .btn`)?.focus();
  });
  const cancel = () => { form.remove(); (after?.querySelector('[data-act=edit]') || $('#se-add'))?.focus(); };
  form.querySelector('[data-cancel]').addEventListener('click', cancel);
  form.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); cancel(); } });
  if (after) after.after(form); else $('#se-custom').prepend(form);
  form.querySelector('input').focus();
}

manage?.addEventListener('click', () => {
  panel.hidden = !panel.hidden;
  manage.setAttribute('aria-expanded', String(!panel.hidden));
  manage.textContent = panel.hidden ? 'Manage' : 'Done';
});

panel?.addEventListener('click', async (ev) => {
  if (ev.target.closest('#se-add')) { openForm(); return; }
  const b = ev.target.closest('button[data-act]');
  const r = ev.target.closest('.se-row');
  if (!b || !r) return;
  const id = r.dataset.id;
  const act = b.dataset.act;
  if (act === 'edit') { openForm(state.custom.find((x) => x.id === id), r); return; }
  if (act === 'delete') {
    const e = [...state.custom, ...state.found].find((x) => x.id === id);
    if (!e || !confirm(`Delete “${e.name}”?`)) return;
    state = await page.invoke('page:search-engine-delete', id);
  } else if (act === 'default') state = await page.invoke('page:search-engine-default', id);
  else if (act === 'activate') state = await page.invoke('page:search-engine-activate', id);
  render();
});

select?.addEventListener('change', async () => {
  state = await page.invoke('page:search-engine-default', select.value);
  render();
});

suggestToggle?.addEventListener('change', async () => {
  state = await page.invoke('page:search-suggest', suggestToggle.checked);
  render();
});

render();
