// Making things and using connected apps:
//   generate_image   a picture from the Lumio server (POST /v1/images), saved to
//                    Downloads and shown in the panel. Uses the plan.
//   create_document  a PDF, Word, PowerPoint, Markdown, text, CSV or HTML file,
//                    built by the panel (the same code as Lumio Chat) and saved
//                    to Downloads.
//   connected apps   Gmail, Drive, Outlook, OneDrive... run by the server for
//                    this account (POST /v1/tools/run); the browser only relays.
// The server owns these tools' definitions; we only need names and how to run them.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const FORMATS = { pdf: 'PDF document', docx: 'Word document', pptx: 'PowerPoint deck', md: 'Markdown', txt: 'Text file', csv: 'Spreadsheet (CSV)', html: 'Web page' };

const safeName = (s, fallback) => String(s || '').replace(/[\u0000-\u001f\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || fallback;

// A free file name in a folder: "Report.pdf", "Report (2).pdf", ...
function freePath(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let n = 2; fs.existsSync(p); n++) p = path.join(dir, `${stem} (${n})${ext}`);
  return p;
}

function downloads() {
  if (process.env.LUMIO_TEST && process.env.LUMIO_DOWNLOADS) return process.env.LUMIO_DOWNLOADS; // tests
  try { return app.getPath('downloads'); } catch { return require('os').homedir(); }
}

// Where the panel's copies live (shown via lumio://shell/ai-files/<name>).
function filesDir() {
  const dir = path.join(app.getPath('userData'), 'ai-files');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function postJson(ctx, pathname, body) {
  const a = ctx.account;
  if (!a?.token()) throw new Error('Sign in to Lumio first (account button, top right).');
  const res = await a.fetch(`${a.aiBase}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.token()}` },
    body: JSON.stringify(body),
    signal: ctx.signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Lumio couldn’t do that (HTTP ${res.status}).`);
    if (data.code === 'usage_limit' || res.status === 429) err.code = 'usage_limit';
    throw err;
  }
  return data;
}

const tools = [
  {
    name: 'generate_image',
    icon: 'brush',
    risk: 'read',
    label: () => 'Making a picture',
    async run(args, ctx) {
      const prompt = String(args.prompt || '').trim();
      if (!prompt) throw new Error('Describe the picture.');
      let data;
      try { data = await postJson(ctx, '/v1/images', { prompt, aspect: args.aspect }); } catch (err) {
        if (err.code === 'usage_limit') return { text: 'Couldn’t make the picture: the user’s Lumio allowance is used up for now. Tell them briefly; they can upgrade or wait for it to refill.' };
        throw err;
      }
      const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(String(data.image || ''));
      if (!m) throw new Error('The image model didn’t return a picture.');
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
      const bytes = Buffer.from(m[2], 'base64');
      const name = `${safeName(prompt.split(/\s+/).slice(0, 6).join(' ').replace(/[.,;:]+$/, ''), 'Lumio picture')}.${ext}`;
      const saved = freePath(downloads(), name);
      fs.writeFileSync(saved, bytes);
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      fs.writeFileSync(path.join(filesDir(), id), bytes);
      ctx.made?.({ kind: 'image', name: path.basename(saved), path: saved, url: `lumio://shell/ai-files/${id}`, prompt: prompt.slice(0, 300) });
      return { text: `Done: the picture is shown to the user in the chat and saved to their Downloads as “${path.basename(saved)}”. Add one short line about it; no links or paths.`, summary: path.basename(saved) };
    },
  },
  {
    name: 'create_document',
    icon: 'page',
    risk: 'read',
    label: (a) => `Writing ${safeName(a.title, 'a document')}.${a.format || 'pdf'}`,
    async run(args, ctx) {
      const format = Object.hasOwn(FORMATS, args.format) ? args.format : 'pdf';
      const title = safeName(args.title, 'Lumio document');
      if (!ctx.buildDocument) throw new Error('Lumio can’t make files in this window.');
      const bytes = await ctx.buildDocument({ name: `${title}.${format}`, format, title, text: String(args.content || '') });
      const saved = freePath(downloads(), `${title}.${format}`);
      fs.writeFileSync(saved, Buffer.from(bytes));
      ctx.made?.({ kind: 'document', name: path.basename(saved), path: saved, format, label: FORMATS[format] });
      return { text: `Created “${path.basename(saved)}” in the user’s Downloads; it’s shown as a card with Open and Show in Finder. Reply with one or two sentences; don’t repeat the content or write a path.`, summary: path.basename(saved) };
    },
  },
];

// Labels for connected-app tools (the server lists which ones this account has).
const USING = {
  gmail_search: 'Searching Gmail', gmail_read: 'Reading an email', drive_search: 'Searching Google Drive', drive_read: 'Reading a Drive file',
  calendar_events: 'Checking Google Calendar', outlook_search: 'Searching Outlook', outlook_read: 'Reading an email',
  outlook_events: 'Checking Outlook Calendar', onedrive_search: 'Searching OneDrive', onedrive_read: 'Reading a OneDrive file',
};

// One relay tool per connected-app tool the server offers.
function remoteTools(list = []) {
  return list.filter((t) => t && typeof t.name === 'string').map((t) => ({
    name: t.name,
    app: t.app || '',
    icon: 'app',
    risk: 'read',
    label: () => USING[t.name] || `Using ${t.app || 'a connected app'}`,
    async run(args, ctx) {
      const data = await postJson(ctx, '/v1/tools/run', { name: t.name, arguments: args });
      return { text: String(data.text || '').slice(0, 80_000) || 'Nothing found.', summary: t.app || undefined };
    },
  }));
}

module.exports = { tools, remoteTools, FORMATS, freePath };
