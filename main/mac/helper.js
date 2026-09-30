// Client for the computer-control helper. On macOS it's the native Swift
// helper (native/LumioHelper); on Windows, a PowerShell script with the same
// protocol (native/windows/lumio-helper.ps1). Both run as a child process and
// speak JSON lines: {id, cmd, ...args} -> {id, ok, ...result}.
// Running inside the app bundle, macOS credits its permissions to Lumio Browser.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const WIN = process.platform === 'win32';

function helperPath() {
  const name = WIN ? 'lumio-helper.ps1' : 'lumio-helper';
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, name);
    if (fs.existsSync(packaged)) return packaged;
  }
  return WIN
    ? path.join(__dirname, '..', '..', 'native', 'windows', name)
    : path.join(__dirname, '..', '..', 'native', 'bin', name);
}

function helperCommand() {
  return WIN
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath()]]
    : [helperPath(), []];
}

class MacHelper {
  constructor() {
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
  }

  available() {
    return (process.platform === 'darwin' || WIN) && fs.existsSync(helperPath());
  }

  start() {
    if (this.proc) return;
    if (!this.available()) throw new Error(WIN ? 'The computer-control helper is missing.' : 'The Mac helper is not built yet. Run `npm run native` in the lumio-browser folder.');
    const [cmd, args] = helperCommand();
    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let nl;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl).replace(/^\uFEFF/, '');
        this.buffer = this.buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg); else p.reject(new Error(msg.error || 'Helper error'));
      }
    });
    proc.stderr.on('data', (d) => { if (process.env.LUMIO_DEBUG) process.stderr.write(`[helper] ${d}`); });
    const fail = (why) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.buffer = '';
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(why)); }
      this.pending.clear();
    };
    proc.on('exit', (code) => fail(`The helper exited (${code}).`));
    proc.on('error', (err) => fail(`The helper failed to start: ${err.message}`));
  }

  request(cmd, args = {}, timeout = 20_000) {
    this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The helper timed out on "${cmd}".`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
    });
  }

  stop() {
    if (this.proc) { this.proc.kill(); this.proc = null; }
  }
}

const ComputerHelper = MacHelper;
module.exports = { MacHelper, ComputerHelper, helperPath };
