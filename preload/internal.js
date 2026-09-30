// Preload for tab pages. It runs in an isolated world, so websites can't see
// or call anything here.
//  - Lumio's own lumio:// pages get a small bridge; normal websites see nothing.
//    The main process re-checks the sender's URL and host.
//  - On http(s) pages it helps with passwords: it notices sign-ins the person
//    typed, shows saved accounts when they click a sign-in field, and fills
//    only what they pick in Lumio's own dropdown. Passwords are never exposed
//    to the page before that choice.
const { contextBridge, ipcRenderer } = require('electron');

if (window.location.protocol === 'lumio:') {
  contextBridge.exposeInMainWorld('lumioPage', {
    invoke: (channel, ...args) => (/^page:/.test(channel) ? ipcRenderer.invoke(channel, ...args) : Promise.reject(new Error('blocked'))),
  });
}

if (/^https?:$/.test(window.location.protocol) && window === window.top) passwordHelper();

function passwordHelper() {
  const typed = new WeakSet(); // fields the person typed into, or Lumio filled
  let lastSent = 0;
  let activeField = null;
  let shown = false;

  const isInput = (el) => el instanceof HTMLInputElement;
  const isPassword = (el) => isInput(el) && el.type === 'password';
  const isText = (el) => isInput(el) && /^(text|email|tel|search|)$/i.test(el.getAttribute('type') || 'text');
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== 'hidden';
  };
  const scopeOf = (el) => el?.form || el?.closest?.('form') || document;
  const passwordsIn = (scope) => [...scope.querySelectorAll('input[type=password]')].filter(visible);
  const isNewPassword = (el) => /new-password/i.test(el.autocomplete || '');

  function usernameFor(scope, anchor) {
    const inputs = [...scope.querySelectorAll('input')].filter((el) => isText(el) && visible(el));
    const hinted = inputs.find((el) => /username|email/i.test(el.autocomplete || ''));
    if (hinted) return hinted;
    if (!anchor) return inputs[0] || null;
    const before = inputs.filter((el) => el.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING);
    return before[before.length - 1] || null;
  }

  document.addEventListener('input', (e) => { if (e.isTrusted && isInput(e.target)) typed.add(e.target); }, true);

  // ---- noticing a sign-in ----
  function capture(scope) {
    const filled = passwordsIn(scope).filter((p) => p.value && typed.has(p));
    if (!filled.length) return;
    const now = Date.now();
    if (now - lastSent < 1500) return;
    lastSent = now;
    // Sign-up and change-password forms: save the new password.
    const fresh = filled.find(isNewPassword) || (filled.length >= 2 ? filled[filled.length - 1] : null);
    const password = (fresh || filled[0]).value;
    const username = (usernameFor(scope, filled[0])?.value || '').trim();
    if (password.length > 512 || username.length > 300) return;
    ipcRenderer.send('pw:captured', { username, password, isNew: !!fresh });
  }
  document.addEventListener('submit', (e) => capture(e.target), true);
  // Sign-ins that don't use a real form submit: a button click, or Enter.
  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const btn = e.target.closest?.('button, input[type=submit], input[type=button], [role=button]');
    if (!btn) return;
    const scope = scopeOf(btn);
    if (passwordsIn(scope).some((p) => p.value)) setTimeout(() => capture(scope), 0);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.isTrusted && e.key === 'Enter' && isPassword(e.target)) capture(scopeOf(e.target));
  }, true);

  // ---- suggestions ----
  function loginField(el) {
    if (!isInput(el) || el.disabled || el.readOnly || !visible(el)) return false;
    if (isPassword(el)) return true;
    return isText(el) && passwordsIn(scopeOf(el)).length > 0;
  }
  function signUpForm(el) {
    const pws = passwordsIn(scopeOf(el));
    return isNewPassword(el) || pws.some(isNewPassword) || pws.length >= 2;
  }
  async function suggest(el) {
    const wantsNew = isPassword(el) && signUpForm(el);
    const res = await ipcRenderer.invoke('pw:query', { newPassword: wantsNew }).catch(() => null);
    if (!res || (!res.accounts && !res.generate)) return;
    activeField = el;
    const r = el.getBoundingClientRect();
    shown = true;
    ipcRenderer.send('pw:show', { x: r.left, y: r.bottom, width: r.width });
  }
  function hide() {
    if (!shown) return;
    shown = false;
    ipcRenderer.send('pw:hide');
  }
  document.addEventListener('click', (e) => { if (e.isTrusted && loginField(e.target)) suggest(e.target); }, true);
  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted) return;
    if (e.key === 'ArrowDown' && loginField(e.target) && !shown) suggest(e.target);
    else if (e.key === 'Escape' || (e.key.length === 1 && shown)) hide();
  }, true);
  document.addEventListener('focusout', () => setTimeout(() => { if (document.activeElement !== activeField) hide(); }, 250), true);
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
  window.addEventListener('pagehide', hide);

  // ---- filling what the person picked ----
  const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  function setValue(input, value) {
    input.focus();
    nativeValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    typed.add(input);
  }
  ipcRenderer.on('pw:fill', (_e, { username, password, generated }) => {
    shown = false;
    const anchor = activeField && document.contains(activeField) ? activeField : document.activeElement;
    const scope = scopeOf(anchor);
    const pws = passwordsIn(scope);
    if (generated) {
      // New password + confirm; on a change form, skip the current-password field.
      const targets = pws.length >= 3 ? pws.slice(1) : pws.filter((p) => !p.value || isNewPassword(p) || pws.length === 2);
      (targets.length ? targets : [anchor]).forEach((p) => isPassword(p) && setValue(p, password));
      return;
    }
    const user = usernameFor(scope, pws[0] || anchor);
    if (user && username) setValue(user, username);
    if (pws[0]) setValue(pws[0], password);
  });
}
