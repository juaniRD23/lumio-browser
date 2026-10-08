// Computer tools: see the screen and drive the mouse and keyboard through the
// helper (Swift on macOS, PowerShell on Windows), open apps, and run shell
// commands (zsh / PowerShell) or AppleScript (macOS only).
const { execFile } = require('child_process');
const { nativeImage } = require('electron');
const os = require('os');
const screenAura = require('../screen-aura');

function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, cwd: os.homedir(), ...opts }, (err, stdout, stderr) => {
      const out = [stdout, stderr].filter(Boolean).join(stdout && stderr ? '\n' : '').trim();
      let status = 'exit code 0';
      if (err) status = err.killed ? 'timed out after 60s' : `exit code ${err.code ?? 1}`;
      resolve({ out: out.length > 12_000 ? out.slice(0, 12_000) + '\n…[output truncated]' : out, status, failed: !!err });
    });
  });
}

const WIN = process.platform === 'win32';
const PC = WIN ? 'PC' : 'Mac';
const PATH = WIN ? process.env.PATH : ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'].join(':');

// Open a Windows app by name: an executable on PATH, or a Start menu shortcut.
// The name goes in through an environment variable, never into the script.
const OPEN_WIN_APP = `
$name = $env:LUMIO_APP
$dirs = @("$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs", "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs")
$link = Get-ChildItem -Path $dirs -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | Where-Object { $_.BaseName -like "*$name*" } | Sort-Object { $_.BaseName.Length } | Select-Object -First 1
if ($link) { Start-Process -FilePath $link.FullName; "opened $($link.BaseName)"; exit 0 }
try { Start-Process -FilePath $name -ErrorAction Stop; "opened $name"; exit 0 } catch { Write-Error "Couldn't find an app called $name."; exit 1 }
`;

function toGlobal(ctx, x, y) {
  const s = ctx.lastMacShot;
  if (!s) throw new Error('Take a computer_screenshot first. Coordinates come from the latest screenshot.');
  if (x < 0 || y < 0 || x > s.width || y > s.height) throw new Error(`(${x}, ${y}) is outside the ${s.width}x${s.height} screenshot.`);
  return {
    x: Math.round(s.bounds.x + x * (s.bounds.width / s.width)),
    y: Math.round(s.bounds.y + y * (s.bounds.height / s.height)),
  };
}

const XY = { x: { type: 'number' }, y: { type: 'number' } };

// A coarse picture of the screen (16x10 gray levels): whether a step changed
// what's on it, without the clock or a blinking caret counting as a change.
function coarse(img) {
  const px = img.resize({ width: 16, height: 10 }).toBitmap();
  let sig = '';
  for (let i = 0; i < px.length; i += 4) sig += Math.round((px[i] + px[i + 1] + px[i + 2]) / 192);
  return sig;
}

const tools = [
  {
    name: 'computer_screenshot',
    risk: 'mac',
    icon: 'mac',
    description: `Take a screenshot of the ${PC}'s screen (all apps, not just the browser). Use its pixel coordinates with computer_click and the other computer_* tools.`,
    parameters: {
      type: 'object',
      properties: { display: { type: 'string', description: '"cursor" (default: the display under the mouse), "main", or a display number from a previous screenshot' } },
    },
    label: () => 'Look at your screen',
    detail: () => 'Take a screenshot of your whole screen',
    async run(a, ctx) {
      // Lumio's own glow and Stop pill are left out of what the model sees.
      const res = await ctx.helper.request('screenshot', { display: a.display || 'cursor', maxWidth: 1440, excludeWindows: screenAura.windowIds() });
      ctx.lastMacShot = { bounds: res.bounds, width: res.width, height: res.height, display: res.display };
      const img = nativeImage.createFromBuffer(Buffer.from(res.image, 'base64'));
      const thumb = 'data:image/jpeg;base64,' + img.resize({ width: 320, quality: 'good' }).toJPEG(70).toString('base64');
      const displays = (res.displays || []).map((d) => `[${d.id}]${d.main ? ' main' : ''}${d.id === res.display ? ' (this one)' : ''} ${d.width}x${d.height}`).join(', ');
      return {
        text: `Screenshot of display ${res.display} (${res.width}x${res.height}px). Frontmost app: ${res.frontmost || 'unknown'}. Displays: ${displays}.`,
        image: 'data:image/jpeg;base64,' + res.image,
        thumb,
        sig: coarse(img),
      };
    },
  },
  {
    name: 'computer_click',
    risk: 'mac',
    icon: 'cursor',
    description: `Click on the ${PC} screen at pixel coordinates from the latest computer_screenshot.`,
    parameters: {
      type: 'object',
      properties: { ...XY, button: { type: 'string', enum: ['left', 'right'] }, clicks: { type: 'integer', description: '1 (default), 2 for double-click' } },
      required: ['x', 'y'],
    },
    label: (a) => `${a.clicks === 2 ? 'Double-click' : a.button === 'right' ? 'Right-click' : 'Click'} on your screen at (${Math.round(a.x)}, ${Math.round(a.y)})`,
    async run(a, ctx) {
      const p = toGlobal(ctx, a.x, a.y);
      await ctx.helper.request('click', { ...p, button: a.button || 'left', count: Math.min(3, Math.max(1, a.clicks || 1)) });
      await new Promise((r) => setTimeout(r, 300));
      return `Clicked at (${a.x}, ${a.y}). Take a new computer_screenshot to see the result.`;
    },
  },
  {
    name: 'computer_move',
    risk: 'mac',
    icon: 'cursor',
    description: 'Move the mouse to pixel coordinates from the latest computer_screenshot (e.g. to hover).',
    parameters: { type: 'object', properties: XY, required: ['x', 'y'] },
    label: (a) => `Move the mouse to (${Math.round(a.x)}, ${Math.round(a.y)})`,
    async run(a, ctx) {
      await ctx.helper.request('move', toGlobal(ctx, a.x, a.y));
      return 'Moved the mouse.';
    },
  },
  {
    name: 'computer_drag',
    risk: 'mac',
    icon: 'cursor',
    description: 'Drag with the left mouse button between two points from the latest computer_screenshot.',
    parameters: {
      type: 'object',
      properties: { from_x: { type: 'number' }, from_y: { type: 'number' }, to_x: { type: 'number' }, to_y: { type: 'number' } },
      required: ['from_x', 'from_y', 'to_x', 'to_y'],
    },
    label: (a) => `Drag from (${Math.round(a.from_x)}, ${Math.round(a.from_y)}) to (${Math.round(a.to_x)}, ${Math.round(a.to_y)})`,
    async run(a, ctx) {
      const from = toGlobal(ctx, a.from_x, a.from_y);
      const to = toGlobal(ctx, a.to_x, a.to_y);
      await ctx.helper.request('drag', { x1: from.x, y1: from.y, x2: to.x, y2: to.y });
      return 'Dragged.';
    },
  },
  {
    name: 'computer_scroll',
    risk: 'mac',
    icon: 'scroll',
    description: `Scroll at a point on the ${PC} screen (coordinates from the latest computer_screenshot).`,
    parameters: {
      type: 'object',
      properties: { ...XY, direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'integer', description: 'Lines to scroll (default 5)' } },
      required: ['x', 'y', 'direction'],
    },
    label: (a) => `Scroll ${a.direction} on your screen`,
    async run(a, ctx) {
      const p = toGlobal(ctx, a.x, a.y);
      const n = Math.min(50, Math.max(1, a.amount || 5));
      const dy = a.direction === 'up' ? n : a.direction === 'down' ? -n : 0;
      const dx = a.direction === 'left' ? n : a.direction === 'right' ? -n : 0;
      await ctx.helper.request('scroll', { ...p, dx, dy });
      return `Scrolled ${a.direction}.`;
    },
  },
  {
    name: 'computer_type',
    risk: 'mac',
    icon: 'keyboard',
    description: `Type text into whatever has keyboard focus on the ${PC}. Never use for passwords or payment details.`,
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    label: (a) => `Type “${String(a.text).slice(0, 30)}${String(a.text).length > 30 ? '…' : ''}” on your ${PC}`,
    detail: (a) => `Type into the focused app:\n${a.text}`,
    async run(a, ctx) {
      await ctx.helper.request('type', { text: String(a.text) }, 60_000);
      return 'Typed.';
    },
  },
  {
    name: 'computer_key',
    risk: 'mac',
    icon: 'keyboard',
    description: WIN
      ? 'Press a key or shortcut on the PC, e.g. "win", "ctrl+c", "alt+tab", "enter", "escape", "tab".'
      : 'Press a key or shortcut on the Mac, e.g. "cmd+space", "return", "cmd+shift+4", "escape", "tab".',
    parameters: { type: 'object', properties: { keys: { type: 'string' } }, required: ['keys'] },
    label: (a) => `Press ${a.keys} on your ${PC}`,
    async run(a, ctx) {
      await ctx.helper.request('key', { combo: String(a.keys) });
      await new Promise((r) => setTimeout(r, 200));
      return `Pressed ${a.keys}.`;
    },
  },
  {
    name: 'open_app',
    risk: 'mac',
    icon: 'app',
    description: WIN
      ? 'Open a Windows app by name, e.g. "Notepad", "File Explorer", "Calculator".'
      : 'Open (or bring to the front) a Mac app by name, e.g. "Notes", "Finder", "Calendar".',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    label: (a) => `Open ${a.name}`,
    async run(a) {
      const res = WIN
        ? await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', OPEN_WIN_APP], { env: { ...process.env, LUMIO_APP: String(a.name) }, windowsHide: true })
        : await run('/usr/bin/open', ['-a', String(a.name)]);
      if (res.failed) throw new Error(res.out || `Couldn't open "${a.name}".`);
      await new Promise((r) => setTimeout(r, 900));
      return `Opened ${a.name}.`;
    },
  },
  {
    name: 'list_apps',
    risk: 'read',
    icon: 'app',
    description: `List the apps that are running on the ${PC} and their windows.`,
    parameters: { type: 'object', properties: {} },
    label: () => 'Check running apps',
    async run(_a, ctx) {
      const res = await ctx.helper.request('apps');
      const wins = new Map();
      for (const w of res.windows || []) {
        if (!wins.has(w.owner)) wins.set(w.owner, []);
        if (w.title) wins.get(w.owner).push(w.title);
      }
      return (res.apps || []).map((a) => {
        const titles = wins.get(a.name) || [];
        return `${a.active ? '* ' : '  '}${a.name}${a.hidden ? ' (hidden)' : ''}${titles.length ? ` — windows: ${titles.slice(0, 5).map((t) => `"${t}"`).join(', ')}` : ''}`;
      }).join('\n') + '\n(* = frontmost)';
    },
  },
  {
    name: 'run_shell',
    risk: 'shell',
    icon: 'terminal',
    description: WIN
      ? 'Run a PowerShell command on the PC (in the home folder, 60s timeout) and return its output. Good for files, folders and system info.'
      : 'Run a zsh command on the Mac (in the home folder, 60s timeout) and return its output. Good for files, folders and system info.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' }, explanation: { type: 'string', description: 'One short sentence for the user: what this does and why' } },
      required: ['command', 'explanation'],
    },
    label: (a) => a.explanation || 'Run a command',
    detail: (a) => `${a.explanation || ''}\n\n$ ${a.command}`,
    async run(a) {
      const res = WIN
        ? await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', String(a.command)], { windowsHide: true })
        : await run('/bin/zsh', ['-lc', String(a.command)], { env: { ...process.env, PATH } });
      return { text: `$ ${a.command}\n${res.out || '(no output)'}\n[${res.status}]`, summary: res.status };
    },
  },
  {
    name: 'run_applescript',
    risk: 'shell',
    icon: 'terminal',
    description: 'Run AppleScript with osascript, to script Mac apps (Finder, Mail, Calendar, Music, System Events…).',
    parameters: {
      type: 'object',
      properties: { script: { type: 'string' }, explanation: { type: 'string', description: 'One short sentence for the user: what this does and why' } },
      required: ['script', 'explanation'],
    },
    label: (a) => a.explanation || 'Run AppleScript',
    detail: (a) => `${a.explanation || ''}\n\n${a.script}`,
    async run(a) {
      const res = await run('/usr/bin/osascript', ['-e', String(a.script)]);
      return { text: `${res.out || '(no output)'}\n[${res.status}]`, summary: res.status };
    },
  },
];

module.exports = { tools, toGlobal };
