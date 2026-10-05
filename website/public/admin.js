// The owner's Spend page: what OpenRouter charged on Lumio's key, next to what
// Lumio counted for its users (GET /api/admin/spend). Only the owner's account
// gets data; everyone else sees a short note.
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NOTE = 'Days, weeks and months are in UTC, like OpenRouter (weeks start on Monday). OpenRouter’s numbers cover everything billed to Lumio’s key.';
const money = (n) => (n == null ? '—' : `$${Math.abs(n) < 1 && n !== 0 ? n.toFixed(4) : n.toFixed(2)}`);

function status(text, cls = '') {
  const s = $('#status');
  s.hidden = !text;
  s.className = `notice ${cls}`;
  s.innerHTML = text || '';
}

// Close enough: within 2% or half a cent (OpenRouter rounds and updates a moment later).
function compare(charged, counted) {
  if (charged == null) return { cls: '', text: 'OpenRouter didn’t answer' };
  const diff = charged - counted;
  if (Math.abs(diff) <= Math.max(0.005, charged * 0.02)) return { cls: 'ok', text: 'Matches' };
  return diff > 0
    ? { cls: 'warn', text: `OpenRouter is ${money(diff)} higher`, why: 'Something else may use the same key, or calls failed before Lumio could record them.' }
    : { cls: 'warn', text: `Lumio counted ${money(-diff)} more`, why: 'Usually calls that are still finishing; it evens out within a few minutes.' };
}

function card(label, charged, l) {
  const c = compare(charged, l.total);
  return `<article class="spend-card">
    <div class="label">${esc(label)}</div>
    <div class="big">${money(charged)}</div>
    <div class="dim">charged by OpenRouter</div>
    <div class="counted">Lumio counted <b>${money(l.total)}</b><span>Free ${money(l.free)} · Paid ${money(l.paid)}</span></div>
    <div class="match ${c.cls}"${c.why ? ` title="${esc(c.why)}"` : ''}>${esc(c.text)}</div>
  </article>`;
}

function render(d) {
  const or = d.openrouter;
  $('#cards').hidden = false;
  $('#cards').innerHTML = card('Today', or?.today, d.lumio.today) + card('This week', or?.week, d.lumio.week) + card('This month', or?.month, d.lumio.month);

  const m = d.lumio.month;
  $('#month').hidden = false;
  $('#month-split').innerHTML = [
    ['Browser', money(m.byKind.browser)], ['Chat', money(m.byKind.chat)], ['Pictures', money(m.byKind.image)], ['Voice', money(m.byKind.voice || 0)],
    ['Free users', money(m.free)], ['Paying users', money(m.paid)], ['AI calls', m.calls.toLocaleString()],
  ].map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
  $('#checked').textContent = `${m.checked.toLocaleString()} of ${m.calls.toLocaleString()} calls this month matched to OpenRouter’s records${d.waitingForCheck ? `, ${d.waitingForCheck} waiting for OpenRouter to record them` : ''}. Each call is checked seconds after it ends.`;

  const p = d.people || {};
  const aiMonth = or?.month ?? m.total;
  $('#money').hidden = false;
  $('#money-split').innerHTML = [
    ['Free', (p.free || 0).toLocaleString()], ['Go', (p.go || 0).toLocaleString()], ['Plus', (p.plus || 0).toLocaleString()], ['Pro', (p.pro || 0).toLocaleString()], ['Max', (p.max || 0).toLocaleString()],
    ['Revenue a month', money(d.monthlyRevenue)], ['AI cost this month', money(aiMonth)],
  ].map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');

  const c = d.cancellations || { last30Days: [], recent: [] };
  const most = Math.max(1, ...c.last30Days.map((r) => r.n));
  $('#why').hidden = false;
  $('#why-list').innerHTML = c.last30Days.length
    ? `<p class="fine first">Last 30 days</p>${c.last30Days.map((r) => `<div class="meter why-row"><div class="row"><span>${esc(r.label)}</span><span>${r.n}</span></div><div class="bar"><i style="width:${Math.round((r.n / most) * 100)}%"></i></div></div>`).join('')}`
    : '<p class="fine first">No cancellations in the last 30 days.</p>';
  $('#why-recent').innerHTML = c.recent.some((r) => r.comment)
    ? `<p class="fine">What they wrote</p>${c.recent.filter((r) => r.comment).map((r) => `<blockquote class="why-quote">“${esc(r.comment)}”<span>${esc(r.label)} · Lumio ${esc(r.plan[0].toUpperCase() + r.plan.slice(1))} · ${esc(new Date(r.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</span></blockquote>`).join('')}`
    : '';

  const cap = d.freeCap;
  $('#cap').hidden = false;
  $('#cap-label').textContent = `${money(cap.usedToday)} of ${money(cap.cap)} used`;
  $('#cap-left').textContent = `${money(Math.max(0, cap.cap - cap.usedToday))} left`;
  $('#cap-bar').style.width = `${Math.min(100, (cap.usedToday / cap.cap) * 100)}%`;

  $('#note').hidden = false;
  $('#note').textContent = NOTE + (or?.limitRemaining != null ? ` The key’s own limit has ${money(or.limitRemaining)} left.` : '');
  $('#updated').innerHTML = `<span class="live" aria-hidden="true"></span>Live · updated ${esc(new Date(d.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }))}`;
  status(d.openrouterError ? esc(d.openrouterError) : '', d.openrouterError ? 'err' : '');
}

// ---- plan codes
const short = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
async function loadCodes() {
  const res = await fetch('/api/admin/codes', { cache: 'no-store' }).catch(() => null);
  if (!res?.ok) return;
  const { codes } = await res.json();
  $('#codes').hidden = false;
  $('#code-rows').innerHTML = codes.length ? codes.map((c) => `<div class="code-row">
      <span>${esc(c.planName)}</span><span class="hint">…${esc(c.hint)}</span>
      <span class="grow">made ${esc(short(c.createdAt))}</span>
      ${c.usedAt ? `<span class="used">${esc(c.usedBy || 'someone')} · until ${esc(short(c.until))}</span>` : '<span>not used yet</span>'}
    </div>`).join('') : '<p class="fine">No codes yet.</p>';
}
$('#code-make').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#code-go').disabled = true;
  try {
    const res = await fetch('/api/admin/codes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan: $('#code-plan').value, count: Number($('#code-count').value) || 1 }) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || 'Couldn’t make codes.');
    $('#code-new').innerHTML = `<p class="fine first">New ${esc(d.planName)} codes (a month each). Copy them now:</p>` + d.codes.map((c) => `<div class="code"><b>${esc(c)}</b><button class="btn small" type="button" data-copy="${esc(c)}">Copy</button></div>`).join('');
    await loadCodes();
  } catch (err) {
    $('#code-new').innerHTML = `<p class="fine" style="color:var(--warn)">${esc(err.message)}</p>`;
  } finally {
    $('#code-go').disabled = false;
  }
});
$('#code-new').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  await navigator.clipboard.writeText(b.dataset.copy).catch(() => {});
  b.textContent = 'Copied';
  setTimeout(() => { b.textContent = 'Copy'; }, 1500);
});

// ---- crashes (from people who turned on crash reports in Lumio Browser)
const OS = { darwin: 'Mac', win32: 'Windows', linux: 'Linux' };
const when = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
async function loadCrashes() {
  const res = await fetch('/api/admin/crashes', { cache: 'no-store' }).catch(() => null);
  if (!res?.ok) return;
  const d = await res.json();
  const t = d.totals;
  $('#crashes').hidden = false;
  $('#crash-sum').textContent = t.reports
    ? `${t.reports.toLocaleString()} report${t.reports === 1 ? '' : 's'} in the last ${d.days} days, ${t.last24h.toLocaleString()} in the last 24 hours, ${t.dumps.toLocaleString()} with a minidump. Only from people who turned on crash reports.`
    : `No crash reports in the last ${d.days} days. Only people who turned on crash reports in Lumio Browser send them.`;
  $('#crash-groups').innerHTML = d.groups.length ? `<table class="crash-table">
    <thead><tr><th scope="col">Reports</th><th scope="col">Crash</th><th scope="col">Version</th><th scope="col">Where</th><th scope="col">Last seen</th></tr></thead>
    <tbody>${d.groups.map((g) => `<tr>
      <td class="n">${g.count.toLocaleString()}</td>
      <td><code>${esc(g.signature)}</code><span>${esc(g.process || 'unknown process')}${g.dumps ? ` · ${g.dumps} dump${g.dumps === 1 ? '' : 's'}` : ''}</span></td>
      <td>${esc(g.version || '—')}${g.channels.length ? `<span>${esc(g.channels.join(', '))}</span>` : ''}</td>
      <td>${esc(g.platforms.map((p) => OS[p] || p).join(', ') || '—')}</td>
      <td>${esc(when(g.lastAt))}</td>
    </tr>`).join('')}</tbody></table>` : '';
  $('#crash-latest-title').hidden = !d.recent.length;
  $('#crash-list').innerHTML = d.recent.map((c) => `<details class="crash-item">
      <summary><span class="when">${esc(when(c.at))}</span><code>${esc(c.signature)}</code>
        <span class="meta">${esc([c.version, [OS[c.platform] || c.platform, c.arch].filter(Boolean).join(' '), c.channel, c.process, c.reason].filter(Boolean).join(' · '))}</span></summary>
      ${c.message ? `<p>${esc(c.message)}</p>` : ''}
      ${c.stack ? `<pre>${esc(c.stack)}</pre>` : ''}
      ${c.dump ? `<a class="btn small" href="${esc(c.dump)}" download>Download minidump</a>` : ''}
      ${!c.message && !c.stack && !c.dump ? '<p>No more details.</p>' : ''}
    </details>`).join('');
}

let loading = false;
let codesLoaded = false;
async function load() {
  if (loading) return;
  loading = true;
  $('#refresh').disabled = true;
  try {
    const res = await fetch('/api/admin/spend', { cache: 'no-store' });
    if (res.status === 401) { status('Sign in with the Lumio owner account to see this page. <a href="/signin?next=/admin">Sign in</a>'); return; }
    if (!res.ok) { status('This page is only for the owner of Lumio.'); return; }
    render(await res.json());
    if (!codesLoaded) { codesLoaded = true; loadCodes(); loadCrashes(); }
  } catch {
    status('Couldn’t load the numbers. Check your connection and try again.', 'err');
  } finally {
    loading = false;
    $('#refresh').disabled = false;
  }
}

// Live: every AI call is matched to OpenRouter's record seconds after it ends,
// so the page refreshes every 15 seconds while it's open (and right away when
// you come back to the tab).
$('#refresh').addEventListener('click', load);
$('#refresh').addEventListener('click', () => { if (codesLoaded) loadCrashes(); }); // crashes change slowly: only when asked
setInterval(() => { if (!document.hidden) load(); }, 15_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
load();
