# Batch 8 (crash reports + DRM readiness) — result

Branch: `batch8-crash-drm` (pushed there; no PR, tag or release created).

## Items
- **Crash reports (opt-in): app, server, /admin.** Done (by earlier agents), reviewed and hardened in this run.
- **DRM readiness (castlabs, behind `LUMIO_DRM` / EVS secrets).** Done (by earlier agents), reviewed and fixed in this run. The normal build is unchanged: stock Electron, the same signing steps, and the workflow DRM steps skip without the secrets.
- **Tests.** Done (by earlier agents), plus the new tests listed below.
- **1. Skeptical review, then fix.** Done. A fresh subagent reviewed every feature by reading the code. I rendered the new UI in headless Chrome, light and dark, and looked at it. The screenshots are in `dist/review-shots/` (not committed): crash Settings, welcome, /admin, DRM Settings card and DRM waiting window. All looked right, and the /admin XSS probe showed escaped.

## Review findings
No high-severity problems.

| # | Severity | Finding | Fixed |
|---|---|---|---|
| 1 | Medium | JSON crash reports could carry bare host names (`getaddrinfo ENOTFOUND mybank.example.com`), IP addresses and tokens. The scrubber only removed `scheme://` URLs. | **Yes.** Both the app (`main/crash-reports.js`, `cleanMessage`) and the server (`scrubHosts`) now replace hosts, IPv4/IPv6 addresses and long tokens. On the server this covers the message and the stack's non-frame lines and frame locations. Function names in frames are kept. |
| 2 | Medium | `/api/crash` could be abused: refused requests weren't counted, so the Worker could be made to unzip 16 MB over and over; IPv6 rotation inside a /64 escaped the per-IP limit; junk could fill R2 (up to about 16 GB a day) and use up the 1000-dumps-a-day cap; count-then-insert raced. | **Yes.** A new `crash_attempts` table records every attempt before the count, so parallel requests see each other. 20 tries an hour per IP, refused ones included. IPv6 counts by its /64. Dumps are limited to 8 MB unzipped (4 MB as sent), 5 kept dumps per IP a day, and 1000 dumps or 1 GB a day in total; past that the row is kept and the dump dropped. Attempts are cleared after a day by the existing cron. |
| 3 | Low | The IP hash is a plain SHA-256 with no secret, so IPv4 addresses can be recovered by brute force from a database copy. | **No.** The fix needs a Worker secret (HMAC), and this run must not add secrets. Hashes are already cleared after a day. Suggestion: add a `CRASH_IP_SECRET` Worker secret and HMAC with it. |
| 4 | Low | A `second-instance` launch during the DRM wait (up to 15 s) can create a window before IPC and the menu exist. This race already existed during the 4 s extensions wait. | **No.** It mainly matters on Windows (paused), and the fix touches the startup code that b7a (profiles) rewrites. Easiest after merging: queue `second-instance` URLs in `pendingUrls` until startup finishes. |
| 5 | Low | The workflows ran `pip install castlabs-evs` in the same step as the EVS password. | **Partly.** The install is now its own step without the password. The version isn't pinned, because I couldn't confirm a current version here. Pin it once you've installed it locally. |
| 6 | Low | `LUMIO_DRM=false`/`no` turned DRM off in `build/drm.mjs` but not in the workflows' `HAS_EVS` guard. | **Yes.** The workflows use `!contains(fromJSON('["0","false","no"]'), vars.LUMIO_DRM)`. The docs and a test cover it. |
| 7 | Low | The welcome screen's switch was named only "Help improve Lumio". | **Yes.** Its `aria-label` is now "Send crash reports to Lumio". |
| 8 | Low | The DRM waiting window's `role="status"` wrapped the Open now button. | **Yes.** The status region is now only the text. |
| 9 | Low | Running from source with the setting on sent crash reports to the live server. | **Yes.** An unpackaged app only starts reporting when `LUMIO_ACCOUNT_BASE` is set, as the e2e tests do. |

I also tried to trim the Settings card text, which repeats "next time you open Lumio", but reverted it. While the switch is off, that sentence is the only place that says turning it on waits for the next launch, and the test that checks for it is right.

## Not done
- Low findings 3 and 4, and pinning the EVS client (5), as explained above.
- Nothing ran in Electron or e2e (CI only). The real castlabs build, VMP signing and playback still need your EVS account (see `docs/drm.md`).

## Tests
- `npm test` (root, includes the server tests): **225 tests, 220 pass, 0 fail, 5 skipped.** The skips are Mac-only or Windows-only tests: Safari import, disk-image install, 3 Windows helper tests. Before this run it was 221 / 216 / 0 / 5.
- `npm test` in `server/`: **59 of 59 pass**, up from 55 before this run.
- Tests added in this run:
  - `server/test/crash.test.mjs`:
    - "refused reports count against the limit too, and an IPv6 /64 counts as one IP"
    - "ipKey"
    - "one IP keeps at most 5 dumps a day; past that the report is still counted"
    - "past 1 GB of dumps a day from everyone, dumps aren’t kept"
    - host, IP and token checks in "scrub and signatures"
  - `tests/crash-reports.test.mjs`: host, IP and token checks for `cleanMessage`.
  - `tests/drm.test.mjs`: every `LUMIO_DRM` off value, and the wait window's status region.
- E2E tests in this batch (written by earlier agents, unchanged, CI only):
  - `tests/e2e/crash-reports.e2e.mjs`:
    - off by default
    - welcome switch
    - only Settings and welcome can change it
    - on: Crashpad annotations
    - main-process error JSON
    - dead page by kind and reason
    - turning off stops uploads
    - main-process crash uploads a minidump
  - `tests/e2e/drm.e2e.mjs`:
    - normal build has no wait and no card
    - DRM first launch waits, then shows Ready
    - Open now skips the wait
    - Esc skips the wait

## Risky
- **Over-scrubbing:** the host scrubbing also removes code like `tab.view is not a function` from messages. The stack still locates the bug, which was the safer trade.
- **Migration changed before its first run:** `migrations/2026-10-05-crashes.sql` now also adds the `crash_attempts` table and the `crashes.dump_bytes` column. It hasn't been run remotely yet, so run it once as `docs/crash-reports.md` says. If an earlier version was already applied somewhere, add the column with `ALTER TABLE crashes ADD COLUMN dump_bytes INTEGER NOT NULL DEFAULT 0` and run the `crash_attempts` statements.
- **No new runtime dependencies.**

## Merge hints
Shared files changed in this batch, all small:
- `main/main.js`: crash/DRM setup lines near the top, 3 `internalHandle` lines, and `await drm.whenReady()` before `registerIpc()`. With b7a's `startProfile()`, move the await to just after `await p.ready;`.
- `main/ai/tools/browser.js`: the AI is also kept off `lumio://welcome`.
- `renderer/pages/settings.html` and `settings.css`: the "Help improve Lumio" card and 2 script tags. b6 (privacy) changes `#site-list`; the DRM card places itself under either layout.
- `renderer/pages/welcome.html` and `welcome.css`.
- `server/src/index.ts`, `server/schema.sql`.
- `.github/workflows/release.yml` (Mac job) and `beta.yml`.
- `website/public/admin.*`, `app.css`, `privacy.html` ("Last updated" date not bumped).
