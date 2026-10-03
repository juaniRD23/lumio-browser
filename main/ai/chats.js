// Lumio chats shared by every window of a profile. Normal windows save them
// to chats.json (without screenshots); incognito chats live in memory only.
function stripForDisk(chat) {
  return {
    id: chat.id,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    messages: chat.messages.map((m) => (Array.isArray(m.content)
      ? { ...m, content: m.content.map((p) => (p.type === 'image_url' ? { type: 'text', text: '[image not kept]' } : p)) }
      : m)),
    display: chat.display.map((d) => (d.thumb ? { ...d, thumb: undefined } : d)),
    ...(chat.plan ? { plan: chat.plan } : {}),
    ...(chat.projectId ? { projectId: chat.projectId } : {}),
  };
}

class ChatStore {
  constructor(file = null) {
    this.file = file; // JsonFile, or null for incognito
    this.chats = file && Array.isArray(file.data) ? file.data.filter((c) => c && c.id) : [];
    this.running = new Set(); // chat ids with an agent run in some window
  }

  get ephemeral() { return !this.file; }

  // What's saved (and synced) for a chat: no pictures.
  forDisk(chat) { return stripForDisk(chat); }

  list() {
    return [...this.chats]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ id, title, updatedAt, projectId }) => ({ id, title, updatedAt, projectId: projectId || null }));
  }

  // The sidebar's search: titles first, then what was said.
  search(q, limit = 20) {
    const needle = String(q || '').trim().toLowerCase();
    if (!needle) return [];
    const out = [];
    for (const c of [...this.chats].sort((a, b) => b.updatedAt - a.updatedAt)) {
      const inTitle = String(c.title || '').toLowerCase().includes(needle);
      const hit = inTitle ? null : c.display.find((d) => (d.kind === 'user' || d.kind === 'ai') && String(d.text || '').toLowerCase().includes(needle));
      if (!inTitle && !hit) continue;
      let snippet = '';
      if (hit) {
        const t = String(hit.text).replace(/\s+/g, ' ');
        const i = t.toLowerCase().indexOf(needle);
        snippet = `${i > 30 ? '…' : ''}${t.slice(Math.max(0, i - 30), i + needle.length + 60)}`;
      }
      out.push({ id: c.id, title: c.title, updatedAt: c.updatedAt, snippet, projectId: c.projectId || null });
      if (out.length >= limit) break;
    }
    return out;
  }

  rename(id, title) {
    const c = this.get(id);
    const t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!c || !t) return false;
    c.title = t;
    this.save();
    return true;
  }

  // Into a project (or out of it, with null).
  move(id, projectId) {
    const c = this.get(id);
    if (!c) return false;
    if (projectId) c.projectId = projectId; else delete c.projectId;
    this.save();
    return true;
  }

  // Chats of a project that was deleted stay, without the project.
  unfile(projectId) {
    let n = 0;
    for (const c of this.chats) if (c.projectId === projectId) { delete c.projectId; n++; }
    if (n) this.save();
  }

  onChange(fn) { (this.listeners ||= new Set()).add(fn); }

  get(id) { return this.chats.find((c) => c.id === id) || null; }

  add(chat) { this.chats.unshift(chat); }

  delete(id) {
    this.chats = this.chats.filter((c) => c.id !== id);
    this.save();
  }

  clear() {
    this.chats = [];
    this.save();
  }

  save() {
    for (const fn of this.listeners || []) fn();
    this.chats.sort((a, b) => b.updatedAt - a.updatedAt);
    if (this.chats.length > 100) this.chats.length = 100;
    if (!this.file) return;
    this.file.data = this.chats.map(stripForDisk);
    this.file.save();
  }
}

module.exports = { ChatStore };
