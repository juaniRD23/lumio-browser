// The computer's side of the phone companion (lumio…/companion). Through the
// Lumio server's relay, end-to-end encrypted with the sync key:
// - commands from the phone: ask Lumio something here, run a workflow,
//   approve or deny a step, stop;
// - this computer's live status for the phone: what Lumio is doing, the
//   latest reply, steps waiting for an OK;
// - notices that wake the phone: a task it started finished or needs an OK,
//   a scheduled task finished.
const C = require('./crypto');
const { t } = require('../i18n');

const IDLE_POLL = 15_000;
const WATCHED_POLL = 3_000; // someone has the phone app open
const STATUS_EVERY = 60_000; // also keeps this computer "online" on the phone
const MAX_AGE = 3 * 60_000; // commands older than this are ignored

class CompanionBridge {
  constructor({ sync, windows, pickWindow, openChat }) {
    this.sync = sync;
    this.windows = windows; // () => this computer's normal windows
    this.pickWindow = pickWindow; // () => the window to work in (opening one if needed)
    this.openChat = openChat; // (w, chatId) => show that chat in the panel
    this.watching = false;
    this.fromPhone = new Set(); // chats the phone started: their end and approvals notify it
    this.live = { running: false, chatId: null, title: '', label: '', reply: '', approvals: [] };
    this.dirty = false;
    this.lastStatus = 0;
  }

  start() {
    const loop = async () => {
      await this.poll().catch(() => {});
      this.timer = setTimeout(loop, this.watching || this.live.running ? WATCHED_POLL : IDLE_POLL);
      this.timer.unref?.();
    };
    this.timer = setTimeout(loop, 5000);
    this.timer.unref?.();
  }
  stop() { clearTimeout(this.timer); clearTimeout(this.statusTimer); }

  ready() { return this.sync.status === 'ready' && this.sync.keys; }
  seal(value, id = 'msg') { return C.seal(this.sync.keys, 'companion', id, value); }

  // ---------------------------------------------------------------- commands
  async poll() {
    if (!this.ready()) return;
    const state = this.sync.file.data;
    const first = state.companionCursor == null;
    const res = await this.sync.api(`/api/companion/messages?kind=command&device=${encodeURIComponent(this.sync.deviceId)}&since=${state.companionCursor || 0}`);
    this.watching = !!res.watching;
    if (!first) {
      for (const m of res.messages) {
        let cmd;
        try { cmd = await C.open(this.sync.keys, 'companion', 'msg', m.data); } catch { continue; }
        if (!cmd || Date.now() - (cmd.at || 0) > MAX_AGE) continue;
        await this.handle(cmd).catch((err) => this.notice({ title: 'Lumio couldn’t do that', body: String(err.message || err).slice(0, 200) }));
      }
    }
    state.companionCursor = res.cursor; // commands from before this computer started listening are skipped
    this.sync.file.save();
    if (this.dirty || Date.now() - this.lastStatus > STATUS_EVERY) await this.postStatus();
  }

  async handle(cmd) {
    if (cmd.type === 'approve') {
      for (const w of this.windows()) w.ai.approve(String(cmd.callId), cmd.decision === 'deny' ? 'deny' : 'once');
      return;
    }
    if (cmd.type === 'stop') {
      for (const w of this.windows()) if (w.ai.isRunning()) w.ai.stop();
      return;
    }
    if (cmd.type !== 'send' && cmd.type !== 'workflow') return;
    const busy = this.windows().find((w) => w.ai.isRunning());
    if (busy) {
      // Something said about the running task joins it; anything else waits.
      if (cmd.type === 'send' && cmd.chatId && busy.ai.run?.chatId === cmd.chatId) {
        const r = busy.ai.steer({ chatId: cmd.chatId, text: String(cmd.text || '') });
        if (r.ok) return;
      }
      await this.notice({ title: 'Lumio is busy', body: 'It’s still working on another task on your computer. Stop it first, or try again when it’s done.' });
      return;
    }
    const w = this.pickWindow();
    const res = cmd.type === 'workflow'
      ? await w.ai.send({ workflow: { id: String(cmd.id), values: cmd.values || {} } })
      : await w.ai.send({ chatId: cmd.chatId || null, text: String(cmd.text || '').slice(0, 20_000), includePage: false });
    if (!res.ok) { await this.notice({ title: 'Lumio couldn’t start', body: res.error }); return; }
    this.fromPhone.add(res.chatId);
    this.openChat(w, res.chatId);
  }

  // ---------------------------------------------------------------- status
  // Every AI event in this computer's windows (BrowserWin.emit).
  onEmit(w, channel, ev) {
    if (w.incognito || channel !== 'ai-event' || !ev?.chatId) return;
    const l = this.live;
    switch (ev.type) {
      case 'start':
        Object.assign(l, { running: true, chatId: ev.chatId, title: w.ai.chatStore.get(ev.chatId)?.title || '', label: 'Thinking…', reply: '', approvals: [] });
        break;
      case 'text':
        if (l.chatId === ev.chatId) l.reply = `${l.reply}${ev.delta || ''}`.slice(-4000);
        break;
      case 'step':
        if (l.chatId === ev.chatId) { l.label = ev.label || l.label; l.reply = ''; }
        break;
      case 'approval':
        l.approvals = [...l.approvals.filter((a) => a.id !== ev.id), { id: ev.id, label: ev.label, detail: ev.detail || null, risk: ev.risk }];
        if (this.fromPhone.has(ev.chatId) || !this.focused()) this.notice({ title: 'Lumio needs your OK', body: ev.label || 'A step is waiting for you.', chatId: ev.chatId, hint: 'approval' });
        break;
      case 'approval_done':
        l.approvals = l.approvals.filter((a) => a.id !== ev.id);
        break;
      case 'end':
        if (l.chatId === ev.chatId) {
          l.running = false;
          l.label = '';
          l.approvals = [];
          if (this.fromPhone.has(ev.chatId)) {
            this.fromPhone.delete(ev.chatId);
            this.notice({ title: l.title || 'Lumio finished', body: l.reply.replace(/[#*_`>[\]()]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180) || 'Done.', chatId: ev.chatId, hint: 'done' });
          }
        }
        break;
      default:
        return;
    }
    this.dirty = true;
    clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => this.postStatus().catch(() => {}), 1200);
    this.statusTimer.unref?.();
  }

  focused() { return this.windows().some((w) => !w.win.isDestroyed() && w.win.isFocused()); }

  async postStatus() {
    if (!this.ready()) return;
    this.dirty = false;
    this.lastStatus = Date.now();
    const l = this.live;
    const status = { at: Date.now(), running: l.running, chatId: l.chatId, title: l.title, label: l.label, reply: l.reply.slice(-1500), approvals: l.approvals };
    await this.sync.api('/api/companion/status', { method: 'PUT', body: { device: this.sync.deviceId, data: await this.seal(status, 'status') } });
  }

  // A notification for the phone(s).
  // hint (done | approval | scheduled | info) is the only part the server can
  // see: the Lumio app's notification says just that.
  async notice({ title, body, chatId = null, hint = 'info' }) {
    if (!this.ready()) return;
    // In Lumio's language, like the computer's own notifications.
    const data = await this.seal({ at: Date.now(), title: t(String(title)).slice(0, 100), body: t(String(body || '')).slice(0, 300), chatId, computer: this.sync.deviceName });
    await this.sync.api('/api/companion/messages', { method: 'POST', body: { kind: 'notice', device: this.sync.deviceId, data, hint } }).catch(() => {});
  }
}

module.exports = { CompanionBridge };
