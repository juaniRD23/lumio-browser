// The toolbar's performance buttons (main/perf.js decides when they show):
//  - "Performance issues", when a background tab uses a lot of memory or CPU.
//    Its popup (in the overlay, renderer/ui/overlay-perf.js) offers Fix now.
//  - a leaf while Energy Saver is on; it opens Settings › Performance.
// Also tells the browser the battery level, which decides Energy Saver.
import { icons } from './icons.js';

export function initPerf(api, init) {
  const before = document.getElementById('downloads');
  const issues = document.createElement('button');
  issues.id = 'perf-btn';
  issues.className = 'perf-btn';
  issues.hidden = true;
  issues.setAttribute('aria-haspopup', 'dialog');
  issues.setAttribute('aria-expanded', 'false');
  issues.innerHTML = `<span class="ic">${icons.pulse}</span><span class="label">Performance issues</span>`;
  const energy = document.createElement('button');
  energy.id = 'energy-btn';
  energy.className = 'icon-btn energy-btn';
  energy.hidden = true;
  energy.innerHTML = icons.leaf;
  energy.title = 'Energy Saver is on: preloading and animations are off to save battery';
  energy.setAttribute('aria-label', 'Energy Saver is on. Open Performance settings');
  before.before(issues, energy);

  let alert = null;
  let open = false;
  const close = () => {
    if (!open) return;
    open = false;
    issues.setAttribute('aria-expanded', 'false');
    api.send('overlay:hide', 'perf');
  };
  const show = (focus) => {
    const r = issues.getBoundingClientRect();
    const width = 340;
    open = true;
    issues.setAttribute('aria-expanded', 'true');
    api.send('overlay:show', {
      rect: { x: Math.max(8, r.right - width - 12 + 8), y: r.bottom + 6, width: width + 24, height: 160 + Math.min(alert.tabs.length, 6) * 44 },
      payload: { kind: 'perf', alert, focus },
    });
  };
  const render = (a) => {
    alert = a && a.tabs?.length ? a : null;
    issues.hidden = !alert;
    issues.title = alert ? `${alert.count === 1 ? 'A background tab is' : `${alert.count} background tabs are`} using a lot of memory or power` : '';
    if (!alert) close();
    else if (open) show(false);
  };

  issues.addEventListener('mousedown', (e) => e.preventDefault()); // keep the address bar's focus
  // A click from the keyboard (detail 0) moves focus into the popup, so its buttons can be reached.
  issues.addEventListener('click', (e) => (open ? close() : alert && show(e.detail === 0)));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) close(); });
  window.addEventListener('mousedown', (e) => { if (open && !e.target.closest('#perf-btn')) close(); });
  api.on('overlay-picked', (msg) => { if (msg?.kind === 'perf') { open = false; issues.setAttribute('aria-expanded', 'false'); } });
  api.on('perf-alert', render);
  api.invoke('perf:alert').then(render).catch(() => {});

  energy.addEventListener('click', () => api.send('perf:settings'));
  const energyState = (s) => { energy.hidden = !s?.energySaver; };
  energyState(init.perf);
  api.on('perf-state', energyState);

  // The battery, for Energy Saver ("at 20% or lower").
  navigator.getBattery?.().then((b) => {
    const send = () => api.send('perf:battery', { level: b.level, charging: b.charging });
    send();
    b.addEventListener('levelchange', send);
    b.addEventListener('chargingchange', send);
  }).catch(() => {});
}
