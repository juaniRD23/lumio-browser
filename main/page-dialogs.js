// What a page can ask you in its tab, as Lumio's own tab-modal card
// (main/dialog-view.js draws it, TabManager.ask queues it):
//  - alert(), confirm() and prompt(): Electron only has app-wide message
//    boxes for the first two and no prompt() at all. preload/internal.js
//    replaces them in the page with a synchronous message to Lumio, so the
//    page waits for the answer like it does in Chrome. The title names the
//    site, and from the second dialog in a row you can stop that site from
//    showing more.
//  - HTTP sign-in (Basic/Digest, and proxies): "Sign in to access this site".
//    The password goes straight to the network request; it's never kept,
//    saved or logged.
//  - "Leave site?" and "Page unresponsive" are built in main/tabs.js.

const STREAK_MS = 10_000; // dialogs closer together than this are "in a row"
const MAX_TEXT = 10_000;

const text = (v) => String(v ?? '').slice(0, MAX_TEXT);
const originOf = (url) => { try { const o = new URL(url).origin; return o === 'null' ? String(url || '') : o; } catch { return String(url || ''); } };
// "example.com" for a web page; null when there's no site to name (a file).
const hostOf = (url) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.host : null; } catch { return null; } };
const ownPage = (url) => /^lumio:/i.test(String(url || '')); // Settings, Passwords…

// What a dialog the person can't see (a blocked site, a helper's tab) returns.
const blankAnswer = (kind) => (kind === 'confirm' ? false : null);

function jsDialogSpec({ kind, message, value = '', url, offerBlock = false }) {
  const host = hostOf(url);
  const spec = {
    kind: 'js',
    title: ownPage(url) ? 'Lumio Browser' : host ? `${host} says` : 'This page says',
    message: text(message),
    buttons: kind === 'alert' ? [{ id: 'ok', label: 'OK', primary: true }] : [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'OK', primary: true }],
    cancel: kind === 'alert' ? 'ok' : 'cancel',
  };
  if (kind === 'prompt') spec.fields = [{ name: 'value', type: 'text', label: '', value: text(value) }];
  if (offerBlock) spec.checkbox = { label: `Don't allow ${host || 'this page'} to show more dialogs` };
  return spec;
}

// What alert(), confirm() or prompt() returns for the person's answer.
function jsResult(kind, answer) {
  if (kind === 'confirm') return answer.button === 'ok';
  if (kind === 'prompt') return answer.button === 'ok' ? String(answer.values?.value ?? '') : null;
  return null;
}

// Dialogs from the same site, one after another.
function nextStreak(prev, origin, now) {
  if (prev && prev.origin === origin && now - prev.at < STREAK_MS) return { origin, count: prev.count + 1, at: now };
  return { origin, count: 1, at: now };
}

// A page's alert(), confirm() or prompt(), asked in its tab. Resolves with
// what the page's call returns.
async function jsDialog(tab, { kind, message, value, url }) {
  const origin = originOf(url);
  // A helper AI's tab has nobody to answer; a site you blocked gets no more.
  if (tab.agent || tab.dialogsBlocked?.has(origin)) return blankAnswer(kind);
  tab.dialogStreak = nextStreak(tab.dialogStreak, origin, Date.now());
  const offerBlock = tab.dialogStreak.count >= 2 && !ownPage(url);
  const answer = await tab.owner.ask(tab, jsDialogSpec({ kind, message, value, url, offerBlock }));
  tab.dialogStreak = { ...tab.dialogStreak, at: Date.now() };
  if (answer.checked) (tab.dialogsBlocked ||= new Set()).add(origin);
  return jsResult(kind, answer);
}

function authSpec({ url, isProxy, host, port, retry = false }) {
  const u = (() => { try { return new URL(url); } catch { return null; } })();
  const spec = {
    kind: 'auth',
    title: isProxy ? 'Sign in to the proxy' : 'Sign in to access this site',
    message: isProxy ? `The proxy ${host}:${port} requires a username and password.` : `Authorization required by ${u ? u.origin : host}`,
    fields: [
      { name: 'username', type: 'text', label: 'Username', value: '', autocomplete: 'username' },
      { name: 'password', type: 'password', label: 'Password', value: '', autocomplete: 'current-password' },
    ],
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'signin', label: 'Sign in', primary: true }],
    cancel: 'cancel',
  };
  if (!isProxy && u?.protocol === 'http:') spec.note = 'Your connection to this site is not private';
  if (retry) spec.error = "That username and password didn't work. Try again.";
  return spec;
}

// Whose sign-in requests get a dialog: your proxy; the site the tab is on or
// going to. Anything else on the page (an ad frame, an image from another
// site) is refused, so it can't pose as the site you're on.
function authAllowed({ requestUrl, isProxy, pageUrl, goingTo }) {
  if (isProxy) return true;
  const origin = originOf(requestUrl);
  return !!origin && [pageUrl, goingTo].some((u) => u && /^https?:/i.test(u) && originOf(u) === origin);
}

// HTTP sign-in for a tab. Resolves with { username, password }, or null to
// cancel (the page then shows the site's own "401" page).
async function signIn(tab, { details, authInfo }) {
  if (tab.agent) return null;
  const allowed = authAllowed({ requestUrl: details.url, isProxy: authInfo.isProxy, pageUrl: tab.view?.webContents.getURL(), goingTo: tab.navigatingTo });
  if (!allowed) return null;
  const answer = await tab.owner.ask(tab, authSpec({ url: details.url, isProxy: authInfo.isProxy, host: authInfo.host, port: authInfo.port, retry: details.firstAuthAttempt === false }));
  if (answer.button !== 'signin') return null;
  return { username: answer.values.username, password: answer.values.password };
}

module.exports = { jsDialogSpec, jsResult, nextStreak, jsDialog, blankAnswer, authSpec, authAllowed, signIn, STREAK_MS };
