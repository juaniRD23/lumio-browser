// Lumio's warning pages (lumio://interstitial): a site on Safe Browsing's
// lists, an http site when "Always use secure connections" is on, a site
// that looks like another one, and a secure page sending a form over http.
// What the warning is about comes from the browser (main/navigation-guard.js),
// which also does what the buttons ask.
import './keys.js';

const page = window.lumioPage;
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const svg = (d) => `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  danger: svg('<path d="M12 3.5l7 3v5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9v-5z"/><path d="M12 8.5v4.5M12 16h.01"/>'),
  open: svg('<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 7.5-1.9"/><path d="M12 14.5v2"/>'),
  look: svg('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2M11 8.5v3M11 14h.01"/>'),
};

// Each warning: its words and its buttons. The primary button is the safe choice.
function content(info) {
  const host = `<b class="host">${esc(info.host)}</b>`;
  if (info.type === 'unsafe') {
    const malware = info.threat === 'malware';
    return {
      title: 'Dangerous site', icon: ICONS.danger, alarm: true,
      lead: malware
        ? `Attackers on ${host} might try to install dangerous programs on your computer that steal or delete your information, like photos, passwords, messages and credit cards.`
        : `Attackers on ${host} might trick you into doing something dangerous, like installing software or revealing your personal information, like passwords, phone numbers or credit cards.`,
      acts: [['details', 'Details', false], ['back', 'Back to safety', true]],
      details: `<p>Lumio found ${host} on a public list of ${malware ? 'sites that spread harmful programs' : 'sites that steal personal information'}. Lumio downloads these lists and checks them on this computer, so the sites you visit aren’t sent anywhere.</p>
        <p>If you understand the risks to your security, you may <button class="link" data-act="proceed">visit this unsafe site</button>.</p>`,
    };
  }
  if (info.type === 'https') {
    return {
      title: 'Connection is not secure', icon: ICONS.open,
      lead: `Attackers can see and change information you send or receive from ${host}. This site doesn’t support a secure connection.`,
      more: 'You’re seeing this because Always use secure connections is on in <a href="lumio://settings/security">Settings › Security</a>.',
      acts: [['proceed', 'Continue to site', false], ['back', 'Go back', true]],
    };
  }
  if (info.type === 'lookalike') {
    const suggested = `<b class="host">${esc(info.suggested)}</b>`;
    return {
      title: `Did you mean ${info.suggested}?`, icon: ICONS.look,
      lead: `The site you just tried to visit, ${host}, looks fake. Attackers sometimes copy sites by making small, hard-to-see changes to the address.`,
      more: `If you got here from a link or an email, be careful: ${host} isn’t ${suggested}.`,
      acts: [['proceed', 'Ignore', false], ['suggested', `Go to ${info.suggested}`, true]],
    };
  }
  return {
    title: 'The information you’re about to submit is not secure', icon: ICONS.open,
    lead: `This form sends your information to ${host} over a connection that isn’t secure, so others could see it.`,
    acts: [['proceed', 'Send anyway', false], ['back', 'Go back', true]],
  };
}

function render(info) {
  const c = content(info);
  document.title = c.title;
  document.body.classList.toggle('alarm', !!c.alarm);
  $('#ico').innerHTML = c.icon;
  $('#title').textContent = c.title;
  $('#lead').innerHTML = c.lead;
  $('#more').hidden = !c.more;
  $('#more').innerHTML = c.more || '';
  $('#details').innerHTML = c.details || '';
  $('#acts').innerHTML = c.acts.map(([act, label, primary]) => `<button class="btn ${primary ? 'primary' : ''}" data-act="${act}"${act === 'details' ? ' aria-expanded="false" aria-controls="details"' : ''}>${esc(label)}</button>`).join('');
  $('#warn').removeAttribute('aria-busy');
  $('#acts .primary')?.focus();
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'details') {
    const open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(open));
    btn.textContent = open ? 'Hide details' : 'Details';
    $('#details').hidden = !open;
    return;
  }
  btn.disabled = true;
  page.invoke('page:interstitial-act', act).finally(() => { btn.disabled = false; });
});

const info = await page.invoke('page:interstitial');
if (info) render(info);
else {
  // Nothing to warn about anymore (the browser restarted without this page's details).
  render({ type: 'https', host: '' });
  $('#lead').textContent = 'Lumio can’t show this warning anymore. Go back and open the site again.';
  $('[data-act=proceed]')?.remove();
}
