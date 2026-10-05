batch2-launch-blockers

# Batch 2 (launch blockers): result of the review phase

## Items
- **1. Skeptical review, then fix: DONE.** Three reviewers read the batch, one each for dialogs, certificates/links/pop-ups and lifecycle. I fixed every high and medium finding and most low ones (table below).
- **Known bug: the full-screen notice's shadow was clipped: DONE.**
  - The interrupted review had already started the fix (in the WIP commit). The view now leaves room around the bubble (`PAD` in `main/access-notice.js`), and `notice.css` places the bubble to match.
  - I checked it: rendered at the real view size in light and dark (`dist/batch2-shots/notice-inview-*.png`), the shadow fades out inside the view.
  - A reviewer also checked the numbers: under 1.5% of the shadow's alpha is left at the edges.
  - I also fixed narrow pop-ups, where the bubble could overflow its view: the site name now shortens with "…" and "Press Esc…" always stays whole.
- **Screenshots** of the dialog card, certificate page, notice and credits page, light and dark, are in `dist/batch2-shots/`; I looked at all of them and they look right. dist/ is ignored, so they are not committed; `LUMIO_SHOTS=dir node --test tests/dialog-ui.test.mjs tests/lifecycle-ui.test.mjs` makes them again.

## Review findings
H = high, M = medium, L = low.

| # | Sev | Finding | Fixed |
|---|-----|---------|-------|
| D1 | M | A "Leave" whose navigation never happened (it became a download, a 204 or was stopped) left `allowUnload` on. A later close then skipped "Leave site?" and unsaved work was lost. | yes: it is now a timestamp that only counts for `LEAVE_MS` |
| D2 | M | `catchLeave` outlived its page, so a new, untouched page's own redirect got "Leave site?". | yes: `leftPage` clears it |
| D3 | M | A page asking for HTTP sign-in in a loop piled up unlimited cards, each holding a request. | yes: one pending card per proxy/host/port/realm, shared like Chrome |
| D4 | M | Lumio AI hung on a page frozen by an alert in another tab or pop-up that shares its process. | yes: `stopped()` and `dialogNote()` also check `dialogInProcess` |
| D5 | L | During quit or window close, an alert left in one tab could stall a tab sharing its process, which was then force-closed without asking. | yes: alerts are dismissed in every tab first |
| D6 | L | A stopped navigation kept `navigatingTo`, which widened who may ask for a sign-in. | yes |
| D7 | L | "Leave site?" for a navigation stayed up after the page crashed. | yes: it is dismissed, unless it is about closing the tab (new `spec.about`) |
| D8 | L | The AI's `close_tab` guessed after 400 ms. | yes: it waits up to 1.5 s for the tab to close or for the question to show |
| D9 | L | A tab a helper AI typed in asked "Leave site?" later. | yes: `touched` is reset when the helper lets go |
| D10 | L | A page can draw a look-alike of the dialog card, because the card sits fully inside the page area (Chrome's overlaps the toolbar). | no: design change, left for the owner |
| P1 | M | A click on the page let a frame from another site (an ad) open a pop-up, or launch or prompt for another app. | yes: the frame is found from the window.open `referrer`, and a frame from another site needs a click inside a frame (`frameActivatedAt`) |
| P2 | M | One click in a frame was reported about 12 times (every 400 ms while activation lasts), which allowed about 11 app launches. | yes: the preload reports only when activation turns on |
| P3 | M | App links from a new tab, or a pop-up with no page yet, were silently refused (for example "Join on Zoom" sending on to `zoommtg:`). | yes: they ask, even for mailto:, and never offer "Always allow" |
| P4 | M | Helper AI tabs could open pop-up windows or tabs in front. | yes: links go to background tabs only; no windows and no app links |
| P5 | L | A certificate exception ignored the error type, so a certificate you went past still passed after it was revoked. | yes: only errors you could have gone past are let through |
| P6 | L | Web pages could open `chrome://`, `devtools://`, other extensions' pages or `about:*` in a tab. | yes: web pages may only open http(s), blob and about:blank; an extension may open its own pages |
| P7 | L | The lumio:// navigation guard checked the frame's current URL, not who started the navigation (an opener could re-point a pop-up that was on the cert page; only a spoofed warning, Proceed stays hidden). | yes: uses `e.initiator.url` |
| P8 | L | An app link from window.open was credited to the top page, not the frame. | yes: uses the referrer |
| P9 | L | "Always allow pop-ups" could be saved for a site the page had navigated to after the list opened. | yes: only for the site the list was shown for |
| P10 | L | `features: 'noopener'` alone opened a pop-up window. | yes: only size, position or `popup` features make a pop-up |
| P11 | L | `window.open` with no features and `form target=_blank` open fresh tabs: no `window.opener`, and POST bodies are dropped (3-D Secure). | no: this predates the batch and needs `postData` plumbing in `create` |
| P12 | L | An AI click counts as the person's, so it can launch mailto: in the user's own tab. | no: accepted, noted |
| L1 | M | A failed update install left every window blank, because the pages had gone to sleep for the quit. | yes: the updater's new `stayed()` wakes them |
| L2 | M | A quit stopped by a window's "Leave site?" after `before-quit` left `quitting = true` for good: no session saves and no download warnings. | yes: `quitCancelled()` from both window close handlers; the update restart now quits through `app.quit()`, which asks about anything new |
| L3 | M | Mac: any page you had typed in interrupted logout, restart and shutdown. | yes: `powerMonitor` 'shutdown' skips the questions. Not verified in Electron: the order against macOS's terminate request is untested, so check it on CI or by hand |
| L4 | L | Cmd+Q and "Restart to update" could share one answer, so Lumio quit before the update was set up. | yes: the update doesn't ride on a question already being asked |
| L5 | L | Cancel on a later "Leave site?" reloads pages that already agreed; no tabs are lost. | no: Electron has no "beforeunload only" call, so this is a known trade-off |
| L6 | L | The notice view takes clicks in its area for about 4 s, and was attached before its page loaded. | partly: now attached only after load. A view can't pass clicks through |
| L7 | L | The first notice's timer started before its page drew. | yes: the timer starts on attach |
| L8 | L | The bubble overflowed narrow pop-ups. | yes (CSS) |
| L9 | L | Windows/Linux: two windows closing in the same tick skip the download warning. | no: Windows is paused |
| T1 | L | The notice-size UI test was racy: it compared the first report, made before the font loaded (this was the failure at the start). | yes |

Checked and fine (from the reviewers):
- Dialogs:
  - no spoofing across tabs, and answers are checked against the shown dialog;
  - every sync IPC gets an answer on close, crash, navigation or window close;
  - beforeunload asks once per user action;
  - credentials never reach logs, history or the session.
- Certificates: no way for a page, frame, other lumio page or the AI to force Proceed.
- Credits: rendered as text only, path traversal is blocked, and the Help menus and Settings row are wired.

## Tests
- `npm test` (root, includes `server/test`): **256 tests, 251 pass, 0 fail, 5 skipped** (Mac-only or Windows-only).
  - At the start: 253 tests. One run had 12 failures, probably Chrome cold-start timeouts; the steady result was 1 failure, the racy notice test.
  - I didn't touch the server.
- **New unit tests:**
  - `popups.test.mjs`: "a frame from another site needs a click of its own…" and "pages can't open browser-internal pages; …helper AI's tab…";
  - `updater.test.mjs`: "install: when installing fails after you agreed, the pages that went to sleep come back".
- **Updated unit tests:** `external-protocols`, `popups`, `tab-leave`, `lifecycle`, `lifecycle-ui`.
- **E2e added (not run here):** `tests/e2e/popups.e2e.mjs`: "a click on the page doesn't let a frame from another site (an ad) open a pop-up".
- **E2e to watch on CI** (behaviour changed):
  - "a click on a button in a frame from another site opens its pop-up, the first click and the next". It relies on Chromium consuming activation across the frame tree after `window.open`, so the second click reports again.
  - The lifecycle notice tests: the view is now attached after its page loads.

## Risks
- Nothing was run in Electron, by the rules. These rely on reading Electron's API:
  - the window-open `referrer` and `will-navigate`'s `e.initiator`;
  - powerMonitor 'shutdown' on macOS logout.
- If the referrer is missing (a `noreferrer` opener), the pop-up rule falls back to the old tab-wide rule.
- A page that focuses its own frame from another site right after a click can still pass its activation to that frame.

## Not done
- D10, P11, P12, L5, L9, and the rest of L6 (above).
- `docs/launch-plan.md` checkboxes.

## Merge hints (shared files I changed)
- `main/main.js`:
  - the `services` entry `quitCancelled`;
  - the updater options;
  - `wakeActiveTabs`;
  - powerMonitor at the top of `whenReady`;
  - `site:popups` / `site:popups-allow`;
  - the `user-activation` IPC;
  - `openExternalLink`;
  - `certificate-error`.
- `main/tabs.js`:
  - `setWindowOpenHandler`;
  - the lumio:// guard;
  - will-prevent-unload / will-navigate;
  - did-fail-load and render-process-gone;
  - `noteActivation`, `recentlyActivated` and `mayOpenPopup`;
  - `confirmLeaveAll`, `askLeave` and `leftPage`.
- `main/window.js`, `main/popup-window.js`: one line each in the close handler.
- Also changed: `main/ai/controller.js`, `main/ai/tools/browser.js`, `main/updater.js`, `preload/internal.js`.
