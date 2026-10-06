# Crash reports

Lumio can send crash reports, like Chrome's "Help improve Chrome". It's **off by default**. People turn it on in Settings › Privacy › Help improve Lumio, or on the last welcome screen.

## What gets sent

- **Minidumps** from Crashpad (Electron's `crashReporter`) when any Lumio process crashes. Each one carries these annotations: `version`, `platform`, `arch`, `channel` (`stable`, `beta`, or `dev` when running from source), `_productName: Lumio Browser` and `_companyName: Lumio`, plus Electron's own fields (`process_type`, `ver`, `guid`, ...). A minidump is a snapshot of the crashed process, so it can contain bits of what was in memory. The Settings text and the privacy page say so.
- **JSON reports** from `main/crash-reports.js`:
  - JavaScript errors in the main process (`uncaughtException`, `unhandledRejection`). The stack keeps Lumio's own file paths (`main/tabs.js:183:7`). Other paths, web addresses, host names, IP addresses, long tokens, emails and quoted text are removed (host-shaped code like `tab.view` goes too; the stack still points at the bug).
  - Pages and helper processes that died (`render-process-gone`, `child-process-gone`), by kind (`page`, `ui`, `extension`, `gpu-process`, `utility`), reason and exit code. A page's address and title are never sent.

The setting is read from `settings.json` before the app is ready, because Crashpad can only start then. So turning it **on** takes effect at the next launch. Turning it **off** stops uploads right away (`crashReporter.setUploadToServer(false)`). When running from source (`npm start`), reports go only to a server set with `LUMIO_ACCOUNT_BASE`, never to the live one.

## Server

`POST /api/crash` (`server/src/crashes.ts`) needs no account. It accepts Crashpad's multipart upload (gzipped or not) and the JSON reports, with these limits:

- 4 MB per upload as sent, 8 MB once unzipped.
- 20 tries per IP per hour, counting refused ones (an IPv6 address counts as its /64). The IP is stored as a hash salted with the day and cleared after a day.
- Kept dumps: 5 a day per IP, and 1000 (1 GB) a day across all users. Past that, the report is counted but its dump isn't stored.
- Crashpad's `guid` (the install's ID) is never stored. Crashpad also writes it into the minidump, so the server zeroes that copy before the dump goes to R2.

Dumps go to R2 (`FILES`) at `crashes/<date>/<id>.dmp`. A row goes in the D1 table `crashes`. Everything is deleted after 90 days by the cron job. The owner's `/admin` page has a **Crashes** section that groups reports by version and signature, lists the latest ones and links each minidump (`GET /api/admin/crashes/:id/dump`).

A dump's signature comes from the minidump itself, without symbols: the exception plus module and offset, for example `EXC_BAD_ACCESS in Electron Framework+0x2a3f10`. The same bug in the same version groups together.

## One-time steps for the owner

1. Create the table: `cd server && npx wrangler d1 execute lumio --remote --file migrations/2026-10-05-crashes.sql`
2. Deploy the Worker as usual (`npx wrangler deploy`). No new secrets or bindings are needed, because it uses the existing `DB` and `FILES`.
3. Bump the "Last updated" date on `website/public/privacy.html`, which now has a Crash reports paragraph.

## Reading a minidump

Download it from /admin. Then get the matching Electron symbols for that platform: `electron-v<electron>-<platform>-<arch>-symbols.zip` from Electron's GitHub release, where `<electron>` is the `electron` version in `package.json` at that Lumio release's tag. Symbolize with Breakpad's `minidump_stackwalk dump.dmp symbols/` or the `electron-minidump` npm tool. Lumio's own JavaScript errors arrive as JSON with readable stacks and don't need any of this.
