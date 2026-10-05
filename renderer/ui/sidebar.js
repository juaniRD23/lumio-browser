// The sidebar on the left: New task, Workflows, Templates, Scheduled,
// Customize, your projects and recent Lumio chats, search, and a Get started
// checklist. It works through the AI panel (ai-panel.js) for chats and
// through main for projects (main/projects.js) and chats (main/ai/chats.js).
import { icons } from './icons.js';

const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const svg = (d, size = 16) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const IC = {
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>'),
  side: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/>'),
  compose: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  workflow: svg('<path d="M4 6.5h9M4 12h6M4 17.5h9"/><path d="M15.5 9.5 21 13l-5.5 3.5z"/>'),
  templates: svg('<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  customize: svg('<path d="M12 3 4 7.5v9L12 21l8-4.5v-9z"/><path d="M12 12 4 7.5M12 12l8-4.5M12 12v9"/>'),
  folder: svg('<path d="M3.5 6.5a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z"/>', 15),
  plus: svg('<path d="M12 5v14M5 12h14"/>', 15),
  dots: svg('<circle cx="6" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="18" cy="12" r="1.2" fill="currentColor"/>', 16),
  back: svg('<path d="M15 18l-6-6 6-6"/>', 15),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 13),
  chev: svg('<path d="M6 9l6 6 6-6"/>', 13),
};

// Ready-made tasks: [the part in brackets] is selected to type over.
const TEMPLATES = [
  { title: 'Compare prices', text: 'Compare prices for [product] at Amazon, Best Buy and Walmart, and tell me where it’s cheapest.' },
  { title: 'Plan a trip', text: 'Plan a 3-day trip to [city]: where to stay, what to do each day, and a rough budget.' },
  { title: 'Find a restaurant', text: 'Find a restaurant in [area] for [number] people this weekend, and check if they take reservations.' },
  { title: 'Research a topic', text: 'Research [topic]: read 3 good sources and give me a short summary with links.' },
  { title: 'Track a price', text: 'Every morning at 9, check the price of [product] at [store] and tell me if it drops.' },
  { title: 'Fill in a form', text: 'Fill in the form on this page with my details, and stop before submitting so I can check it.' },
  { title: 'Write an email', text: 'Write a friendly email to [person] about [topic].' },
  { title: 'Summarize my inbox', text: 'Summarize the important emails in my Gmail from today.' },
];

const ago = (t) => {
  const s = (Date.now() - t) / 1000;
  if (s < 3600) return s < 90 ? 'now' : `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

export function initSidebar({ api, panel, isNewTab, onLayout, getAi }) {
  const body = document.body;
  const side = $('#sidebar');
  let open = true;
  let projects = [];
  let chats = [];
  let workflows = [];
  let schedules = [];
  let section = null; // 'workflows' | 'templates' | 'scheduled' (expanded)
  let projectView = null; // the project whose chats are listed
  let current = { chatId: null, projectId: null };
  let syncState = null;
  let getStarted = true;

  side.innerHTML = `
    <div class="sb-head">
      <span class="sb-traffic"></span>
      <button class="icon-btn small" id="sb-search-btn" title="Search chats" aria-label="Search chats">${IC.search}</button>
      <button class="icon-btn small" id="sb-close" title="Hide sidebar (⌘⇧S)" aria-label="Hide sidebar">${IC.side}</button>
    </div>
    <div id="sb-search" class="sb-search" hidden>
      <input id="sb-q" type="search" placeholder="Search chats" spellcheck="false" aria-label="Search chats">
      <div id="sb-results" class="sb-results"></div>
    </div>
    <div class="sb-scroll" id="sb-scroll">
      <nav class="sb-nav">
        <button class="sb-item" id="sb-new">${IC.compose}<span>New task</span></button>
        <button class="sb-item" data-sec="workflows" aria-expanded="false">${IC.workflow}<span>Workflows</span><i class="sb-chev">${IC.chev}</i></button>
        <div class="sb-sub" id="sb-sub-workflows" hidden></div>
        <button class="sb-item" data-sec="templates" aria-expanded="false">${IC.templates}<span>Templates</span><i class="sb-chev">${IC.chev}</i></button>
        <div class="sb-sub" id="sb-sub-templates" hidden></div>
        <button class="sb-item" data-sec="scheduled" aria-expanded="false">${IC.clock}<span>Scheduled</span><i class="sb-chev">${IC.chev}</i></button>
        <div class="sb-sub" id="sb-sub-scheduled" hidden></div>
        <button class="sb-item" id="sb-customize">${IC.customize}<span>Customize</span></button>
      </nav>
      <div class="sb-label"><span>Projects</span><button class="sb-mini" id="sb-new-project" title="New project" aria-label="New project">${IC.plus}</button></div>
      <form id="sb-project-form" class="sb-project-form" hidden>
        <input name="name" placeholder="Project name" maxlength="60" aria-label="Project name" required>
        <textarea name="instructions" rows="3" maxlength="4000" placeholder="Instructions Lumio follows in this project (optional)" aria-label="Instructions"></textarea>
        <div class="sb-form-row"><button type="button" class="btn ghost" data-cancel>Cancel</button><button type="submit" class="btn primary">Save</button></div>
      </form>
      <div id="sb-projects"></div>
      <div class="sb-label" id="sb-recents-label"><span>Recents</span></div>
      <div id="sb-recents"></div>
    </div>
    <div class="sb-start" id="sb-start" hidden></div>
    <div id="sb-menu" class="sb-menu" hidden></div>`;
  $('#sb-open').innerHTML = IC.side;

  // ---------------------------------------------------------------- open / closed
  function setOpen(on, save = true) {
    open = on;
    body.classList.toggle('sidebar-closed', !on);
    side.inert = !on;
    if (save) api.send('sidebar:set', { open: on });
    onLayout();
  }
  $('#sb-close').addEventListener('click', () => setOpen(false));
  $('#sb-open').addEventListener('click', () => setOpen(true));
  api.on('sidebar-toggle', () => setOpen(!open));

  // ---------------------------------------------------------------- data
  async function load() {
    const ai = getAi();
    const signedIn = !!ai.lumio?.signedIn;
    [projects, chats, workflows, schedules] = await Promise.all([
      api.invoke('ai:projects').catch(() => []),
      api.invoke('ai:chats').catch(() => []),
      ai.workflows ? api.invoke('ai:workflows').catch(() => []) : [],
      ai.workflows ? api.invoke('ai:schedules').catch(() => []) : [],
    ]).then((r) => r.map((x) => x || []));
    if (projectView && !projects.some((p) => p.id === projectView)) projectView = null;
    render();
    renderStart(signedIn);
  }
  api.on('sidebar-changed', load);
  api.on('workflows-changed', load);
  api.on('sync-state', (s) => { syncState = s; renderStart(!!getAi().lumio?.signedIn); });
  panel.onChatChange((c) => { current = c; renderChats(); });

  // ---------------------------------------------------------------- nav
  $('#sb-new').addEventListener('click', () => {
    panel.newTask({ projectId: projectView, full: isNewTab() });
  });
  $('#sb-customize').addEventListener('click', () => api.send('tab:new', 'lumio://settings/#profile'));
  side.querySelectorAll('[data-sec]').forEach((b) => b.addEventListener('click', () => {
    section = section === b.dataset.sec ? null : b.dataset.sec;
    renderSections();
  }));

  function renderSections() {
    for (const s of ['workflows', 'templates', 'scheduled']) {
      side.querySelector(`[data-sec="${s}"]`).setAttribute('aria-expanded', String(section === s));
      $(`#sb-sub-${s}`).hidden = section !== s;
    }
    if (section === 'workflows') {
      $('#sb-sub-workflows').innerHTML = (workflows.length
        ? workflows.slice(0, 12).map((w) => `<button class="sb-row" data-wf="${esc(w.id)}" title="${esc(w.description || w.instructions.slice(0, 120))}"><span class="sb-t">${esc(w.title)}</span></button>`).join('')
        : '<div class="sb-empty">After Lumio finishes a task, click “Save as workflow” to keep it here.</div>')
        + '<button class="sb-row sb-more" data-open="lumio://settings/#workflows"><span class="sb-t">Manage workflows</span></button>';
    }
    if (section === 'templates') {
      $('#sb-sub-templates').innerHTML = TEMPLATES.map((t, i) => `<button class="sb-row" data-tpl="${i}" title="${esc(t.text)}"><span class="sb-t">${esc(t.title)}</span></button>`).join('');
    }
    if (section === 'scheduled') {
      const next = (t) => (t.paused ? 'Paused' : t.done || !t.nextRun ? 'Done' : new Date(t.nextRun).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }));
      $('#sb-sub-scheduled').innerHTML = (schedules.length
        ? schedules.slice(0, 10).map((t) => `<button class="sb-row" data-open="lumio://settings/#scheduled" title="${esc(t.when)}"><span class="sb-t">${esc(t.title)}</span><small>${esc(next(t))}</small></button>`).join('')
        : '<div class="sb-empty">Tell Lumio “every morning at 8, …” and it shows up here.</div>')
        + '<button class="sb-row sb-more" data-open="lumio://settings/#scheduled"><span class="sb-t">Manage scheduled tasks</span></button>';
    }
  }
  side.querySelector('.sb-nav').addEventListener('click', (e) => {
    const wf = e.target.closest('[data-wf]');
    if (wf) { panel.runWorkflow(wf.dataset.wf); return; }
    const tpl = e.target.closest('[data-tpl]');
    if (tpl) {
      const text = window.lumioI18n?.t(TEMPLATES[Number(tpl.dataset.tpl)].text) ?? TEMPLATES[Number(tpl.dataset.tpl)].text; // in Lumio's language
      panel.newTask({ projectId: projectView, full: isNewTab() });
      panel.prefill(text);
      // Select the first [blank] to type over.
      const p = $('#prompt');
      const a = text.indexOf('[');
      if (a >= 0) p.setSelectionRange(a, text.indexOf(']', a) + 1);
      return;
    }
    const link = e.target.closest('[data-open]');
    if (link) api.send('tab:new', link.dataset.open);
  });

  // ---------------------------------------------------------------- projects and recents
  function render() {
    renderSections();
    $('#sb-projects').innerHTML = projectView ? '' : (projects.length
      ? projects.map((p) => `<div class="sb-row sb-project" data-project="${esc(p.id)}" role="button" tabindex="0">${IC.folder}<span class="sb-t">${esc(p.name)}</span><button class="sb-mini sb-dots" data-pmenu="${esc(p.id)}" aria-label="Project options">${IC.dots}</button></div>`).join('')
      : '<div class="sb-empty">No projects</div>');
    renderChats();
  }

  function renderChats() {
    const label = $('#sb-recents-label');
    let list = chats;
    if (projectView) {
      const p = projects.find((x) => x.id === projectView);
      label.innerHTML = `<button class="sb-back" id="sb-back">${IC.back}<span>${esc(p?.name || 'Project')}</span></button><button class="sb-mini sb-dots" data-pmenu="${esc(projectView)}" aria-label="Project options">${IC.dots}</button>`;
      list = chats.filter((c) => c.projectId === projectView);
    } else {
      label.innerHTML = '<span>Recents</span>';
      list = chats.slice(0, 40);
    }
    $('#sb-recents').innerHTML = list.length
      ? list.map((c) => `<div class="sb-row sb-chat${c.id === current.chatId ? ' on' : ''}" data-chat="${esc(c.id)}" role="button" tabindex="0" title="${esc(c.title)}"><span class="sb-t">${esc(c.title || 'Chat')}</span><small>${esc(ago(c.updatedAt))}</small><button class="sb-mini sb-dots" data-cmenu="${esc(c.id)}" aria-label="Chat options">${IC.dots}</button></div>`).join('')
      : `<div class="sb-empty">${projectView ? 'No chats in this project yet. New task starts one here.' : 'Your Lumio chats show up here.'}</div>`;
    $('#sb-back')?.addEventListener('click', () => { projectView = null; render(); });
  }

  side.querySelector('#sb-scroll').addEventListener('click', (e) => {
    if (e.target.closest('.sb-nav')) return;
    const cm = e.target.closest('[data-cmenu]');
    if (cm) { e.stopPropagation(); chatMenu(cm, cm.dataset.cmenu); return; }
    const pm = e.target.closest('[data-pmenu]');
    if (pm) { e.stopPropagation(); projectMenu(pm, pm.dataset.pmenu); return; }
    const chat = e.target.closest('[data-chat]');
    if (chat) { panel.openChat(chat.dataset.chat, { full: isNewTab() }); return; }
    const proj = e.target.closest('[data-project]');
    if (proj) { projectView = proj.dataset.project; render(); }
  });
  side.querySelector('#sb-scroll').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('[data-chat], [data-project]')) e.target.click();
  });

  // New project (or editing one).
  let editing = null;
  const form = $('#sb-project-form');
  function showForm(p = null) {
    editing = p?.id || null;
    form.hidden = false;
    form.name.value = p?.name || '';
    form.instructions.value = p?.instructions || '';
    form.querySelector('[type=submit]').textContent = p ? 'Save' : 'Create';
    form.name.focus();
  }
  $('#sb-new-project').addEventListener('click', () => (form.hidden ? showForm() : (form.hidden = true)));
  form.querySelector('[data-cancel]').addEventListener('click', () => { form.hidden = true; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const spec = { name: form.name.value, instructions: form.instructions.value };
    const r = editing ? await api.invoke('ai:project-update', editing, spec) : await api.invoke('ai:project-add', spec);
    if (!r.ok) { alert(r.error); return; }
    form.hidden = true;
    if (!editing) projectView = r.project.id;
    await load();
  });

  // ---------------------------------------------------------------- "…" menus
  const menu = $('#sb-menu');
  function showMenu(anchor, html, onPick) {
    menu.innerHTML = html;
    menu.hidden = false;
    const r = anchor.getBoundingClientRect();
    const s = side.getBoundingClientRect();
    menu.style.top = `${Math.min(r.bottom - s.top + 4, s.height - menu.offsetHeight - 8)}px`;
    menu.style.left = `${Math.max(8, Math.min(r.left - s.left - 140, s.width - menu.offsetWidth - 8))}px`;
    menu.onclick = (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      menu.hidden = true;
      onPick(b.dataset.act, b.dataset.arg);
    };
  }
  document.addEventListener('mousedown', (e) => { if (!menu.hidden && !e.target.closest('#sb-menu, [data-cmenu], [data-pmenu]')) menu.hidden = true; });

  function chatMenu(anchor, id) {
    const c = chats.find((x) => x.id === id);
    if (!c) return;
    showMenu(anchor, `
      <button data-act="rename">Rename</button>
      <div class="sb-menu-label">Move to project</div>
      ${projects.map((p) => `<button data-act="move" data-arg="${esc(p.id)}">${IC.folder}<span>${esc(p.name)}</span>${c.projectId === p.id ? IC.check : ''}</button>`).join('')}
      ${c.projectId ? '<button data-act="move" data-arg="">No project</button>' : ''}
      ${projects.length ? '' : '<div class="sb-menu-note">Make a project with + next to Projects.</div>'}
      <button data-act="delete" class="danger">Delete</button>`, async (act, arg) => {
      if (act === 'rename') {
        const row = side.querySelector(`[data-chat="${CSS.escape(id)}"] .sb-t`);
        if (!row) return;
        row.contentEditable = 'plaintext-only';
        row.focus();
        document.getSelection().selectAllChildren(row);
        const done = async (save) => {
          row.contentEditable = 'false';
          if (save && row.textContent.trim() && row.textContent.trim() !== c.title) await api.invoke('ai:chat-rename', id, row.textContent.trim());
          load();
        };
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); row.blur(); } if (e.key === 'Escape') { row.textContent = c.title; row.blur(); } });
        row.addEventListener('blur', () => done(true), { once: true });
      } else if (act === 'move') {
        await api.invoke('ai:chat-move', id, arg || null);
        load();
      } else if (act === 'delete') {
        if (!confirm(`Delete “${c.title}”?`)) return;
        await api.invoke('ai:delete-chat', id);
        if (current.chatId === id) panel.newTask({});
        load();
      }
    });
  }

  function projectMenu(anchor, id) {
    const p = projects.find((x) => x.id === id);
    if (!p) return;
    showMenu(anchor, `<button data-act="edit">Edit name and instructions</button><button data-act="new">New task in this project</button><button data-act="delete" class="danger">Delete project</button>`, async (act) => {
      if (act === 'edit') showForm(p);
      if (act === 'new') panel.newTask({ projectId: id, full: isNewTab() });
      if (act === 'delete') {
        if (!confirm(`Delete the project “${p.name}”? Its chats stay, outside any project.`)) return;
        await api.invoke('ai:project-remove', id);
        if (projectView === id) projectView = null;
        load();
      }
    });
  }

  // ---------------------------------------------------------------- search
  const search = $('#sb-search');
  $('#sb-search-btn').addEventListener('click', () => {
    search.hidden = !search.hidden;
    if (!search.hidden) { $('#sb-q').value = ''; $('#sb-results').innerHTML = ''; $('#sb-q').focus(); }
  });
  let searchTimer;
  $('#sb-q').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const q = $('#sb-q').value.trim();
      const found = q ? await api.invoke('ai:chat-search', q).catch(() => []) : [];
      $('#sb-results').innerHTML = q && !found.length ? '<div class="sb-empty">No chats match.</div>'
        : found.map((c) => `<button class="sb-row sb-hit" data-chat="${esc(c.id)}"><span class="sb-t">${esc(c.title || 'Chat')}</span>${c.snippet ? `<small>${esc(c.snippet)}</small>` : ''}</button>`).join('');
    }, 120);
  });
  $('#sb-q').addEventListener('keydown', (e) => { if (e.key === 'Escape') { search.hidden = true; } });
  $('#sb-results').addEventListener('click', (e) => {
    const c = e.target.closest('[data-chat]');
    if (!c) return;
    search.hidden = true;
    panel.openChat(c.dataset.chat, { full: isNewTab() });
  });

  // ---------------------------------------------------------------- get started
  function renderStart(signedIn) {
    const box = $('#sb-start');
    if (!getStarted || !getAi().workflows) { box.hidden = true; return; }
    let phoneOpened = false;
    try { phoneOpened = localStorage.getItem('lumioGetStartedPhone') === '1'; } catch {}
    const steps = [
      { id: 'sign-in', label: 'Sign in to Lumio', done: signedIn },
      { id: 'ask', label: 'Give Lumio a task', done: chats.length > 0 },
      { id: 'workflow', label: 'Save a workflow', done: workflows.length > 0 },
      { id: 'sync', label: 'Turn on Sync', done: syncState?.on && syncState?.status === 'ready' },
      { id: 'phone', label: 'Get Lumio on your phone', done: phoneOpened },
    ];
    const done = steps.filter((s) => s.done).length;
    if (done === steps.length) { box.hidden = true; return; }
    // Starts folded on shorter windows, so it doesn't take half the sidebar.
    if (box.dataset.shown !== '1') { box.dataset.shown = '1'; box.classList.toggle('collapsed', window.innerHeight < 900); }
    const collapsed = box.classList.contains('collapsed');
    box.hidden = false;
    box.innerHTML = `<button class="sb-start-head" id="sb-start-toggle"><b>Get started</b><small>${done} of ${steps.length}</small><i class="sb-chev">${IC.chev}</i></button>
      <div class="sb-start-steps">${steps.map((s) => `<button class="sb-step${s.done ? ' done' : ''}" data-step="${s.id}"><i>${s.done ? IC.check : ''}</i><span>${s.label}</span></button>`).join('')}
      <button class="sb-start-hide" id="sb-start-hide">Hide this</button></div>`;
    box.classList.toggle('collapsed', collapsed);
    $('#sb-start-toggle').addEventListener('click', () => box.classList.toggle('collapsed'));
    $('#sb-start-hide').addEventListener('click', () => { getStarted = false; api.send('sidebar:set', { getStarted: false }); box.hidden = true; });
    box.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.step;
      if (id === 'sign-in') api.send('account:sign-in');
      if (id === 'ask') panel.newTask({ full: isNewTab() });
      if (id === 'workflow') { section = 'templates'; renderSections(); }
      if (id === 'sync') api.send('tab:new', 'lumio://settings/#sync');
      if (id === 'phone') { try { localStorage.setItem('lumioGetStartedPhone', '1'); } catch {} api.send('tab:new', 'lumio://settings/#sync'); renderStart(signedIn); }
    }));
  }

  return {
    init(data) {
      getStarted = data.sidebar?.getStarted !== false;
      setOpen(data.sidebar?.open !== false && window.innerWidth >= 1000, false);
      load();
    },
    refresh: load,
    toggle: () => setOpen(!open),
  };
}
