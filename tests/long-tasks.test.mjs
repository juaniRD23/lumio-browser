// Long AI tasks: no step budget, what the server is sent stays bounded, and
// how a task ends (allowance used up, the safety ceilings, helpers) shows in
// the chat. The model is a stand-in for the Lumio server (fake-agent.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeAccount, imagesIn } from './fake-agent.mjs';

const require = createRequire(import.meta.url);
const electronPath = require.resolve('electron');
require.cache[electronPath] ??= { id: electronPath, filename: electronPath, loaded: true, exports: {} };
const { runAgent } = require('../main/ai/agent.js');
const { lumioChat, STOPPED_NOTE } = require('../main/ai/lumio.js');
const { AIController } = require('../main/ai/controller.js');
const { ChatStore } = require('../main/ai/chats.js');
const { cleanHelpers, HELPER_STEPS } = require('../main/ai/tools/helpers.js');

const tool = (name, run) => ({ name, risk: 'read', icon: 'app', description: name, parameters: { type: 'object', properties: {} }, label: () => name, run });

test('a 400-step task: every request stays under the server\'s limits, keeps the task, and stops growing', async () => {
  const task = 'Go through all 400 result pages and note every price';
  let n = 0;
  const shot = tool('screenshot_tab', () => ({ text: `Page ${++n}: ${'price list '.repeat(300)}`, image: `data:image/jpeg;base64,${Buffer.from(`page ${n}`).toString('base64')}` }));
  const account = fakeAccount((body, i) => (i <= 400 ? { calls: [{ name: 'screenshot_tab', arguments: `{"tab_id":${i}}` }] } : { text: 'Noted all 400.' }));
  const messages = [{ role: 'user', content: task }];
  let step = 0;
  const tipsOnce = ['[Lumio Browser, not the user] Tips for shop.test (from earlier tasks; use them if they fit, ignore them if the site changed):\n- the next button is at the bottom'];
  const res = await runAgent({
    model: 'm', messages, tools: [shot], systemPrompt: () => 'sys',
    chat: (opts) => lumioChat({ account, ...opts, context: {}, ids: { taskId: 't', runId: 'r', stepId: `s${++step}` } }),
    approve: async () => 'once', getMode: () => 'auto', emit: () => {}, ctx: { siteTips: () => tipsOnce.shift() ?? null },
  });
  assert.deepEqual(res, { steps: 401, reason: 'complete' });
  const sizes = account.bodies.map((b) => JSON.stringify(b).length);
  for (const [i, b] of account.bodies.entries()) {
    assert.ok(b.messages.length <= 150, `request ${i + 1}: ${b.messages.length} messages (the server takes 160)`);
    assert.ok(imagesIn(b.messages) <= 5, `request ${i + 1}: ${imagesIn(b.messages)} pictures (the server takes 16)`);
    assert.equal(b.messages[0].content, task, `request ${i + 1} starts with the task`);
  }
  // Later requests are no bigger than the ones around step 100: the cost of a step stops growing.
  assert.ok(Math.max(...sizes.slice(200)) <= Math.max(...sizes.slice(60, 200)) * 1.05, `${Math.max(...sizes.slice(200))} vs ${Math.max(...sizes.slice(60, 200))}`);
  // Nor are hundreds of screenshots kept in memory.
  assert.ok(imagesIn(messages) <= 5);
});

// An AI controller for one window, with no real tabs, on the stand-in server.
function controller(reply, { tabs = {}, caps = {} } = {}) {
  const events = [];
  const notified = [];
  const finished = [];
  let ended = null;
  const store = { settings: { reasoning: 'medium', approvalMode: 'auto', appsOff: [] }, setSetting(k, v) { this.settings[k] = v; } };
  const account = fakeAccount(reply, { tools: ['read_page', 'click', 'wait', 'update_plan', 'web_search', 'read_url'], caps });
  const ai = new AIController({
    store,
    chats: new ChatStore(null),
    tabs: { active: null, tabs: [], displayUrl: () => '', get: () => null, ...tabs },
    emit: (channel, ev) => { events.push(ev); if (ev?.type === 'end') ended?.(); },
    helper: { available: () => false },
    account,
    schedules: { started() {}, finished: (id, status) => finished.push(status), due: () => [] },
    notify: (title, body) => notified.push({ title, body }),
  });
  const end = () => new Promise((resolve) => { ended = resolve; });
  return { ai, account, events, notified, finished, end };
}
// The model keeps doing something new (a tool this window doesn't have, so nothing real runs).
const busy = (body, i) => ({ calls: [{ name: 'look_around', arguments: `{"n":${i}}` }] });

// update_plan's "blocked" status is newer than Lumio Browser 0.6.7 and its
// Beta 8, so the server offers it only to versions whose steps say they
// understand it (context.planStatuses). This one says so once the server lists
// the statuses (GET /v1/agent): a server from before refuses fields it doesn't
// know. Without them, Lumio still keeps going, and isn't told to mark steps blocked.
test('keep going: the steps say this version understands the "blocked" plan status when the server lists it', async () => {
  const STATUSES = ['pending', 'in_progress', 'done', 'blocked'];
  const plan = JSON.stringify({ steps: [{ title: 'Fill the cart', status: 'done' }, { title: 'Check out', status: 'pending' }] });
  const reply = (body, i) => (i === 1 ? { calls: [{ name: 'update_plan', arguments: plan }] } : i === 2 ? { text: 'The cart is ready.' } : { text: 'Shall I pay $42.10?' });
  for (const [caps, says] of [[{ planStatuses: STATUSES }, true], [{ planStatuses: ['pending', 'in_progress', 'done'] }, false], [{}, false]]) {
    const { ai, account, end } = controller(reply, { caps });
    const ending = end();
    assert.equal((await ai.send({ text: 'Order dinner' })).ok, true);
    await ending;
    assert.equal(account.bodies.length, 3, 'it kept going once, then asked');
    for (const body of account.bodies) {
      if (says) assert.deepEqual(body.context.planStatuses, STATUSES);
      else assert.equal('planStatuses' in body.context, false, JSON.stringify(caps));
    }
    const note = account.bodies[2].messages.at(-1).content;
    assert.match(note, /^\[Lumio Browser, not the user\] Your task checklist isn't finished\. Still to do: "Check out"\./);
    if (says) assert.match(note, /then ask exactly that, and mark that step blocked in update_plan with the reason\.$/);
    else assert.match(note, /information you can't find\): then ask exactly that\.$/);
  }
});

// The account is refreshed after every step, and that checks GET /v1/agent
// again (main.js). One check failing mid-task (offline, a timeout) doesn't
// change what the rest of the task's steps say: the notes already tell the
// model to mark steps blocked.
test('keep going: a capabilities check that fails mid-task leaves the steps saying they understand "blocked"', async () => {
  const STATUSES = ['pending', 'in_progress', 'done', 'blocked'];
  const plan = JSON.stringify({ steps: [{ title: 'Fill the cart', status: 'in_progress' }, { title: 'Check out', status: 'pending' }] });
  const reply = (body, i) => (i === 1 ? { calls: [{ name: 'update_plan', arguments: plan }] } : i <= 4 ? { calls: [{ name: 'look_around', arguments: `{"n":${i}}` }] } : i === 5 ? { text: 'The cart is ready.' } : { text: 'Shall I pay $42.10?' });
  const { ai, account, end } = controller(reply, { caps: { planStatuses: STATUSES } });
  const fetch = account.fetch;
  let checks = 0;
  account.fetch = async (url, init = {}) => {
    if (!init.body && ++checks > 1) throw new TypeError('fetch failed'); // every check after the first
    return fetch(url, init);
  };
  account.refresh = async () => { ai.refreshCapabilities(); }; // as main.js does when the account changes
  const ending = end();
  assert.equal((await ai.send({ text: 'Order dinner' })).ok, true);
  await ending;
  assert.ok(checks > 2, `${checks} checks`);
  assert.equal(ai.blockedSteps(), false, 'the failed check forgot the statuses');
  assert.equal(account.bodies.length, 6);
  for (const [i, body] of account.bodies.entries()) assert.deepEqual(body.context.planStatuses, STATUSES, `step ${i + 1}`);
  assert.match(account.bodies[5].messages.at(-1).content, /and mark that step blocked in update_plan with the reason\.$/);
});

test('a task the person watches runs past 100 steps to the end, with no note', async () => {
  const { ai, account, end } = controller((body, i) => (i <= 250 ? busy(body, i) : { text: 'Checked all 250.' }));
  const ending = end();
  const sent = await ai.send({ text: 'Check all 250 listings' });
  assert.equal(sent.ok, true);
  await ending;
  const chat = ai.chatStore.get(sent.chatId);
  assert.equal(account.bodies.length, 251);
  assert.equal(chat.display.filter((d) => d.kind === 'ai').at(-1).text, 'Checked all 250.');
  assert.deepEqual(chat.display.filter((d) => d.kind === 'note' || d.kind === 'error'), []);
});

test('the allowance used up mid-task: the task ends showing the server\'s message (with Upgrade)', async () => {
  const message = 'You’ve used your Lumio AI allowance on the Plus plan for now. Upgrade for more, or try again when it refills.';
  const { ai, account, events, end } = controller((body, i) => (i < 120 ? busy(body, i) : { status: 429, error: message, code: 'usage_limit' }));
  const ending = end();
  const sent = await ai.send({ text: 'Compare prices on every store' });
  await ending;
  assert.equal(account.bodies.length, 120);
  const chat = ai.chatStore.get(sent.chatId);
  assert.deepEqual(chat.display.at(-1), { kind: 'error', text: message, code: 'usage_limit' });
  const error = events.find((e) => e.type === 'error');
  assert.equal(error.message, message);
  assert.equal(error.code, 'usage_limit', 'the panel shows it with the Upgrade button');
});

test('stuck: the chat says why it stopped and offers "continue"; the panel gets the same note', async () => {
  const { ai, events, end } = controller(() => ({ calls: [{ name: 'look_around', arguments: '{"n":1}' }] }));
  const ending = end();
  const sent = await ai.send({ text: 'Add it to the cart' });
  await ending;
  const note = 'Lumio stopped because it was repeating the same step (look_around). Say "continue" to try again.';
  assert.deepEqual(ai.chatStore.get(sent.chatId).display.filter((d) => d.kind === 'note'), [{ kind: 'note', text: note }]);
  assert.equal(events.find((e) => e.type === 'done').note, note);
});

test('a scheduled task (nobody watching) has a lower ceiling, 300 steps, and says so', async () => {
  const { ai, account, notified, finished } = controller(busy);
  const out = await ai.runScheduled({ id: 'job', title: 'Morning check', prompt: 'Check all the dashboards', when: 'Every day at 8:00' });
  assert.equal(out.status, 'stopped');
  assert.equal(account.bodies.length, 300);
  const note = 'Lumio stopped at its safety limit of 300 steps. Say "continue" to keep going.';
  assert.deepEqual(ai.chatStore.get(out.chatId).display.filter((d) => d.kind === 'note'), [{ kind: 'note', text: note }]);
  assert.deepEqual(finished, ['stopped']);
  assert.deepEqual(notified, [{ title: 'Morning check', body: note }]);
});

test(`helpers get up to ${HELPER_STEPS} steps, and Lumio hears when one was cut off`, async () => {
  assert.equal(HELPER_STEPS, 60);
  const tab = { id: 7, view: { setBounds() {}, webContents: { setBackgroundThrottling() {} } } };
  const { ai, account } = controller(busy, {
    tabs: { create: () => tab, get: (id) => (id === 7 ? tab : null), setAgent() {}, scoped: () => ({ active: tab, tabs: [tab], get: () => tab }), close() {} },
  });
  const run = { abort: new AbortController(), pending: new Map(), grants: new Set() };
  const out = await ai.runHelpers(cleanHelpers([{ title: 'Prices', task: 'Find the price on every page' }]), { parentId: 'p1', run, chat: { id: 'chat1' }, record: () => {}, runId: 'run1' });
  assert.equal(account.bodies.filter((b) => b.runId === 'run1-h1').length, 60);
  assert.match(out.text, /Helper 1 \(Blue\), “Prices” — did not finish:/);
  assert.match(out.text, /It stopped before finishing: it reached its limit of 60 steps\./);
  assert.equal(out.status, 'error');
});

test('a helper is told its step budget, and near the end to report what it has (Lumio gets the report)', async () => {
  const tab = { id: 7, view: { setBounds() {}, webContents: { setBackgroundThrottling() {} } } };
  const report = 'Prices so far: $10 at A, $12 at B. Not checked yet: C.';
  const { ai, account } = controller((body, i) => (/only 3 more steps/.test(body.messages.at(-1).content) ? { text: report } : busy(body, i)), {
    tabs: { create: () => tab, get: (id) => (id === 7 ? tab : null), setAgent() {}, scoped: () => ({ active: tab, tabs: [tab], get: () => tab }), close() {} },
  });
  const run = { abort: new AbortController(), pending: new Map(), grants: new Set() };
  const out = await ai.runHelpers(cleanHelpers([{ title: 'Prices', task: 'Find the price on every page' }]), { parentId: 'p1', run, chat: { id: 'chat1' }, record: () => {}, runId: 'run1' });
  const bodies = account.bodies.filter((b) => b.runId === 'run1-h1');
  assert.match(bodies[0].messages[0].content, /Do only this task, in at most 60 steps, then reply with a short report/);
  assert.equal(bodies.length, 58);
  assert.match(out.text, /Helper 1 \(Blue\), “Prices” — done:\nPrices so far: \$10 at A, \$12 at B\. Not checked yet: C\./);
  assert.equal(out.status, 'ok');
});

test('Stop: the chat marks the task as stopped, so the next request doesn\'t carry it on', async () => {
  let ai = null;
  const made = controller((body, i) => {
    if (i === 5) ai.stop();
    return i <= 5 ? busy(body, i) : { text: 'Here are the prices.' };
  });
  ai = made.ai;
  let ending = made.end();
  const sent = await ai.send({ text: 'Delete every email from Bob' });
  await ending;
  const chat = ai.chatStore.get(sent.chatId);
  assert.equal(chat.messages.at(-1).content, STOPPED_NOTE);
  assert.deepEqual(chat.display.at(-1), { kind: 'note', text: 'Stopped.' });
  ending = made.end();
  await ai.send({ chatId: sent.chatId, text: 'Compare laptop prices' });
  await ending;
  const last = made.account.bodies.at(-1).messages;
  const at = last.findIndex((m) => m.content === STOPPED_NOTE);
  assert.ok(at > 0, 'the model sees it was stopped');
  assert.match(last[at + 1].content, /^Compare laptop prices/);
  assert.equal(chat.display.filter((d) => d.kind === 'ai').at(-1).text, 'Here are the prices.');
});

test('a scheduled task is told how many steps it may take', async () => {
  const { ai, account } = controller(() => ({ text: 'All dashboards are green.' }));
  const out = await ai.runScheduled({ id: 'job', title: 'Morning check', prompt: 'Check all the dashboards', when: 'Every day at 8:00' });
  assert.equal(out.status, 'done');
  assert.match(account.bodies[0].messages[0].content, /A scheduled task can take at most 300 steps\./);
});
