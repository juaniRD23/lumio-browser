// Publishes a Lumio Browser update. Every installed copy checks GitHub every
// hour, shows "What's new" with an Update button, and installs it in place.
//
// From GitHub (no Mac needed): Actions → "Release Lumio Browser" → Run workflow
//   (version, what's new, urgent). It runs this script on a Mac runner.
// From this Mac:
//   npm run ship -- --notes "Passkeys | Faster tabs"            next patch version
//   npm run ship -- 0.6.0 --notes "Big update" --critical       a chosen version, urgent
//
// Steps: check the version, run the tests, set package.json, build both Mac
// DMGs and the Windows ZIP, commit + tag + push, create the GitHub release
// with the notes (and the urgent marker), then check the files are live.
// In the workflow the same steps run as --prepare and --publish.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const REPO = 'juaniRD23/lumio-browser';
const ASSETS = ['Lumio-Browser-mac-apple-silicon.dmg', 'Lumio-Browser-mac-intel.dmg', 'Lumio-Browser-windows-x64.zip'];
const pkgFile = path.join(root, 'package.json');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const sh = (cmd, cmdArgs, opts = {}) => execFileSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit', ...opts });
const out = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { cwd: root, encoding: 'utf8' }).trim();

const SEMVER = /^\d+\.\d+\.\d+$/;
const older = (a, b) => { const x = a.split('.').map(Number); const y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i]; return false; };
const nextPatch = (v) => { const [a, b, c] = v.split('.').map(Number); return `${a}.${b}.${c + 1}`; };

// The version to release: the one asked for, or the next patch.
function chooseVersion(asked) {
  const current = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version;
  const version = (asked || '').trim().replace(/^v/, '') || nextPatch(current);
  if (!SEMVER.test(version)) throw new Error(`"${version}" isn't a version like 0.6.0.`);
  if (!older(current, version)) throw new Error(`${version} must be newer than ${current}.`);
  return { current, version };
}

// "Passkeys | Faster tabs" or several lines -> a Markdown list. Text that's
// already Markdown (lines starting with - or #) is kept as written.
function notesMarkdown(text, critical) {
  const raw = String(text || '').replace(/\r/g, '').trim();
  const items = raw.includes('\n') ? raw.split('\n') : raw.split(/\s+\|\s+/);
  const body = items.map((l) => l.trim()).filter(Boolean).map((l) => (/^([-*#]|\d+\.)\s/.test(l) ? l : `- ${l}`)).join('\n') || '- Fixes and improvements.';
  return `## What's new\n\n${body}\n${critical ? '\n<!-- lumio:critical -->\n' : ''}
## Install

- **Mac (Apple Silicon):** \`Lumio-Browser-mac-apple-silicon.dmg\`
- **Mac (Intel):** \`Lumio-Browser-mac-intel.dmg\`
- **Windows:** \`Lumio-Browser-windows-x64.zip\`

Already have Lumio Browser? It updates itself: click **Update** next to your profile picture.
`;
}

function setVersion(version) {
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
  // Keep the lockfile's own version in step, if it has one.
  const lockFile = path.join(root, 'package-lock.json');
  if (fs.existsSync(lockFile)) {
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if (lock.version) lock.version = version;
    if (lock.packages?.['']) lock.packages[''].version = version;
    fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
  }
}

function publish(version, notes, critical) {
  for (const a of ASSETS) if (!fs.existsSync(path.join(root, 'dist', 'release', a))) throw new Error(`Missing dist/release/${a}. Run npm run release first.`);
  const notesFile = path.join(root, 'dist', 'release', 'NOTES.md');
  fs.writeFileSync(notesFile, notesMarkdown(notes, critical));
  if (process.env.GITHUB_ACTIONS) {
    sh('git', ['config', 'user.name', 'github-actions[bot]']);
    sh('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  }
  sh('git', ['add', 'package.json', ...(fs.existsSync(path.join(root, 'package-lock.json')) ? ['package-lock.json'] : [])]);
  sh('git', ['commit', '-m', `Release v${version}`]);
  sh('git', ['tag', `v${version}`]);
  sh('git', ['push', 'origin', 'HEAD:main']);
  sh('git', ['push', 'origin', `v${version}`]);
  sh('gh', ['release', 'create', `v${version}`, ...ASSETS.map((a) => path.join('dist', 'release', a)), '--repo', REPO, '--title', `Lumio Browser ${version}`, '--notes-file', notesFile]);
  // Every installed copy reads releases/latest: make sure it's this one, with checksums.
  const latest = JSON.parse(out('gh', ['api', `repos/${REPO}/releases/latest`]));
  const ok = latest.tag_name === `v${version}` && ASSETS.every((a) => latest.assets.some((x) => x.name === a && /^sha256:/.test(x.digest || '')));
  if (!ok) throw new Error('The release is up, but GitHub isn’t showing it as the latest with all three files yet. Check the Releases page.');
  console.log(`\n✓ Lumio Browser ${version} is out. Installed copies will offer it within the hour.\n  ${latest.html_url}`);
}

try {
  if (flag('--prepare')) {
    // Workflow step 1: pick and set the version (written for later steps).
    const { current, version } = chooseVersion(args[args.indexOf('--prepare') + 1]?.startsWith('--') ? '' : args[args.indexOf('--prepare') + 1]);
    setVersion(version);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
    console.log(`Releasing ${version} (was ${current}).`);
  } else if (flag('--publish')) {
    // Workflow step 3 (after npm run release).
    const version = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version;
    publish(version, process.env.NOTES || value('--notes'), process.env.CRITICAL === 'true' || flag('--critical'));
  } else {
    // Everything, from this Mac.
    const asked = args.find((a) => SEMVER.test(a.replace(/^v/, '')));
    const notes = value('--notes');
    if (!notes) throw new Error('Say what’s new: npm run ship -- --notes "First change | Second change"');
    if (out('git', ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') throw new Error('Switch to the main branch first.');
    if (out('git', ['status', '--porcelain'])) throw new Error('Commit or stash your changes first (git status isn’t clean).');
    sh('git', ['pull', '--ff-only', 'origin', 'main']);
    const { current, version } = chooseVersion(asked);
    console.log(`Releasing ${version} (was ${current})…`);
    sh('npm', ['test']);
    setVersion(version);
    try { sh('npm', ['run', 'release']); } catch (err) { sh('git', ['checkout', '--', 'package.json', 'package-lock.json']); throw err; }
    publish(version, notes, flag('--critical'));
  }
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
}
