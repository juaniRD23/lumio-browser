// First run: welcome → Keychain (Mac) → import from another browser → done.
import './keys.js';
const page = window.lumioPage;
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (x) => Number(x || 0).toLocaleString();

$('#mark').innerHTML = '<svg viewBox="0 0 64 64"><path d="M35 12a21 21 0 1 0 17 19" fill="none" stroke="#ededee" stroke-width="7" stroke-linecap="round"/><circle cx="48" cy="17" r="5" fill="#86b7ff"/></svg>';

const state = await page.invoke('page:welcome-state');
const mac = state.platform === 'darwin';
const steps = ['hello', ...(mac ? ['keychain'] : []), 'import', 'done'];
let at = 0;

function show(i) {
  at = Math.max(0, Math.min(steps.length - 1, i));
  document.querySelectorAll('.step').forEach((s) => { s.hidden = s.dataset.step !== steps[at]; });
  $('#dots').innerHTML = steps.map((_, k) => `<i class="${k === at ? 'on' : k < at ? 'done' : ''}"></i>`).join('');
  window.scrollTo(0, 0);
}
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-next]')) show(at + 1);
  if (e.target.closest('[data-back]')) show(at - 1);
});
show(0);

// ------------------------------------------------------------ Keychain
let keychainOk = false;
$('#kc-go').addEventListener('click', async () => {
  if (keychainOk) { show(at + 1); return; }
  const msg = $('#kc-msg');
  const go = $('#kc-go');
  go.disabled = true;
  msg.className = 'note';
  msg.textContent = 'Waiting for macOS… type your Mac password and click Always Allow.';
  const res = await page.invoke('page:keychain-check').catch(() => ({ ok: false }));
  go.disabled = false;
  if (res.ok) {
    keychainOk = true;
    msg.className = 'note ok';
    msg.textContent = '✓ All set. Your passwords are protected.';
    go.textContent = 'Continue';
    setTimeout(() => { if (steps[at] === 'keychain') show(at + 1); }, 900);
  } else {
    msg.className = 'note bad';
    msg.textContent = 'macOS didn’t allow it, so Lumio can’t save passwords yet. Try again and click Always Allow.';
    go.textContent = 'Try again';
    $('#kc-skip').hidden = false;
  }
});
$('#kc-skip').addEventListener('click', () => show(at + 1));

// ------------------------------------------------------------ Import
const LOOK = { chrome: ['#1A73E8', 'C'], edge: ['#0C8BD8', 'E'], brave: ['#FB542B', 'B'], arc: ['#E2477B', 'A'], vivaldi: ['#EF3939', 'V'], chromium: ['#4A7FE0', 'C'], safari: ['#1B8CF2', 'S'] };
const sources = state.sources || [];
let chosen = sources[0]?.id || null;
function renderSources() {
  $('#sources').innerHTML = sources.length ? sources.map((s) => {
    const [bg, letter] = LOOK[s.id] || ['#555', s.name[0]];
    return `<label class="src ${s.id === chosen ? 'on' : ''}"><input type="radio" name="src" value="${esc(s.id)}" ${s.id === chosen ? 'checked' : ''}><span class="logo" style="background:${bg}">${letter}</span><b>${esc(s.name)}</b></label>`;
  }).join('') : '<div class="empty-src">No other browsers found on this computer. You can still import files below.</div>';
  const src = sources.find((s) => s.id === chosen);
  $('#opts').innerHTML = src ? `
    <label><input type="checkbox" id="o-bm" checked> Bookmarks</label>
    <label><input type="checkbox" id="o-hist" checked> History</label>
    ${src.passwords ? '<label><input type="checkbox" id="o-pw" checked> Passwords</label>' : src.id === 'safari' ? '<span class="soon">Passwords: export from Safari (see below)</span>' : '<span class="soon">Passwords: export a CSV (see below)</span>'}` : '';
  $('#imp-go').hidden = !src;
  $('#safari-tip').hidden = !sources.some((s) => s.id === 'safari');
  $('#access').hidden = true;
  updateNote();
}
function updateNote() {
  const src = sources.find((s) => s.id === chosen);
  $('#imp-note').className = 'note';
  $('#imp-note').textContent = src?.passwords && $('#o-pw')?.checked
    ? `macOS will ask to let Lumio read ${src.name}’s passwords: type your Mac password and click Allow.`
    : '';
}
$('#sources').addEventListener('change', (e) => { if (e.target.name === 'src') { chosen = e.target.value; renderSources(); } });
$('#opts').addEventListener('change', updateNote);
renderSources();

function showResult(r) {
  const parts = [];
  if (r.bookmarks) parts.push(`${n(r.bookmarks)} bookmark${r.bookmarks === 1 ? '' : 's'}`);
  if (r.history) parts.push(`${n(r.history)} history item${r.history === 1 ? '' : 's'}`);
  const pw = r.passwords ? r.passwords.added + r.passwords.updated : 0;
  if (pw) parts.push(`${n(pw)} password${pw === 1 ? '' : 's'}`);
  const box = $('#result');
  box.hidden = false;
  box.innerHTML = `${parts.length ? `✓ Imported ${esc(parts.join(', '))}.` : '✓ Done. Nothing new to import.'}${r.passwordError ? `<span class="err">${esc(r.passwordError)}</span>` : ''}`;
}

async function runImport() {
  const src = sources.find((s) => s.id === chosen);
  if (!src) return;
  const go = $('#imp-go');
  go.disabled = true;
  go.textContent = 'Importing…';
  $('#result').hidden = true;
  $('#access').hidden = true;
  const res = await page.invoke('page:import', src.id, {
    bookmarks: !!$('#o-bm')?.checked, history: !!$('#o-hist')?.checked, passwords: !!$('#o-pw')?.checked,
  }).catch((err) => ({ ok: false, error: err.message }));
  go.disabled = false;
  go.textContent = 'Import';
  if (res.needsAccess) { $('#access').hidden = false; return; }
  if (!res.ok) { $('#imp-note').className = 'note bad'; $('#imp-note').textContent = res.error || 'Couldn’t import.'; return; }
  showResult(res);
  $('#imp-note').textContent = '';
  go.textContent = 'Continue';
  go.onclick = () => show(at + 1);
  $('#imp-skip').hidden = true;
}
$('#imp-go').onclick = runImport;
$('#retry').addEventListener('click', runImport);
$('#open-access').addEventListener('click', () => page.invoke('page:open-disk-access'));
document.querySelectorAll('[data-file]').forEach((b) => b.addEventListener('click', async () => {
  const res = await page.invoke('page:import-file', b.dataset.file);
  if (res.canceled) return;
  if (!res.ok) { $('#imp-note').className = 'note bad'; $('#imp-note').textContent = res.error || 'Couldn’t import that file.'; return; }
  showResult(res);
}));

// ------------------------------------------------------------ Done
$('#default').addEventListener('click', async () => { await page.invoke('page:make-default'); $('#default').textContent = 'Done ✓'; $('#default').disabled = true; });
$('#sign-in').addEventListener('click', () => page.invoke('page:account-sign-in'));
if (state.account?.signedIn) { $('#sign-in').textContent = 'Signed in ✓'; $('#sign-in').disabled = true; }
$('#finish').addEventListener('click', () => page.invoke('page:welcome-done'));
