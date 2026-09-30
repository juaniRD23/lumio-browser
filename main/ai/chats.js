// Lumio chats shared by every window of a profile. Normal windows save them
// to chats.json (without screenshots); incognito chats live in memory only.
function stripForDisk(chat) {
  return {
    id: chat.id,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    messages: chat.messages.map((m) => (Array.isArray(m.content)
      ? { ...m, content: m.content.map((p) => (p.type === 'image_url' ? { type: 'text', text: '[screenshot]' } : p)) }
      : m)),
    display: chat.display.map((d) => (d.thumb ? { ...d, thumb: undefined } : d)),
    ...(chat.plan ? { plan: chat.plan } : {}),
  };
}

class ChatStore {
  constructor(file = null) {
    this.file = file; // JsonFile, or null for incognito
    this.chats = file && Array.isArray(file.data) ? file.data.filter((c) => c && c.id) : [];
    this.running = new Set(); // chat ids with an agent run in some window
  }

  get ephemeral() { return !this.file; }

  list() {
    return [...this.chats]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
  }

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
    this.chats.sort((a, b) => b.updatedAt - a.updatedAt);
    if (this.chats.length > 100) this.chats.length = 100;
    if (!this.file) return;
    this.file.data = this.chats.map(stripForDisk);
    this.file.save();
  }
}

module.exports = { ChatStore };
