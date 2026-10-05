// Settings › Languages (main/languages.js): Lumio's own language (after a
// restart), the languages websites are asked for, in order, and spell check.
// The section is built here, before settings.js starts, so its side link,
// the search and the section highlight see it like the others.
const page = window.lumioPage;
const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Lumio's languages, each written in itself so people find their own.
const UI_LANGUAGES = { en: 'English', es: 'Español' };

document.querySelector('.side a[href="#downloads"]')?.insertAdjacentHTML('beforebegin', '<a href="#languages">Languages</a>');
(document.getElementById('downloads') || document.getElementById('about'))?.insertAdjacentHTML('beforebegin', `
      <!-- Languages (settings-languages.js) -->
      <section id="languages">
        <h2>Languages</h2>
        <div class="card">
          <div class="row">
            <div class="grow"><div class="title">Lumio language</div><div class="desc">Menus, buttons and Lumio’s own pages. System uses your computer’s language when Lumio has it.</div></div>
            <select id="ui-lang" class="field" aria-label="Lumio language"></select>
          </div>
          <div class="row" id="ui-lang-restart" hidden>
            <div class="grow desc">Restart Lumio to use the new language. Your tabs come back.</div>
            <button class="btn primary" type="button" id="ui-lang-relaunch">Restart</button>
          </div>
        </div>
        <h3>Preferred languages</h3>
        <div class="card">
          <div class="row"><div class="grow"><div class="desc">Websites that come in more than one language show the first one they have from this list.</div></div></div>
          <ol class="lang-list" id="lang-list" aria-label="Preferred languages"></ol>
          <div class="row lang-add">
            <select id="lang-add" class="field" aria-label="Add a language"></select>
            <span class="grow"></span>
            <button class="btn ghost" type="button" id="lang-system" hidden>Use my computer’s languages</button>
          </div>
        </div>
        <h3>Spell check</h3>
        <div class="card">
          <label class="row" style="cursor:pointer">
            <div class="grow"><div class="title">Check spelling as you type</div><div class="desc">Underlines misspelled words in text fields. Right-click one for suggestions.</div></div>
            <span class="switch"><input type="checkbox" id="spell-on"><i></i></span>
          </label>
          <div class="row" id="spell-mac" hidden><div class="desc">Your Mac checks spelling in the language you type in, with its own dictionaries.</div></div>
          <div class="row checks" id="spell-langs" hidden></div>
        </div>
      </section>
`);

let st = null;
const uiLang = document.documentElement.lang || 'en';
const nameIn = (locale) => { try { return new Intl.DisplayNames([locale], { type: 'language' }); } catch { return null; } };
const names = nameIn(uiLang);
const label = (tag) => names?.of(tag) || tag;
// The language's name in itself ("español (Argentina)"), when it's different.
const native = (tag) => { const n = nameIn(tag)?.of(tag); return n && n !== label(tag) ? n : ''; };

function renderUi() {
  const system = UI_LANGUAGES[st.ui.system] || 'English';
  $('#ui-lang').innerHTML = `<option value="system">System (${esc(system)})</option>`
    + Object.entries(UI_LANGUAGES).map(([id, n]) => `<option value="${id}" translate="no">${esc(n)}</option>`).join('');
  $('#ui-lang').value = st.ui.setting;
  $('#ui-lang-restart').hidden = !st.ui.restart;
}

function renderList(focus) {
  const list = st.languages;
  $('#lang-list').innerHTML = list.map((tag, i) => `
    <li class="row lang-row" data-tag="${esc(tag)}">
      <span class="lang-n" aria-hidden="true">${i + 1}</span>
      <div class="grow"><div class="title" translate="no">${esc(label(tag))}</div>${native(tag) ? `<div class="desc" translate="no">${esc(native(tag))}</div>` : ''}</div>
      <button class="btn ghost icon" type="button" data-act="up" aria-label="Move ${esc(label(tag))} up" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="btn ghost icon" type="button" data-act="down" aria-label="Move ${esc(label(tag))} down" title="Move down" ${i === list.length - 1 ? 'disabled' : ''}>↓</button>
      <button class="btn ghost icon" type="button" data-act="remove" aria-label="Remove ${esc(label(tag))}" title="Remove" ${list.length === 1 ? 'disabled' : ''}>×</button>
    </li>`).join('');
  const choices = st.choices.filter((tag) => !list.includes(tag)).map((tag) => [tag, label(tag)]).sort((a, b) => a[1].localeCompare(b[1], uiLang));
  $('#lang-add').innerHTML = '<option value="">Add a language…</option>'
    + choices.map(([tag, n]) => `<option value="${esc(tag)}" translate="no">${esc(n)}${native(tag) ? ` — ${esc(native(tag))}` : ''}</option>`).join('');
  $('#lang-system').hidden = !st.custom;
  // Keep the keyboard where it was: on the same button of the row that moved.
  if (focus) {
    const btn = $(`#lang-list [data-tag="${CSS.escape(focus.tag)}"] [data-act="${focus.act}"]`);
    (btn && !btn.disabled ? btn : $(`#lang-list [data-tag="${CSS.escape(focus.tag)}"] button:not([disabled])`) || $('#lang-add')).focus();
  }
}

function renderSpell() {
  const sp = st.spellcheck;
  $('#spell-on').checked = sp.on;
  $('#spell-mac').hidden = !sp.mac;
  // Windows and Linux: the dictionaries that fit your languages.
  const fits = sp.mac ? [] : sp.available.filter((code) => st.languages.some((tag) => code === tag || code.split('-')[0] === tag.split('-')[0]) || sp.languages.includes(code));
  $('#spell-langs').hidden = sp.mac || !sp.on;
  $('#spell-langs').innerHTML = fits.length
    ? fits.map((code) => `<label><input type="checkbox" data-spell="${esc(code)}" ${sp.languages.includes(code) ? 'checked' : ''}> <span translate="no">${esc(label(code))}</span></label>`).join('')
    : '<span class="desc">There’s no spell check dictionary for your languages yet.</span>';
}

function render(focus) {
  renderUi();
  renderList(focus);
  renderSpell();
}

const save = async (channel, value, focus) => { st = await page.invoke(channel, value); render(focus); };

$('#ui-lang').addEventListener('change', (e) => save('page:set-ui-language', e.target.value));
$('#ui-lang-relaunch').addEventListener('click', () => page.invoke('page:relaunch'));
$('#lang-list').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  const tag = e.target.closest('[data-tag]')?.dataset.tag;
  if (!b || !tag) return;
  const list = [...st.languages];
  const i = list.indexOf(tag);
  if (b.dataset.act === 'remove') list.splice(i, 1);
  else {
    const j = b.dataset.act === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
  }
  const next = b.dataset.act === 'remove' ? list[Math.min(i, list.length - 1)] : tag;
  save('page:set-languages', list, { tag: next, act: b.dataset.act === 'remove' ? 'remove' : b.dataset.act });
});
$('#lang-add').addEventListener('change', (e) => {
  const tag = e.target.value;
  if (tag) save('page:set-languages', [...st.languages, tag], { tag, act: 'up' });
});
$('#lang-system').addEventListener('click', () => save('page:set-languages', null));
$('#spell-on').addEventListener('change', (e) => save('page:set-spellcheck', { on: e.target.checked }));
$('#spell-langs').addEventListener('change', () => {
  const languages = [...document.querySelectorAll('#spell-langs [data-spell]:checked')].map((i) => i.dataset.spell);
  save('page:set-spellcheck', { languages });
});

// Loads after the section is in place (settings.js waits for nothing here).
page.invoke('page:languages').then((state) => { st = state; render(); }).catch(() => {});
