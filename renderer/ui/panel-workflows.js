// Saved workflows in the AI panel: type / in the chat box to pick one, fill in
// its blanks on a small card, and run it. After a task with several steps,
// "Save as workflow" asks Lumio to save it for next time.
import { icons } from './icons.js';

const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function initWorkflows({ api, prompt, autosize, notice, run, isEnabled, onSave }) {
  const menu = $('#wf-menu');
  const card = $('#wf-card');
  let list = [];
  let shown = [];
  let sel = 0;

  async function load() {
    list = isEnabled() ? await api.invoke('ai:workflows').catch(() => []) : [];
    if (!menu.hidden) render();
    return list;
  }
  api.on('workflows-changed', load);

  // ---------------------------------------------------------------- the / menu
  const typed = () => (/^\/[^\n]*$/.test(prompt.value) ? prompt.value.slice(1).trim().toLowerCase() : null);
  function render() {
    const q = typed() ?? '';
    shown = list.filter((w) => !q || w.title.toLowerCase().includes(q) || (w.description || '').toLowerCase().includes(q)).slice(0, 8);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    menu.innerHTML = `<div class="list-label">Workflows</div>${shown.length
      ? shown.map((w, i) => `<button type="button" class="menu-row${i === sel ? ' sel' : ''}" role="option" aria-selected="${i === sel}" data-id="${esc(w.id)}">
          <span class="mi">${icons.workflow}</span>
          <span class="mt"><b>${esc(w.title)}</b><small>${esc(w.description || (w.inputs.length ? `Asks for ${w.inputs.map((x) => x.label.toLowerCase()).join(', ')}` : w.instructions.split('\n')[0]).slice(0, 80))}</small></span>
        </button>`).join('')
      : `<div class="wf-empty">${list.length ? `No workflow matches “${esc(q)}”.` : 'No workflows yet. After Lumio finishes a task, click “Save as workflow”, or ask it to save one.'}</div>`}`;
  }
  function openMenu() {
    if (!isEnabled()) return;
    document.querySelectorAll('#composer .popover').forEach((p) => { if (p !== menu) p.hidden = true; });
    const wasHidden = menu.hidden;
    menu.hidden = false;
    render();
    if (wasHidden) load(); // fresh each time it opens (it may have changed in Settings or on another device)
  }
  function closeMenu() { menu.hidden = true; }
  menu.addEventListener('mousedown', (e) => e.preventDefault()); // keep the chat box focused
  menu.addEventListener('click', (e) => {
    const id = e.target.closest('[data-id]')?.dataset.id;
    if (id) choose(id);
  });

  function choose(id) {
    closeMenu();
    prompt.value = '';
    autosize();
    open(id);
  }

  // ---------------------------------------------------------------- the card
  async function open(id) {
    let w = list.find((x) => x.id === id);
    if (!w) w = (await load()).find((x) => x.id === id);
    if (!w) { notice('That workflow doesn’t exist anymore.'); return; }
    if (!w.inputs.length) { close(); run(w.id, {}); return; }
    card.hidden = false;
    card.innerHTML = `<div class="wf-head">${icons.workflow}<span>${esc(w.title)}</span><button type="button" class="wf-x" aria-label="Cancel">×</button></div>
      ${w.inputs.map((i) => `<label>${esc(i.label)}<input type="text" data-name="${esc(i.name)}" maxlength="500" autocomplete="off"></label>`).join('')}
      <button type="button" class="wf-run">Run workflow</button>`;
    const go = async () => {
      const values = Object.fromEntries([...card.querySelectorAll('input')].map((el) => [el.dataset.name, el.value]));
      const empty = [...card.querySelectorAll('input')].find((el) => !el.value.trim());
      if (empty) { empty.focus(); return; }
      if (await run(w.id, values)) close();
    };
    card.querySelector('.wf-x').addEventListener('click', close);
    card.querySelector('.wf-run').addEventListener('click', go);
    card.querySelectorAll('input').forEach((el) => el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); go(); }
      if (e.key === 'Escape') { e.preventDefault(); close(); prompt.focus(); }
    }));
    card.querySelector('input').focus();
  }
  function close() { card.hidden = true; card.innerHTML = ''; }

  return {
    // The chat box changed: / at the start opens the menu.
    onInput() { if (typed() !== null) openMenu(); else closeMenu(); },
    // Keys in the chat box while the menu is open. True when handled.
    onKeydown(e) {
      if (menu.hidden) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (shown.length) sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
        render();
        return true;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (shown[sel]) choose(shown[sel].id);
        return true;
      }
      if (e.key === 'Escape') { e.preventDefault(); closeMenu(); return true; }
      return false;
    },
    open,
    // After a finished task with several steps: offer to save it.
    offerSave(after) {
      if (!isEnabled() || !after) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'save-wf';
      b.innerHTML = `${icons.workflow}<span>Save as workflow</span>`;
      b.title = 'Lumio saves this task so you can run it again with one click (type / in the chat box)';
      b.addEventListener('click', () => { b.remove(); onSave(); });
      after.after(b);
    },
    closeMenu,
  };
}
