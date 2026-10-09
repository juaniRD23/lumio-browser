// Lumio on your phone: wakes up for a push (it carries nothing), fetches the
// new notices from Lumio, decrypts them with the sync key kept on this phone,
// and shows them. Without the key (signed out, or not set up yet), it shows a
// plain notice instead.
importScripts('/sync-crypto.js');

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

function kv(key, value) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('lumio-companion', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const t = r.result.transaction('kv', value === undefined ? 'readonly' : 'readwrite');
      const req = value === undefined ? t.objectStore('kv').get(key) : t.objectStore('kv').put(value, key);
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error);
    };
  });
}

async function showNotices() {
  const C = self.LumioSyncCrypto;
  try {
    const device = await kv('device');
    const owner = await kv('syncKeyOwner');
    const raw = owner && await kv(`syncKey:${owner}`);
    if (!device || !raw) throw new Error('not paired');
    const keys = await C.deriveKeys(C.fromB64(raw));
    const since = (await kv('noticeCursor')) || 0;
    const res = await fetch(`/api/companion/messages?kind=notice&device=${encodeURIComponent(device)}&since=${since}`, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { messages, cursor } = await res.json();
    await kv('noticeCursor', cursor);
    const fresh = messages.slice(-3);
    if (!fresh.length) throw new Error('nothing new');
    for (const m of fresh) {
      const n = await C.open(keys, 'companion', 'msg', m.data);
      await self.registration.showNotification(n.title || 'Lumio', { body: n.body || '', tag: n.chatId || `lumio-${m.seq}`, icon: '/companion-icons/icon-192.png', badge: '/companion-icons/icon-192.png', data: { chatId: n.chatId || null } });
    }
  } catch {
    // A push must always show something (phones stop delivering otherwise).
    await self.registration.showNotification('Lumio', { body: 'Open Lumio to see what’s new.', icon: '/companion-icons/icon-192.png', tag: 'lumio' });
  }
}

self.addEventListener('push', (e) => e.waitUntil(showNotices()));

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const chat = e.notification.data?.chatId;
  const url = chat ? `/companion#chat=${encodeURIComponent(chat)}` : '/companion';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = all.find((c) => new URL(c.url).pathname === '/companion');
    if (open) { await open.focus(); return open.navigate(url).catch(() => {}); }
    return self.clients.openWindow(url);
  })());
});
