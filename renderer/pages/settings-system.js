// Settings › System and Settings › Reset settings (main/system.js). Built
// here, before settings.js starts, so the side list, the search and the
// section highlight see them like the others.
const page = window.lumioPage;
const $ = (sel) => document.querySelector(sel);

document.querySelector('.side a[href="#about"]')?.insertAdjacentHTML('beforebegin', '<a href="#system">System</a><a href="#reset">Reset settings</a>');
document.getElementById('about')?.insertAdjacentHTML('beforebegin', `
      <!-- System (settings-system.js) -->
      <section id="system">
        <h2>System</h2>
        <div class="card">
          <label class="row" style="cursor:pointer">
            <div class="grow"><div class="title">Use graphics acceleration when available</div><div class="desc">Turn it off only if pages flicker or look wrong. Changes when Lumio restarts.</div></div>
            <span class="switch"><input type="checkbox" id="sys-gpu"><i></i></span>
          </label>
          <div class="row" id="sys-restart" hidden>
            <div class="grow desc">Restart Lumio to apply this change. Your tabs come back.</div>
            <button class="btn primary" type="button" id="sys-relaunch">Restart</button>
          </div>
          <div class="row" id="sys-proxy-row" hidden>
            <div class="grow"><div class="title">Open your computer’s proxy settings</div><div class="desc">Lumio connects through the proxy your computer uses.</div></div>
            <button class="btn" type="button" id="sys-proxy">Open</button>
          </div>
        </div>
      </section>

      <!-- Reset settings (settings-system.js) -->
      <section id="reset">
        <h2>Reset settings</h2>
        <div class="card">
          <div class="row">
            <div class="grow"><div class="title">Restore settings to their original defaults</div><div class="desc" id="reset-status" aria-live="polite">Your bookmarks, history and saved passwords stay.</div></div>
            <button class="btn" type="button" id="reset-open" aria-haspopup="dialog">Reset settings…</button>
          </div>
        </div>
        <dialog class="dialog" id="reset-dialog" aria-labelledby="reset-title" aria-describedby="reset-desc">
          <h3 id="reset-title">Reset settings?</h3>
          <p id="reset-desc">These go back to how they were when you first opened Lumio:</p>
          <ul class="reset-list">
            <li>Search engine, startup and downloads</li>
            <li>Appearance, theme color and the bookmarks bar</li>
            <li>Languages and spell check</li>
            <li>Performance and system settings</li>
            <li>Lumio AI’s thinking effort and approvals</li>
            <li>Offers to save passwords, and site permissions</li>
          </ul>
          <p class="keep">Your bookmarks, history, saved passwords, chats, workflows, scheduled tasks, extensions and Lumio account stay as they are.</p>
          <div class="dialog-actions">
            <button class="btn" type="button" id="reset-cancel" autofocus>Cancel</button>
            <button class="btn danger-fill" type="button" id="reset-go">Reset settings</button>
          </div>
        </dialog>
      </section>
`);

// A Guest can't change app-wide settings or reset them: those sections hide.
page.invoke('page:profiles').then((info) => {
  if (!info?.guest) return;
  for (const id of ['system', 'reset']) {
    document.getElementById(id).hidden = true;
    document.querySelector(`.side a[href="#${id}"]`)?.remove();
  }
}).catch(() => {});

// ---- System
let sys = null;
function render() {
  $('#sys-gpu').checked = sys.hardwareAcceleration;
  $('#sys-restart').hidden = !sys.restart;
  $('#sys-proxy-row').hidden = !sys.proxy;
}
const set = async (key, value) => { sys = await page.invoke('page:set-system', key, value); render(); };
$('#sys-gpu').addEventListener('change', (e) => set('hardwareAcceleration', e.target.checked));
$('#sys-relaunch').addEventListener('click', () => page.invoke('page:relaunch'));
$('#sys-proxy').addEventListener('click', () => page.invoke('page:open-proxy-settings'));
page.invoke('page:system').then((state) => { sys = state; render(); }).catch(() => {});

// ---- Reset settings: asks first, with what changes and what stays.
const RESET_DONE = 'lumio-settings-reset';
const dialog = $('#reset-dialog');
$('#reset-open').addEventListener('click', () => { dialog.showModal(); $('#reset-cancel').focus(); });
$('#reset-cancel').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); }); // the dimmed backdrop
dialog.addEventListener('close', () => $('#reset-open').focus());
$('#reset-go').addEventListener('click', async () => {
  $('#reset-go').disabled = true;
  const ok = await page.invoke('page:reset-settings').catch(() => false);
  $('#reset-go').disabled = false;
  if (!ok) { $('#reset-status').textContent = 'Couldn’t reset your settings. Try again.'; dialog.close(); return; }
  // Every section shows its new values after a reload; this one says what happened.
  try { sessionStorage.setItem(RESET_DONE, '1'); } catch { /* the reload just won't say so */ }
  location.hash = '#reset';
  location.reload();
});
try {
  if (sessionStorage.getItem(RESET_DONE)) {
    sessionStorage.removeItem(RESET_DONE);
    $('#reset-status').textContent = 'Your settings were reset. Your bookmarks, history and saved passwords stayed.';
  }
} catch { /* no storage */ }
