// Settings › Privacy › Muted sites (the tab menu's Mute site) and Default
// browser › Ask at startup. The browser side is main/tab-strip.js and
// main/default-browser.js.
const page = window.lumioPage;
const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hostOf = (origin) => { try { return new URL(origin).host; } catch { return origin; } };

// ---------------------------------------------------------------- muted sites
function renderMuted(list) {
  const sites = Array.isArray(list) ? list : [];
  $('#muted-list').innerHTML = sites.length
    ? sites.map((origin) => `<div class="row"><div class="grow"><div class="title">${esc(hostOf(origin))}</div><div class="desc">${esc(origin)}</div></div><button class="btn" data-unmute="${esc(origin)}" aria-label="Unmute ${esc(hostOf(origin))}">Unmute</button></div>`).join('')
    : '<div class="row"><div class="desc">Sites you mute from a tab’s menu (Mute site) stay quiet in every tab. They’re listed here.</div></div>';
}
$('#muted-list').addEventListener('click', async (e) => {
  const origin = e.target.closest('[data-unmute]')?.dataset.unmute;
  if (!origin) return;
  renderMuted(await page.invoke('page:unmute-site', origin));
  $('#muted-list button')?.focus();
});
renderMuted(await page.invoke('page:muted-sites'));

// ---------------------------------------------------------------- default browser bar
const ask = $('#default-prompt');
const prompt = await page.invoke('page:default-prompt');
ask.checked = prompt?.prompt !== false;
ask.addEventListener('change', async () => {
  const res = await page.invoke('page:set-default-prompt', ask.checked);
  if (res) ask.checked = res.prompt;
});
