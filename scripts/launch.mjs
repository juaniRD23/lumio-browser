// Shared launcher for dev scripts and e2e tests (playwright-core's Electron driver).
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { buildPreload } from './build-preload.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let built = null;

// Fail loudly instead of hanging when the app stops answering.
const timed = (promise, what, ms = 30_000) => {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out after ${ms / 1000}s: ${what}`)), ms); }),
  ]);
};
const brief = (x) => String(x).replace(/\s+/g, ' ').slice(0, 100);

// executablePath: run a packaged build (e.g. the installed app) instead of the source.
export async function launch({ profile, env = {}, executablePath } = {}) {
  built ??= buildPreload();
  await built;
  const temp = !profile;
  const userData = profile || fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-profile-'));
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: [root] }),
    cwd: root,
    env: { ...process.env, LUMIO_USER_DATA: userData, LUMIO_TEST: '1', ...env },
    // Playwright pretends every page prefers light unless told not to; Lumio's
    // own appearance setting (main/theme.js) must decide, like in real use.
    colorScheme: null,
  });
  const logs = [];
  app.process().stdout.on('data', (d) => logs.push(String(d)));
  app.process().stderr.on('data', (d) => logs.push(String(d)));
  // Playwright runs evaluate() through the inspector, which can interrupt the
  // main process in the middle of other work. Hop to a fresh macrotask first
  // so test code never re-enters Electron from inside a native call.
  const run = (fn, arg) => app.evaluate(async (electron, { src, arg: a }) => {
    await new Promise((r) => setImmediate(r));
    return (0, eval)(`(${src})`)(electron, a);
  }, { src: fn.toString(), arg });
  const lumio = {
    app,
    logs,
    userData,
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    main: (fn, arg) => timed(run(fn, arg), brief(fn)),
    async shot(file) {
      const b64 = await run(async () => global.lumio.snapshot());
      if (b64 && file) fs.writeFileSync(file, Buffer.from(b64, 'base64'));
      return b64;
    },
    // Run JS in the active tab's page and return the result.
    page: (code) => timed(run(async (_e, c) => global.lumio.tabs.wc().executeJavaScript(c), code), 'page: ' + brief(code)),
    // Run JS in the browser UI (shell) and return the result.
    shell: (code) => timed(run(async (_e, c) => global.lumio.win.webContents.executeJavaScript(c), code), 'shell: ' + brief(code)),
    async close() {
      const errors = logs.join('').split('\n').filter((l) => /\[lumio\] (uncaught|unhandled)/.test(l));
      if (errors.length) console.error('Main-process errors during this run:\n' + logs.join(''));
      await app.close();
      if (temp) fs.rmSync(userData, { recursive: true, force: true });
    },
  };
  return lumio;
}
