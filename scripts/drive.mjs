// Dev driver: launches Lumio Browser with a throwaway profile, runs a few
// steps, and saves composite screenshots. Usage: node scripts/drive.mjs <outDir>
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-shots-'));
fs.mkdirSync(out, { recursive: true });
const profile = process.env.LUMIO_USER_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'lumio-profile-'));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, LUMIO_USER_DATA: profile, LUMIO_TEST: '1' } });
const logs = [];
app.process().stdout.on('data', (d) => logs.push(String(d)));
app.process().stderr.on('data', (d) => logs.push(String(d)));

const shot = async (name) => {
  const b64 = await app.evaluate(async () => global.lumio.snapshot());
  if (b64) fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(b64, 'base64'));
  console.log('shot', name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await wait(2500);
await shot('01-start');
const state = await app.evaluate(() => global.lumio.tabs.state());
console.log(JSON.stringify(state));
fs.writeFileSync(path.join(out, 'logs.txt'), logs.join(''));
await app.close();
console.log('out', out);
