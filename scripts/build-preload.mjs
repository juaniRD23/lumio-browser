// Bundles the browser UI preload (sandboxed preloads can't require files).
// Run by `npm start`, the test launcher and packaging.
import { build } from 'esbuild';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

export async function buildPreload() {
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
