// Publishes a Lumio Beta build: the next version, as "0.6.7-beta.1", "-beta.2"…,
// on a GitHub pre-release. Only Lumio Beta (a separate app) installs these;
// Lumio Browser and the website's download links only see full releases.
// Run by .github/workflows/beta.yml:
//   node scripts/beta.mjs --prepare   → sets package.json's version (not committed), prints it
//   node scripts/beta.mjs --publish   → creates the pre-release with the Lumio Beta DMGs
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'juaniRD23/lumio-browser';
const ASSETS = ['Lumio-Beta-mac-apple-silicon.dmg', 'Lumio-Beta-mac-intel.dmg'];
const pkgFile = path.join(root, 'package.json');
const out = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8' }).trim();

// The next full version (one patch after the current one) and the next beta number for it.
export function nextBeta(current, tags) {
  const [a, b, c] = current.split('-')[0].split('.').map(Number);
  const base = current.includes('-') ? current.split('-')[0] : `${a}.${b}.${c + 1}`;
  const taken = tags.map((t) => new RegExp(`^v${base.replace(/\./g, '\\.')}-beta\\.(\\d+)$`).exec(t)?.[1]).filter(Boolean).map(Number);
  return `${base}-beta.${Math.max(0, ...taken) + 1}`;
}

function notes(text, version) {
  const raw = String(text || '').replace(/\r/g, '').trim();
  const items = (raw.includes('\n') ? raw.split('\n') : raw.split(/\s+\|\s+/)).map((l) => l.trim()).filter(Boolean);
  return `## What's new in this beta\n\n${items.map((l) => (/^[-*]\s/.test(l) ? l : `- ${l}`)).join('\n') || '- Changes to try before the next release.'}\n
## Install

Lumio Beta is a separate app for trying new versions first. It keeps its own profile and doesn't touch your normal Lumio Browser.

- **Mac (Apple Silicon):** \`Lumio-Beta-mac-apple-silicon.dmg\`
- **Mac (Intel):** \`Lumio-Beta-mac-intel.dmg\`

Already have Lumio Beta? It updates itself to ${version}: click **Update** next to your profile picture.
`;
}

if (process.argv.includes('--prepare')) {
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  out('git', ['fetch', '--tags', '--quiet']);
  const version = nextBeta(pkg.version, out('git', ['tag', '-l', 'v*-beta.*']).split('\n').filter(Boolean));
  pkg.version = version;
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`Lumio Beta ${version}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}

if (process.argv.includes('--publish')) {
  const version = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version;
  if (!/-beta\.\d+$/.test(version)) throw new Error(`${version} isn't a beta version.`);
  const files = ASSETS.map((a) => path.join(root, 'dist', 'release', a));
  for (const f of files) if (!fs.existsSync(f)) throw new Error(`Missing ${path.basename(f)}.`);
  const notesFile = path.join(root, 'dist', 'beta-notes.md');
  fs.writeFileSync(notesFile, notes(process.env.NOTES, version));
  const sha = process.env.GITHUB_SHA || out('git', ['rev-parse', 'HEAD']);
  execFileSync('gh', ['release', 'create', `v${version}`, ...files, '--repo', REPO, '--prerelease', '--target', sha, '--title', `Lumio Beta ${version}`, '--notes-file', notesFile], { cwd: root, stdio: 'inherit' });
  console.log(`https://github.com/${REPO}/releases/tag/v${version}`);
}
