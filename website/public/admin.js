// The owner's Spend page: what OpenRouter charged on Lumio's key, next to what
// Lumio counted for its users (GET /api/admin/spend). Only the owner's account
// gets data; everyone else sees a short note.
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
    ['Browser', money(m.byKind.browser)], ['Chat', money(m.byKind.chat)], ['Pictures', money(m.byKind.image)],
    ['Free users', money(m.free)], ['Paying users', money(m.paid)], ['AI calls', m.calls.toLocaleString()],
  ].map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
  $('#checked').textContent = `${m.checked.toLocaleString()} of ${m.calls.toLocaleString()} calls this month matched to OpenRouter’s records${d.waitingForCheck ? `, ${d.waitingForCheck} waiting (checked every 5 minutes)` : ''}.`;

  const p = d.people || {};
  const aiMonth = or?.month ?? m.total;
  $('#money').hidden = false;
  $('#money-split').innerHTML = [
    ['Free', (p.free || 0).toLocaleString()], ['Plus', (p.plus || 0).toLocaleString()], ['Pro', (p.pro || 0).toLocaleString()], ['Max', (p.max || 0).toLocaleString()],
    ['Revenue a month', money(d.monthlyRevenue)], ['AI cost this month', money(aiMonth)],
  ].map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');

  const cap = d.freeCap;
  $('#cap').hidden = false;
  $('#cap-label').textContent = `${money(cap.usedToday)} of ${money(cap.cap)} used`;
  $('#cap-left').textContent = `${money(Math.max(0, cap.cap - cap.usedToday))} left`;
  $('#cap-bar').style.width = `${Math.min(100, (cap.usedToday / cap.cap) * 100)}%`;

  $('#note').hidden = false;
  if (or?.limitRemaining != null) $('#note').textContent += ` The key’s own limit has ${money(or.limitRemaining)} left.`;
  $('#updated').textContent = `Updated ${new Date(d.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.`;
  status(d.openrouterError ? esc(d.openrouterError) : '', d.openrouterError ? 'err' : '');
}

async function load() {
  $('#refresh').disabled = true;
  try {
    const res = await fetch('/api/admin/spend', { cache: 'no-store' });
    if (res.status === 401) { status('Sign in with the Lumio owner account to see this page. <a href="/signin?next=/admin">Sign in</a>'); return; }
    if (!res.ok) { status('This page is only for the owner of Lumio.'); return; }
    render(await res.json());
  } catch {
    status('Couldn’t load the numbers. Check your connection and try again.', 'err');
  } finally {
    $('#refresh').disabled = false;
  }
}

$('#refresh').addEventListener('click', load);
setInterval(() => { if (!document.hidden) load(); }, 120_000);
load();
