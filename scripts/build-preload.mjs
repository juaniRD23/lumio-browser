// Bundles the browser UI preload (sandboxed preloads can't require files) and
// copies Lumio Chat's file code (making PDFs/Word/PowerPoint, reading
// attachments) into the panel, so both use the same code.
// Run by `npm start`, the test launcher and packaging.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const WEB = ['docmaker.js', 'attach.js', 'vendor/marked.js', 'vendor/pdf.min.mjs', 'vendor/pdf.worker.min.mjs', 'vendor/pdfmake.min.js', 'vendor/vfs_fonts.js', 'vendor/docx.iife.js', 'vendor/pptxgen.bundle.js'];
function copyWeb() {
  const from = path.join(root, 'website', 'public');
  const to = path.join(root, 'renderer', 'ui', 'web');
  for (const f of WEB) {
    fs.mkdirSync(path.dirname(path.join(to, f)), { recursive: true });
    fs.copyFileSync(path.join(from, f), path.join(to, f));
  }
}

export async function buildPreload() {
  copyWeb();
  await build({
    entryPoints: [path.join(root, 'preload', 'shell.js')],
    outfile: path.join(root, 'preload', 'dist', 'shell.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
    logLevel: 'warning',
  });
}

if (import.meta.url === `file://${process.argv[1]}`) await buildPreload();
