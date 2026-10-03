// The Windows helper (native/windows/lumio-helper.ps1), driven the way Lumio
// drives it: JSON lines over stdin/stdout. Windows only (CI: e2e-windows.yml).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WIN = process.platform === 'win32';
const SCRIPT = fileURLToPath(new URL('../native/windows/lumio-helper.ps1', import.meta.url));
let proc;
let nextId = 1;
const waiting = new Map();

function call(cmd, args = {}, ms = 30_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${cmd} timed out`)); }, ms);
    waiting.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    proc.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
  });
}

before(() => {
  if (!WIN) return;
  proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      try { const msg = JSON.parse(line); waiting.get(msg.id)?.(msg); waiting.delete(msg.id); } catch { /* not JSON */ }
    }
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[helper] ${d}`));
});
after(() => proc?.kill());

test('the Windows helper starts and answers', { skip: !WIN && 'Windows only' }, async () => {
  assert.deepEqual(await call('ping', {}, 90_000), { pong: true, id: 1, ok: true }, 'first call compiles the native part (slow)');
  const perms = await call('permissions');
  assert.equal(perms.ok, true);
});

test('displays, cursor moves and screenshots', { skip: !WIN && 'Windows only' }, async () => {
  const d = await call('displays');
  assert.equal(d.ok, true, d.error);
  assert.ok(d.displays.length >= 1, 'at least one display');
  const main = d.displays[0];
  const x = Math.round((main.x ?? 0) + 100);
  const y = Math.round((main.y ?? 0) + 120);
  assert.equal((await call('move', { x, y })).ok, true);
  const after = await call('displays');
  assert.deepEqual([after.cursor.x, after.cursor.y], [x, y], 'the cursor went where it was told');
  const shot = await call('screenshot', {}, 60_000);
  assert.equal(shot.ok, true, shot.error);
  const data = shot.data || shot.image || shot.png || '';
  assert.ok(String(data).length > 1000, `a picture came back (keys: ${Object.keys(shot).join(', ')})`);
});

test('apps, keys and typing don’t fail', { skip: !WIN && 'Windows only' }, async () => {
  const apps = await call('apps');
  assert.equal(apps.ok, true, apps.error);
  assert.ok(Array.isArray(apps.apps));
  const key = await call('key', { combo: 'shift' });
  assert.equal(key.ok, true, key.error);
  const typed = await call('type', { text: 'hello' });
  assert.equal(typed.ok, true, typed.error);
  const unknown = await call('nope');
  assert.equal(unknown.ok, false);
});
