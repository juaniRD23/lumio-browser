// Renders build/icon.svg to a 1024px PNG with Electron (offscreen), then
// makes build/icon.icns with sips + iconutil. Run: npx electron build/make-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  win.webContents.setZoomFactor(1);
  await win.loadURL('data:text/html,' + encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const png = img.resize({ width: 1024, height: 1024 }).toPNG();
  fs.writeFileSync(path.join(__dirname, 'icon-1024.png'), png);
  const set = path.join(__dirname, 'icon.iconset');
  fs.rmSync(set, { recursive: true, force: true });
  fs.mkdirSync(set);
  for (const size of [16, 32, 128, 256, 512]) {
    execFileSync('sips', ['-z', String(size), String(size), 'icon-1024.png', '--out', `${set}/icon_${size}x${size}.png`], { cwd: __dirname, stdio: 'ignore' });
    execFileSync('sips', ['-z', String(size * 2), String(size * 2), 'icon-1024.png', '--out', `${set}/icon_${size}x${size}@2x.png`], { cwd: __dirname, stdio: 'ignore' });
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(__dirname, 'icon.icns')]);
  fs.rmSync(set, { recursive: true, force: true });
  console.log('wrote build/icon.icns');

  // Windows .ico: PNG images at the standard sizes (Vista+ reads PNG entries).
  const { nativeImage } = require('electron');
  const master = nativeImage.createFromBuffer(fs.readFileSync(path.join(__dirname, 'icon-1024.png')));
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = sizes.map((n) => master.resize({ width: n, height: n, quality: 'best' }).toPNG());
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((n, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(n >= 256 ? 0 : n, e);
    header.writeUInt8(n >= 256 ? 0 : n, e + 1);
    header.writeUInt8(0, e + 2);
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(pngs[i].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  fs.writeFileSync(path.join(__dirname, 'icon.ico'), Buffer.concat([header, ...pngs]));
  console.log('wrote build/icon.ico');
  app.quit();
});
