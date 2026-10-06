# E2E fixes — fixer A (dialogs, pop-ups, external links, lifecycle; security and site controls)

Branch `e2e-fix-a`, based on `merge-v0.6.8` at e038778. Covers the 20 failures in fixer A's group from Mac CI run 37401840855 (bf72189).

## How this was checked
- `npm test`: 900 pass, 0 fail, 6 skipped. One run had a single failure in "the media popover" (`tests/page-tools-ui.test.mjs`), which this branch doesn't touch; it passed when re-run.
- These e2e tests turn out to run here on **Linux** Electron 43.7.7. Command: `env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a node --test tests/e2e/<file>`. The proxy has to be unset or Chromium sends the test hosts through the sandbox proxy. These runs are not Mac runs; Mac-only behaviour can still differ.
- Results of the five files on the final branch:

| File | Linux result |
|---|---|
| dialogs | 13/13 |
| lifecycle | 8 pass, 1 Windows-only skip |
| security | 19 pass, 1 skip (Password Checkup needs safeStorage, which Linux lacks here) |
| popups | 10/11. Window management fails because Chromium on Linux refuses `getScreenDetails()` before Lumio is asked. |
| site-controls | 10/12. Tests 2 and 8 fail identically at the untouched base e038778 on Linux, pass on the Mac in CI, and are not in this group. |

## Fixes outside a single test
- `scripts/launch.mjs`: dialogs.e2e.mjs was reported failed as a whole even when every test in it passed. The cause was the "Test hook before … `Page.handleJavaScriptDialog`: No dialog is showing" unhandled rejections, also in the CI log. Playwright auto-dismisses every JavaScript dialog when nothing listens, and Lumio had already answered them. The launcher now registers a no-op `app.context().on('dialog')`, so Lumio alone answers.
- `L.shot` now has the same 30 s limit as every other launcher call.
- `snapshot()` skips any view whose capture takes more than 3 s (see dialogs :132).

## Dialogs
### dialogs.e2e.mjs:132 — alert, confirm and prompt (180 s timeout)
- Category: 1 (screenshot helper hang) + 3 (cleanup)
- Root cause: every launcher call has a 30 s cap except `L.shot`; the test hung in `shot('70-confirm')`: `snapshot()` calls `capturePage()` on the tab's view while the page is blocked in `confirm()`; with the merged layout resizing the view, the capture never settles. (70-confirm.png only exists because the timed-out body kept running until the next test navigated the tab.) The "Page.handleJavaScriptDialog: No dialog is showing" lines come from Playwright auto-dismissing dialogs Lumio already answered (fixed in the launcher, see above).
- Fix: `snapshot()` caps each view's capture at 3 s and skips a view that doesn't answer; it now also paints the dialog view (so 70-confirm shows the dialog); `L.shot` gets the same 30 s cap as other calls; the test closes any leftover dialog in a finally.
- Confidence: medium-high — matches the timing and log; the "frozen page + resize" mechanism is inferred, but no capture can hang anymore whatever the cause. Passes on Linux, with 70-confirm.png written.
- Files: main/main.js, scripts/launch.mjs, tests/e2e/dialogs.e2e.mjs

### dialogs.e2e.mjs:360 — bad certificate, "went past it"
- Category: 2 (test out of date with the merged layout)
- Root cause: screenshot 74-cert-warning.png shows "Proceed to … (unsafe)" below the visible page area after Advanced (the merged layout's bookmarks-bar hint and AI panel shorten the page). `clickPage` computed a point outside the view so the trusted click hit nothing. cert-errors.js itself is fine.
- Fix: `clickPage` scrolls its target into view before the real mouse down/up (still a trusted click; no check weakened).
- Confidence: high — the screenshot shows the link out of view; passes on Linux.
- Files: tests/e2e/dialogs.e2e.mjs


## Lifecycle
### lifecycle.e2e.mjs:93 — full-screen notice separator
- Category: 2 (test never matched how the product draws it)
- Root cause: the "·" is drawn by CSS (`#n-action::before { content: '·' }`, renderer/ui/notice.css); `innerText` never includes generated content.
- Fix: the test's `notice()` builds the text from `#n-title`, the computed `::before` content of `#n-action`, and `#n-action`; still checks the separator for a named site and none on the cursor notice.
- Confidence: high — verified on Linux Electron under xvfb; computed-style read is platform-independent.
- Files: tests/e2e/lifecycle.e2e.mjs

### lifecycle.e2e.mjs:160 and :178 — "Cannot read properties of undefined (reading 'items')"
- Category: 2 (API changed by the profiles merge, batch 7a)
- Root cause: `global.lumio.profiles` now also exposes `registry`, `loaded`, `guest`, `list`, `open`… (main.js); the test's `stopDownloads` iterated `Object.values()` and read `.downloads.items` on them, throwing in each test's finally.
- Fix: cancel downloads only on `P.normal`, `P.incognito` and `global.__incProfile`; rest of both tests checked against the merged API.
- Confidence: high — both pass end to end on Linux under xvfb; quit message text is chosen per platform by the test.
- Files: tests/e2e/lifecycle.e2e.mjs

## Pop-ups (popups.e2e.mjs)
Shared root causes found in popups.e2e.mjs:
- **A (cat. 1):** `PopupWin` passed `app.store`, gone since batch 7a made services per profile; every pop-up's `tabs.state()` threw in `zoomShown`, so its bar never got `popup:init` and title/favicon/visits threw. Fix: `store: profile.store` (main/popup-window.js).
- **B (cat. 1, Electron 43):** `new WebContentsView({ webContents: made })` resets the page's preferences unless they're passed along (reproduced in a bare window): pop-up pages lost Lumio's preload and `disableDialogs`, so `confirm()` was Electron's own box. Fix: `ensureView` passes `webPreferences: { ...PAGE_PREFS }` with the made page (main/tabs.js).
- **C (cat. 1):** a page moved from a pop-up into a tab that calls `window.close()` didn't close its tab: by `destroyed` the view has dropped its webContents, so `tab.view?.webContents === wc` was false. The dead tab stayed, `state()` threw on `t.view.webContents.id` (20× in the CI log) and every later `navigate()` failed with "reading 'loadURL'". Fix: treat a view with no webContents as this tab's page; `state()` null-safe (main/tabs.js). Unit test: a tab whose page was swapped for a new one is kept.
- **D (cat. 1):** a tab kept its click activation across navigations; a frame's click reported late (after its pop-up used it) let an ad on the next page open a tab. Fix: clear `activatedAt`/`frameActivatedAt` on main-frame navigation, like Chrome (main/tabs.js).
- **E (cat. 2, test):** `sendInputEvent` only reaches the page's own process, never a cross-site frame. Fix: the test clicks via DevTools' `Input.dispatchMouseEvent` (`wc.debugger`), detached in a finally.
- **F (cat. 2, test):** `executeJavaScript` waits for a load that a pop-up whose page never arrives (204) never gets. Fix: `inPopup` runs in `mainFrame`.
Files: main/popup-window.js, main/tabs.js, tests/e2e/popups.e2e.mjs, tests/popups.test.mjs (unit tests 15/15).

| Test | Category | Root cause → fix | Confidence (Mac) |
|---|---|---|---|
| :171 frame click, first and next | 2 (+1) | E (+ D for "next") | medium-high — the DevTools click is how Chromium routes real mouse input; not checkable on a Mac here |
| :199 ad frame blocked | 1 | D | medium-high — passed every Linux run after the fix |
| :207 sized pop-up's bar | 1 | A | high for the bar fix; one unexplained Linux failure in ~11 runs |
| :226 opener writes into about:blank | 1 + 2 | A + F | high |
| :236 dialogs/prompts in the pop-up | 1 | A + B (B explains Mac's `confirm()` failure) | high |
| :256 "Open in tab" | 1 + 3 | A + C; cleanup force-closes any leftover tab in a finally | high |
| :270 Open <App>?, :306 mailto, :333 Save Link As… | 3 | cascade from C ("reading 'loadURL'") | high — pass on Linux |
| :402 window management | 3 | cascade from C on the Mac | medium — on Linux Chromium denies `getScreenDetails()` itself before Lumio is asked (batch 2's original test fails the same way there), so the rewritten chip/bubble version can't be verified here |

## Security
### security.e2e.mjs:320 — dangerous downloads: a misleading name waits for Keep or Discard
- Category: 1 (product bug — also a real security gap)
- Root cause: `item.pause()` inside `will-download` doesn't hold a small file: it arrives whole and completes under its real name with no warning; `plain()` drops `danger` once the state isn't 'progressing', so the test saw null. Reproduced on Linux Electron 43.
- Fix (main/features.js): like Chrome's "Unconfirmed … .crdownload", a risky download is saved under a temporary name and stays 'progressing'/paused until Keep (renamed to its real name, completed) or Discard/cancel/remove/end of Incognito (deleted). New `finish()`/`stop()` helpers. Test: "it waits" checks `paused`, the warning, and that nothing exists under the real name (instead of Chromium's unreliable `isPaused()`); the page is reloaded before the second download so batch 2's "automatic downloads" prompt doesn't hold it. New unit test in tests/security.test.mjs.
- Note: a risky download now skips the "ask where to save" dialog (it is saved to the downloads folder once kept).
- Confidence: high — passes on Linux Electron; the mechanism isn't Mac-specific.
- Files: main/features.js, tests/e2e/security.e2e.mjs, tests/security.test.mjs

### security.e2e.mjs:348 — a file sent over http from a secure page waits too
- Category: 1 — same root cause and fix as above.
- Confidence: high — passes on Linux (listed as kind 'insecure', paused).

### security.e2e.mjs:402 — secure DNS: "D is not defined"
- Category: 2 (test bug: a test-side constant used inside a function serialised into the main process)
- Fix: pass the custom DNS URL in as the argument.
- Confidence: high — passes on Linux.
- Files: tests/e2e/security.e2e.mjs

### security.e2e.mjs:424 — capture indicators: red dot and tooltip
- Category: 2 (batch 3's hover cards replaced the tab's `title` tooltip; the words now live in `.rec-dot`'s aria-label and the tab's `aria-description`, renderer/ui/shell.js)
- Fix: the test checks the dot is visible and both carry "Using your camera".
- Confidence: high — passes on Linux; renderer logic isn't platform-specific.
- Files: tests/e2e/security.e2e.mjs

### security.e2e.mjs:485 — Password Checkup: "this.store.list is not a function"
- Category: 1 (merge bug: the batch-7a merge handed Security a stand-in front-profile password store with only `entries` and `secret()`; `PasswordCheckup.summary()` also uses `list()`/`get()`, so every checkup threw — e2e, Passwords page and Safety check)
- Fix (main/main.js): the stand-in also forwards `list` and `get` to the front profile's store.
- Confidence: high — the e2e test skips on Linux (no safeStorage), but a node harness with the real PasswordStore/PasswordCheckup and the same stand-in shape runs `run()`, `summary()`, `flags()`.
- Files: main/main.js

## Site controls
### site-controls.e2e.mjs:253 — data on exit leaves 'localhost'
- Category: 4 (CI timing)
- Root cause: both pages are titled "Cookie set", so `go(b/set-plain, 'Cookie set')` returned at once while the 127.0.0.1 page was still showing; `clearSessionData` ran before localhost set its cookie (on the Mac localhost tries ::1 first, so it is slower). The delete-on-exit logic is fine (a standalone Electron 43.7.7 check: `clearData` with `excludeOrigins` removes localhost's cookie and keeps 127.0.0.1's; `exitPlan` is unit-tested).
- Fix: wait until both sites' cookies exist before deleting; same reader for the final check; `reset()` moved into finally.
- Confidence: high — now waits on the real cookie, not the title; passes on Linux.
- Files: tests/e2e/site-controls.e2e.mjs

## Noticed, not changed (outside this group)
- The `certificate-error` handler in `main/main.js` calls `callback` again after `main/security.js`'s test-certificate handler has answered. This causes the many "One-time callback was called more than once" lines in the Mac log. It is harmless because the first answer wins.
