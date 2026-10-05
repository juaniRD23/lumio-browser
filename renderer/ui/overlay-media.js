// The media controls popover under the toolbar's media button
// (renderer/ui/media.js opens it; main/media.js reads and controls the
// tabs). One card per tab that's playing or paused: what's playing, a seek
// bar when the length is known, previous / play-pause / next, Picture in
// picture and Go to tab. It refreshes every second while it's open.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const svg = (d, size = 16) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const NOTE_ICON = svg('<path d="M9 18V5.5l10-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>', 17);
const I = {
  note: svg('<path d="M9 18V5.5l10-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>', 20),
  play: svg('<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>', 18),
  pause: svg('<rect x="6.5" y="5.5" width="3.8" height="13" rx="1" fill="currentColor" stroke="none"/><rect x="13.7" y="5.5" width="3.8" height="13" rx="1" fill="currentColor" stroke="none"/>', 18),
  prev: svg('<path d="M18 6.5v11l-8-5.5z" fill="currentColor"/><path d="M7 6v12"/>'),
  next: svg('<path d="M6 6.5v11l8-5.5z" fill="currentColor"/><path d="M17 6v12"/>'),
  pip: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11.5" width="7" height="5.5" rx="1" fill="currentColor" stroke="none"/>'),
  go: svg('<path d="M14 5h5v5M19 5l-8 8"/><path d="M17 13.5V18a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4.5"/>', 14),
  x: svg('<path d="M7 7l10 10M17 7L7 17"/>', 14),
};

export function clock(s) {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const t = Math.floor(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function item(it) {
  const pic = it.artwork || it.favicon;
  const art = pic ? `<img src="${esc(pic)}" alt=""${it.artwork ? '' : ' class="fav"'}>` : I.note;
  const seek = it.duration ? `<div class="mh-seek">
      <span class="mh-t" data-time>${clock(it.time)}</span>
      <input type="range" min="0" max="${Math.floor(it.duration)}" step="1" value="${Math.floor(it.time || 0)}" aria-label="Seek: ${esc(it.title)}" aria-valuetext="${clock(it.time)} of ${clock(it.duration)}" ${it.canSeek ? '' : 'disabled'}>
      <span class="mh-t">${clock(it.duration)}</span>
    </div>` : '';
  return `<section class="mh-item${it.playing ? ' playing' : ''}" data-tab="${it.tabId}" aria-label="${esc(it.title)}">
    <div class="mh-top">
      <span class="mh-art">${art}</span>
      <button type="button" class="mh-meta" data-act="goto" title="Go to tab"><b>${esc(it.title || it.host)}</b><span>${esc([it.artist, it.host].filter(Boolean).join(' · '))}</span></button>
    </div>
    ${seek}
    <div class="mh-ctrls">
      <button type="button" class="mh-btn" data-act="prev" title="Previous" aria-label="Previous" ${it.canPrev ? '' : 'disabled'}>${I.prev}</button>
      <button type="button" class="mh-btn mh-play" data-act="${it.playing ? 'pause' : 'play'}" title="${it.playing ? 'Pause' : 'Play'}" aria-label="${it.playing ? 'Pause' : 'Play'}">${it.playing ? I.pause : I.play}</button>
      <button type="button" class="mh-btn" data-act="next" title="Next" aria-label="Next" ${it.canNext ? '' : 'disabled'}>${I.next}</button>
      <span class="spacer"></span>
      ${it.canPip || it.pip ? `<button type="button" class="mh-btn" data-act="pip" title="Picture in picture" aria-label="Picture in picture" aria-pressed="${it.pip}">${I.pip}</button>` : ''}
      <button type="button" class="mh-go" data-act="goto">${it.current ? 'This tab' : 'Go to tab'} ${I.go}</button>
    </div>
  </section>`;
}

export function initMediaHub(card, api, isOpen, reportSize) {
  let items = [];
  let timer = null;
  let dragging = false;
  let shape = ''; // which cards are shown: the popover is measured again only when it changes
  const close = (refocus = false) => {
    if (refocus) api.send('media:refocus');
    api.send('overlay:pick', { kind: 'media', refocus });
  };

  function draw() {
    // Redrawn every second: keep the keyboard where it was.
    const had = card.contains(document.activeElement) ? { tab: document.activeElement.closest('[data-tab]')?.dataset.tab, act: document.activeElement.dataset.act || (document.activeElement.type === 'range' ? 'seek' : null), go: document.activeElement.classList.contains('mh-go') } : null;
    card.innerHTML = `<div class="mh" role="dialog" aria-labelledby="mh-title">
      <div class="mh-head"><b id="mh-title">Media</b><span class="spacer"></span><button type="button" class="mh-x" data-act="close" title="Close (Esc)" aria-label="Close">${I.x}</button></div>
      ${items.length ? items.map(item).join('') : '<p class="mh-empty">Nothing is playing.</p>'}
    </div>`;
    card.querySelectorAll('.mh-art img').forEach((img) => { img.onerror = () => { img.outerHTML = I.note; }; });
    if (had?.tab) {
      const sel = had.act === 'seek' ? 'input[type=range]' : had.act === 'play' || had.act === 'pause' ? '.mh-play' : had.go ? '.mh-go' : `[data-act="${had.act}"]`; // two "goto"s: the title and Go to tab
      card.querySelector(`[data-tab="${had.tab}"]`)?.querySelector(sel)?.focus();
    }
    const now = items.map((it) => `${it.tabId}:${!!it.duration}:${!!it.artist}`).join(',');
    if (now !== shape) { shape = now; reportSize(); }
  }
  async function refresh() {
    if (!isOpen('media') || dragging) return;
    const list = await api.invoke('media:list').catch(() => null);
    if (!isOpen('media') || dragging || !Array.isArray(list)) return;
    items = list;
    draw();
  }
  const act = async (tabId, action, value) => {
    await api.invoke('media:action', { tabId, action, ...(value === undefined ? {} : { value }) }).catch(() => {});
    setTimeout(refresh, 250);
  };

  card.addEventListener('click', (e) => {
    if (!isOpen('media')) return;
    const el = e.target.closest('[data-act]');
    if (!el) return;
    if (el.dataset.act === 'close') { close(e.detail === 0); return; }
    const tabId = Number(el.closest('[data-tab]')?.dataset.tab);
    if (tabId) act(tabId, el.dataset.act);
  });
  card.addEventListener('pointerdown', (e) => { if (isOpen('media') && e.target.matches('input[type=range]')) dragging = true; });
  card.addEventListener('input', (e) => {
    if (!isOpen('media') || !e.target.matches('input[type=range]')) return;
    e.target.closest('.mh-seek').querySelector('[data-time]').textContent = clock(Number(e.target.value));
  });
  card.addEventListener('change', (e) => {
    if (!isOpen('media') || !e.target.matches('input[type=range]')) return;
    dragging = false;
    act(Number(e.target.closest('[data-tab]').dataset.tab), 'seek', Number(e.target.value));
  });
  card.addEventListener('keydown', (e) => {
    if (!isOpen('media')) return;
    if (e.key === 'Escape') { e.preventDefault(); close(true); return; }
    if (!['ArrowDown', 'ArrowUp'].includes(e.key) || e.target.matches('input[type=range]')) return;
    const list = [...card.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
    const next = list[(list.indexOf(e.target) + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length];
    if (next) { e.preventDefault(); next.focus(); }
  });
  window.addEventListener('pointerup', () => { dragging = false; });

  return {
    render(payload) {
      items = Array.isArray(payload.items) ? payload.items : [];
      shape = '';
      draw();
      if (payload.focus) (card.querySelector('.mh-play') || card.querySelector('button'))?.focus();
      clearInterval(timer);
      timer = setInterval(() => { if (isOpen('media')) refresh(); else clearInterval(timer); }, 1000);
    },
  };
}
