// Settings › Performance (main/perf.js): Memory Saver and its modes, sites
// that always stay active, Energy Saver, performance issue alerts, preloading
// and the Task Manager. These settings are the same in every profile.
const page = window.lumioPage;
const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DEFAULTS = { memorySaver: true, mode: 'balanced', sites: [], energySaver: true, energySaverWhen: 'low', saving: false, alerts: true, preload: 'standard' };
let p = { ...DEFAULTS, ...((await page.invoke('page:performance')) || {}) };

const set = async (key, value) => { p = { ...p, ...((await page.invoke('page:set-performance', key, value)) || {}) }; render(); };
const radios = (name) => [...document.querySelectorAll(`input[name="${name}"]`)];

function render() {
  $('#mem-saver').checked = p.memorySaver;
  radios('mem-mode').forEach((r) => { r.checked = r.value === p.mode; r.disabled = !p.memorySaver; });
  $('#mem-modes').classList.toggle('dim', !p.memorySaver);
  $('#keep-list').innerHTML = p.sites.map((site) => `<li><span>${esc(site)}</span><button type="button" class="keep-x" data-site="${esc(site)}" aria-label="Stop keeping ${esc(site)} active">×</button></li>`).join('');
  $('#keep-list').hidden = !p.sites.length;
  $('#energy').checked = p.energySaver;
  $('#energy-now').hidden = !p.saving;
  radios('energy-when').forEach((r) => { r.checked = r.value === p.energySaverWhen; r.disabled = !p.energySaver; });
  $('#energy-when').classList.toggle('dim', !p.energySaver);
  $('#perf-alerts').checked = p.alerts;
  radios('preload').forEach((r) => { r.checked = r.value === p.preload; });
}

$('#mem-saver').addEventListener('change', (e) => set('memorySaver', e.target.checked));
radios('mem-mode').forEach((r) => r.addEventListener('change', () => set('mode', r.value)));
$('#energy').addEventListener('change', (e) => set('energySaver', e.target.checked));
radios('energy-when').forEach((r) => r.addEventListener('change', () => set('energySaverWhen', r.value)));
$('#perf-alerts').addEventListener('change', (e) => set('alerts', e.target.checked));
radios('preload').forEach((r) => r.addEventListener('change', () => set('preload', r.value)));
$('#open-task-manager').addEventListener('click', () => page.invoke('page:task-manager'));

// "Always keep these sites active": the browser cleans up what's typed
// ("https://www.youtube.com/watch" becomes youtube.com) and drops what isn't a site.
$('#keep-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#keep-input');
  const text = input.value.trim();
  if (!text) return;
  const before = p.sites.length;
  await set('sites', [...p.sites, text]);
  const added = p.sites.length > before;
  let err = '';
  if (!added) err = p.sites.length >= 100 ? 'The list holds up to 100 sites.' : `“${text}” isn’t a site address, or it’s already on the list.`;
  $('#keep-err').textContent = err;
  if (added) input.value = '';
  input.focus();
});
$('#keep-input').addEventListener('input', () => { $('#keep-err').textContent = ''; });
$('#keep-list').addEventListener('click', async (e) => {
  const site = e.target.closest('[data-site]')?.dataset.site;
  if (!site) return;
  await set('sites', p.sites.filter((x) => x !== site));
  ($('#keep-list .keep-x') || $('#keep-input')).focus();
});

render();
