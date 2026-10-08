// Lumio account: the same account as lumio-co.online. Signing in happens on
// the website itself, in a normal Lumio Browser tab: the person logs in the way
// they usually do (Google, email). When the site's session cookie shows up in
// the browser's normal profile (main.js watches for it), we check that session
// with /api/account and keep it as the account's token, stored encrypted with
// safeStorage. Profile, plan and the Lumio AI allowance come from the same
// server (server/ in this repo), which also runs the AI.
// The Lumio server (server/ in this repo). It lives at lumio-co.online. Older
// builds use lumio.gw607953.workers.dev, which keeps working (same Worker and
// database), so a saved session carries over.
const BASE = (process.env.LUMIO_ACCOUNT_BASE || 'https://lumio-co.online').replace(/\/$/, '');
const AI_BASE = (process.env.LUMIO_AI_BASE || BASE).replace(/\/$/, '');
const SECRET = 'lumio-session';
const SIGN_IN_MS = 15 * 60 * 1000;

class LumioAccount {
  constructor({ store, onChange, fetchImpl = globalThis.fetch }) {
    this.store = store;
    this.onChange = onChange;
    this.fetch = fetchImpl;
    this.pending = null; // { expiresAt } while waiting for the person to log in on the website
    this.info = null; // { email, name, username, publicUsername }
    this.usage = null; // { plan, planName, used, remaining, limit, fullAt, windows } (Lumio AI allowance)
    this.error = null;
    this.timer = null;
  }

  get base() { return BASE; }
  get aiBase() { return AI_BASE; }
  // The website's session cookie: __Host- prefixed on https (the real site).
  get cookieName() { return BASE.startsWith('https:') ? '__Host-lumio_session' : 'lumio_session'; }
  get host() { return new URL(BASE).hostname; }
  url(path = '/') { return BASE + path; }
  token() { return this.store.getSecret(SECRET); }
  cookie(token = this.token()) { return `${this.cookieName}=${token}`; }

  async api(path, { method = 'GET', body, token = this.token() } = {}) {
    const res = await this.fetch(BASE + path, {
      method,
      headers: {
        ...(token ? { Cookie: this.cookie(token) } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, ok: res.ok, data };
  }

  // The AI routes (/v1), with the session as a bearer token.
  async ai(path) {
    const res = await this.fetch(AI_BASE + path, { headers: { Authorization: `Bearer ${this.token()}` }, signal: AbortSignal.timeout(15000) });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, ok: res.ok, data };
  }

  state() {
    const signedIn = !!this.token() && !!this.info;
    return {
      base: BASE,
      signedIn,
      connecting: !!this.pending,
      email: this.info?.email || null,
      name: this.info?.name || null,
      username: this.info?.publicUsername || this.info?.username || null,
      plan: this.usage?.plan || null,
      planName: this.usage?.planName || null,
      paid: ['go', 'plus', 'pro', 'max'].includes(this.usage?.plan),
      usage: this.usage ? {
        remaining: this.usage.remaining,
        limit: this.usage.limit,
        used: Number.isFinite(this.usage.used) ? this.usage.used : Math.max(0, (this.usage.limit || 0) - (this.usage.remaining || 0)),
        resetsAt: this.usage.resetsAt,
        fullAt: this.usage.fullAt || null,
        refillsAt: this.usage.refillsAt || null,
        windows: (this.usage.windows || []).map((w) => ({ id: w.id, label: w.label, limit: w.limit, used: w.used, remaining: w.remaining, resetsAt: w.resetsAt, fullAt: w.fullAt || null })),
      } : null,
      error: this.error,
    };
  }

  changed() { this.onChange?.(this.state()); }

  // ---------------------------------------------------------------- sign in
  // Starts waiting for a login on the website. main.js opens the sign-in page
  // and hands us the session cookie when it appears (adopt).
  startSignIn() {
    clearTimeout(this.timer);
    this.error = null;
    this.pending = { expiresAt: Date.now() + SIGN_IN_MS };
    this.timer = setTimeout(() => {
      if (!this.pending) return;
      this.pending = null;
      this.error = 'Sign-in timed out. Try again.';
      this.changed();
    }, SIGN_IN_MS);
    this.changed();
    return { ok: true, url: `${BASE}/signin` };
  }

  // A session cookie from the website: keep it if it's a signed-in account.
  async adopt(token) {
    if (!this.pending || typeof token !== 'string' || !/^[A-Za-z0-9._~+/=-]{16,512}$/.test(token)) return false;
    let res;
    try { res = await this.api('/api/account', { token }); } catch { return false; }
    if (!res.ok || !res.data?.signedIn || res.data.authMethod === 'guest') return false; // not logged in yet
    if (!this.pending) return false; // cancelled meanwhile
    clearTimeout(this.timer);
    this.store.setSecret(SECRET, token);
    this.pending = null;
    this.error = null;
    await this.refresh();
    return true;
  }

  cancelSignIn(notify = true) {
    clearTimeout(this.timer);
    this.pending = null;
    if (notify) this.changed();
  }

  // ---------------------------------------------------------------- profile + plan
  async refresh() {
    if (!this.token()) { this.info = null; this.usage = null; this.changed(); return this.state(); }
    try {
      // The allowance shown in the browser is Lumio AI's (shared with Lumio Chat).
      const [account, usage] = await Promise.all([this.api('/api/account'), this.ai('/v1/usage').catch(() => ({ ok: false }))]);
      if (account.status === 401 || (account.ok && !account.data?.signedIn)) {
        // The session expired or was signed out on the website.
        this.store.setSecret(SECRET, '');
        this.info = null;
        this.usage = null;
        this.error = 'You were signed out of Lumio.';
      } else if (account.ok) {
        const a = account.data;
        this.info = { email: a.email, name: a.profile?.name || null, username: a.username, publicUsername: a.publicUsername };
        if (usage.ok && usage.data?.usage) this.usage = usage.data.usage;
        this.error = null;
      }
    } catch {
      this.error = this.info ? null : "Couldn't reach Lumio.";
    }
    this.changed();
    return this.state();
  }

  async signOut() {
    this.cancelSignIn(false);
    if (this.token()) await this.api('/api/auth', { method: 'POST', body: { action: 'logout' } }).catch(() => {});
    this.store.setSecret(SECRET, '');
    this.info = null;
    this.usage = null;
    this.error = null;
    this.changed();
  }
}

module.exports = { LumioAccount, LUMIO_BASE: BASE, LUMIO_AI_BASE: AI_BASE };
