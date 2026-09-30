// Lumio account: the same account as lumio-usa.online, connected with the
// site's desktop hand-off. We send a hash of a secret "verifier", the person
// approves the request on the website (which shows the same short code we
// do), and polling with the verifier returns a session token. The token is
// stored encrypted with safeStorage. Profile and plan come from the
// site's /api/account and /api/usage.
const crypto = require('crypto');

const BASE = (process.env.LUMIO_ACCOUNT_BASE || 'https://lumio-usa.online').replace(/\/$/, '');
const SECRET = 'lumio-session';
const POLL_MS = 2000;

class LumioAccount {
  constructor({ store, onChange, fetchImpl = globalThis.fetch }) {
    this.store = store;
    this.onChange = onChange;
    this.fetch = fetchImpl;
    this.pending = null; // { id, verifier, code, url, expiresAt }
    this.info = null; // { email, name, username, publicUsername }
    this.usage = null; // { plan, planName, remaining, limit, resetsAt, windows }
    this.error = null;
    this.timer = null;
  }

  get base() { return BASE; }
  url(path = '/') { return BASE + path; }
  token() { return this.store.getSecret(SECRET); }
  cookie() { return `${BASE.startsWith('https:') ? '__Host-lumio_session' : 'lumio_session'}=${this.token()}`; }

  async api(path, { method = 'GET', body } = {}) {
    const res = await this.fetch(BASE + path, {
      method,
      headers: {
        ...(this.token() ? { Cookie: this.cookie() } : {}),
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

  state() {
    const signedIn = !!this.token() && !!this.info;
    return {
      base: BASE,
      signedIn,
      connecting: !!this.pending,
      code: this.pending?.code || null,
      email: this.info?.email || null,
      name: this.info?.name || null,
      username: this.info?.publicUsername || this.info?.username || null,
      plan: this.usage?.plan || null,
      planName: this.usage?.planName || null,
      paid: ['plus', 'pro', 'max'].includes(this.usage?.plan),
      usage: this.usage ? {
        remaining: this.usage.remaining,
        limit: this.usage.limit,
        resetsAt: this.usage.resetsAt,
        windows: (this.usage.windows || []).map((w) => ({ id: w.id, label: w.label, limit: w.limit, used: w.used, remaining: w.remaining, resetsAt: w.resetsAt })),
      } : null,
      error: this.error,
    };
  }

  changed() { this.onChange?.(this.state()); }

  // ---------------------------------------------------------------- sign in
  async startSignIn() {
    this.cancelSignIn(false);
    this.error = null;
    const verifier = crypto.randomBytes(32).toString('hex');
    const challenge = crypto.createHash('sha256').update(verifier).digest('hex');
    let res;
    try {
      res = await this.api('/api/auth/desktop', { method: 'POST', body: { action: 'start', challenge } });
    } catch {
      this.error = "Couldn't reach Lumio. Check your connection.";
      this.changed();
      return { ok: false, error: this.error };
    }
    const id = res.data?.id;
    if (!res.ok || !/^[a-f0-9]{64}$/.test(id || '')) {
      this.error = res.data?.error || "Couldn't start signing in. Try again.";
      this.changed();
      return { ok: false, error: this.error };
    }
    // Build the approval link ourselves so it always points at Lumio.
    this.pending = {
      id,
      verifier,
      code: id.slice(0, 6).toUpperCase(),
      url: `${BASE}/desktop-connect?request=${id}`,
      expiresAt: res.data.expiresAt || Date.now() + 5 * 60 * 1000,
    };
    this.changed();
    this.schedulePoll();
    return { ok: true, url: this.pending.url, code: this.pending.code };
  }

  schedulePoll() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.poll().catch(() => this.schedulePoll()), POLL_MS);
  }

  async poll() {
    const p = this.pending;
    if (!p) return;
    if (Date.now() > p.expiresAt) {
      this.pending = null;
      this.error = 'Sign-in timed out. Try again.';
      this.changed();
      return;
    }
    const res = await this.api('/api/auth/desktop', { method: 'POST', body: { action: 'poll', id: p.id, verifier: p.verifier } });
    if (this.pending !== p) return; // cancelled meanwhile
    if (res.status === 202) { this.schedulePoll(); return; }
    if (res.ok && /^[a-f0-9]{64}$/.test(res.data?.token || '')) {
      this.store.setSecret(SECRET, res.data.token);
      this.pending = null;
      this.error = null;
      await this.refresh();
      return;
    }
    this.pending = null;
    this.error = res.data?.error || 'Sign-in didn’t finish. Try again.';
    this.changed();
  }

  cancelSignIn(notify = true) {
    clearTimeout(this.timer);
    const p = this.pending;
    this.pending = null;
    if (p) this.api('/api/auth/desktop', { method: 'POST', body: { action: 'cancel', id: p.id, verifier: p.verifier } }).catch(() => {});
    if (notify) this.changed();
  }

  // ---------------------------------------------------------------- profile + plan
  async refresh() {
    if (!this.token()) { this.info = null; this.usage = null; this.changed(); return this.state(); }
    try {
      const [account, usage] = await Promise.all([this.api('/api/account'), this.api('/api/usage')]);
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

module.exports = { LumioAccount, LUMIO_BASE: BASE };
