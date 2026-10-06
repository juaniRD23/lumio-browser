// lumio://flags-lite: a few experimental switches (main/flags.js), applied
// when Lumio restarts.
import './keys.js';
const page = window.lumioPage;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function render(s) {
  $('#flags').innerHTML = s.flags.map((f) => `
    <div class="row">
      <div class="grow"><div class="title" id="t-${f.id}">${esc(f.name)}${f.value !== f.default ? ' <span class="pill">Changed</span>' : ''}</div><div class="desc">${esc(f.description)}</div></div>
      <label class="switch"><input type="checkbox" data-flag="${esc(f.id)}" aria-labelledby="t-${f.id}" ${f.value ? 'checked' : ''}><i></i></label>
    </div>`).join('');
  $('#restart').hidden = !s.restart;
}

$('#flags').addEventListener('change', async (e) => {
  const input = e.target.closest('[data-flag]');
  if (!input) return;
  render(await page.invoke('page:set-flag', input.dataset.flag, input.checked));
  document.querySelector(`[data-flag="${input.dataset.flag}"]`)?.focus();
});
$('#reset').addEventListener('click', async () => render(await page.invoke('page:flags-reset')));
$('#relaunch').addEventListener('click', () => page.invoke('page:relaunch'));

render(await page.invoke('page:flags'));
