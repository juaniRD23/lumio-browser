// The translate bubble under the address bar's Translate button (opened by
// renderer/ui/translate.js; main/translate.js does the translating). It asks
// before translating, shows progress, switches back to the original, and
// holds the language choices: always / never translate a language, never
// translate a site, and which language to translate into.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 6h9M8 4v2c0 4-2.2 7.2-5 8.5"/><path d="M5.5 9.5c1 2.2 3 3.9 5.5 4.6"/><path d="M12.5 20l4-9.5 4 9.5M14 16.8h5"/></svg>';
const X = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>';

let names = null;
// "fr" -> "French"; Chinese by its writing system, which is what people pick.
export function languageName(code) {
  if (!code) return '';
  try {
    names ||= new Intl.DisplayNames(['en'], { type: 'language' });
    return names.of({ 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant' }[code] || code) || code;
  } catch { return code; }
}

function view(p) {
  const from = languageName(p.lang);
  const to = languageName(p.target);
  const select = `<select data-act="target" aria-label="Translate to">${(p.languages || [p.target]).map((c) => `<option value="${esc(c)}" ${c === p.target ? 'selected' : ''}>${esc(languageName(c))}</option>`).join('')}</select>`;
  const langLine = `<div class="tb-langs">${from ? `<span>${esc(from)}</span><span class="tb-arrow" aria-hidden="true">→</span>` : '<span>To</span>'}${select}</div>`;
  let title;
  let sub = '';
  let actions;
  if (!p.signedIn || p.status === 'signin') {
    title = 'Sign in to translate';
    sub = 'Lumio AI translates pages with your Lumio account. It’s free to start.';
    actions = '<button class="acc-btn ghost" data-act="dismiss">Not now</button><button class="acc-btn primary" data-act="sign-in">Sign in to Lumio</button>';
  } else if (!p.canTranslate) {
    title = 'This page can’t be translated';
    actions = '<button class="acc-btn primary" data-act="close">OK</button>';
  } else if (p.status === 'translating') {
    title = `Translating to ${to}…`;
    actions = '<button class="acc-btn ghost" data-act="original">Show original</button>';
  } else if (p.status === 'translated') {
    title = `Translated to ${to}`;
    sub = p.capped ? 'This page is very long: Lumio translated the first part.' : '';
    actions = '<button class="acc-btn ghost" data-act="original">Show original</button><button class="acc-btn primary" data-act="close">Done</button>';
  } else if (p.status === 'error') {
    title = 'Couldn’t translate this page';
    sub = p.error || 'Try again in a moment.';
    actions = '<button class="acc-btn ghost" data-act="original">Show original</button><button class="acc-btn primary" data-act="translate">Try again</button>';
  } else {
    title = 'Translate this page?';
    actions = '<button class="acc-btn ghost" data-act="dismiss">Not now</button><button class="acc-btn primary" data-act="translate">Translate</button>';
  }
  const check = (act, on, label) => `<label class="tb-check"><input type="checkbox" data-act="${act}" ${on ? 'checked' : ''}><span>${esc(label)}</span></label>`;
  // Incognito: Always translate doesn't apply there, and no site is remembered.
  const options = p.lang && p.signedIn && p.canTranslate ? `<div class="tb-options" role="group" aria-label="Translate settings">
      ${p.incognito ? '' : check('always', p.always, `Always translate ${from}`)}
      ${check('never', p.never, `Never translate ${from}`)}
      ${p.incognito || !p.host ? '' : check('never-site', p.neverSite, 'Never translate this site')}
    </div>` : '';
  return `<div class="tb" role="dialog" aria-labelledby="tb-title" aria-describedby="tb-sub">
    <div class="tb-head"><span class="tb-ic${p.status === 'translating' ? ' busy' : ''}">${ICON}</span><span class="tb-title" id="tb-title" aria-live="polite">${esc(title)}</span><button class="tb-x" data-act="dismiss" title="Close (Esc)" aria-label="Close">${X}</button></div>
    ${p.status === 'translating' ? '<div class="tb-bar" aria-hidden="true"><i></i></div>' : ''}
    <div class="tb-sub${p.status === 'error' ? ' err' : ''}" id="tb-sub">${esc(sub)}</div>
    ${p.signedIn && p.canTranslate ? langLine : ''}
    <div class="pws-actions tb-actions"><span style="flex:1"></span>${actions}</div>
    ${options}
    <div class="tb-note">Lumio AI translates the page’s text, using your Lumio AI allowance.</div>
  </div>`;
}

// Wires the bubble into the overlay's card once; render() draws each payload.
export function initTranslateBubble(card, api, isOpen) {
  let p = null;
  const close = (refocus = false, dismiss = false) => {
    if (refocus) api.send('translate:refocus');
    if (dismiss) api.send('translate:action', { action: 'dismiss', tabId: p?.tabId, refocus });
    else api.send('overlay:pick', { kind: 'translate', refocus });
  };
  const focusables = () => [...card.querySelectorAll('button, input, select')].filter((el) => !el.disabled);

  card.addEventListener('click', (e) => {
    if (!isOpen()) return;
    const el = e.target.closest('button[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    const keyboard = e.detail === 0;
    if (act === 'dismiss') close(keyboard, true);
    else if (act === 'close') close(keyboard);
    else if (act === 'sign-in') { api.send('account:sign-in'); api.send('overlay:pick', { kind: 'translate' }); }
    else api.send('translate:action', { action: act, tabId: p?.tabId });
  });
  card.addEventListener('change', (e) => {
    if (!isOpen()) return;
    const el = e.target.closest('[data-act]');
    if (!el) return;
    api.send('translate:action', { action: el.dataset.act, tabId: p?.tabId, value: el.type === 'checkbox' ? el.checked : el.value });
  });
  card.addEventListener('keydown', (e) => {
    if (!isOpen()) return;
    if (e.key === 'Escape') { e.preventDefault(); close(true, true); return; }
    if (e.key === 'Enter' && e.target.matches('input[type=checkbox]')) { e.preventDefault(); e.target.click(); return; }
    // Arrows move between the bubble's controls (a list keeps its own arrows).
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key) && !e.target.matches('select')) {
      const list = focusables();
      const i = list.indexOf(e.target);
      const next = list[(i + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length];
      if (next) { e.preventDefault(); next.focus(); }
    }
  });

  return {
    render(payload) {
      // Redrawn as translating goes on: keep the keyboard where it was.
      const had = card.contains(document.activeElement) ? document.activeElement.dataset.act : null;
      p = payload;
      card.innerHTML = view(payload);
      const again = had && card.querySelector(`[data-act="${had}"]`);
      if (again) again.focus();
      else if (payload.focus) (card.querySelector('.tb-actions .primary') || card.querySelector('.tb-actions button'))?.focus();
    },
  };
}
