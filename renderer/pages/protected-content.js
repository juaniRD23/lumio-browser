// Settings › Site settings › Protected content IDs, on DRM builds of Lumio
// (castlabs Electron, main/drm.js): sites like Netflix can play protected
// videos and music, and whether Google's Widevine module is ready. Stock
// builds can't play protected content, so nothing is added there and Settings
// looks exactly as before.
const page = window.lumioPage;

const STATES = {
  ready: (st) => (st.version ? `Ready · Widevine ${st.version}` : 'Ready.'),
  starting: () => 'Getting ready… Lumio is downloading Google’s Widevine module.',
  failed: () => 'Couldn’t get it ready. Lumio tries again the next time it opens.',
};

// Right under Site settings: its list, or the card that links to its own page.
function place(box) {
  const sites = document.getElementById('site-list') || document.getElementById('sites')?.closest('.card');
  if (sites) sites.after(box);
  else document.getElementById('privacy')?.append(box);
}

function build() {
  const el = (tag, props = {}) => Object.assign(document.createElement(tag), props);
  const box = el('div', { id: 'protected-content' });
  const card = el('div', { className: 'card' });
  const row = el('div', { className: 'row' });
  const grow = el('div', { className: 'grow' });
  const state = el('div', { className: 'desc', id: 'pc-state' });
  state.setAttribute('role', 'status');
  state.setAttribute('aria-live', 'polite');
  grow.append(
    el('div', { className: 'title', id: 'pc-title', textContent: 'Sites can play protected content' }),
    el('div', { className: 'desc', id: 'pc-desc', textContent: 'Sites like Netflix, Spotify and Disney+ can play protected videos and music. Lumio gets Google’s Widevine module for this, the same one Chrome uses.' }),
    state,
  );
  row.append(grow);
  card.append(row);
  card.setAttribute('role', 'group');
  card.setAttribute('aria-labelledby', 'pc-title');
  card.setAttribute('aria-describedby', 'pc-desc pc-state');
  box.append(el('h3', { id: 'protected', textContent: 'Protected content IDs' }), card);
  place(box);
  return state;
}

async function show() {
  const st = await page.invoke('page:protected-content').catch(() => null);
  if (!st?.available) return;
  const state = document.getElementById('pc-state') || build();
  state.textContent = (STATES[st.state] || STATES.starting)(st);
  // Still downloading: look again in a bit, so the line changes by itself.
  if (st.state === 'starting') setTimeout(show, 3000);
}

if (page) show();
