# Earlier work in this batch (b4)
# Earlier work in batch b4 (rebuilt from logs)

## nav-1 — FINISHED (run wf_3019b4c4-8f4)

I built all 8 items, and `npm test` passes: 182 tests, 179 pass, 0 fail, 3 skipped (before: 154 / 151 / 3). Server tests pass 38/38.

**I broke the rule against launching Electron once, by accident.** To check the syntax of the new e2e file I ran `node -e "import('tests/e2e/navigation.e2e.mjs')"`. Importing that file runs its tests, so it built the preload and launched Electron from this worktree for about 1–2 minutes, running some tests before I stopped it. I found no leftover Lumio or Electron processes from the worktree. I left the owner's Lumio Beta app alone. I deleted the three temp folders that run made (`lumio-nav-e2e-*`, `lumio-profile-5nxRGR`, `lumio-nav-profile-9uoc72`). After that I only used `node --check`, which doesn't run anything. The new e2e tests have not run anywhere else, so they are unverified.

**What each item does**
1. **Link status bubble — done.** The bubble is a small view of its own, drawn over the page and under any dropdown. It uses Chrome's timing: shows after 80 ms, hides 250 ms after the pointer leaves (fading over 200 ms), and widens to the full address after 1.6 s. Long addresses lose their middle, never the site name. It moves to the other bottom corner when the pointer gets near it, and hides at once on a tab switch. It respects reduced motion and is kept out of screen-reader announcements.
2. **Back/Forward history menu — done.** Right-click, the context-menu key, or a 500 ms hold opens a native menu: up to 12 pages, nearest first, then "Show Full History". Favicons show when cached; incognito icons are not cached. Clicking an entry goes there. Cmd/Ctrl-click opens a background tab and Shift-click a new window. Middle-click or Cmd/Ctrl-click on Back, Forward, Reload or Home opens a new tab that keeps the tab's back/forward history.
3. **Mouse buttons and swipes — done; real devices untested.**
   - The mouse's back/forward buttons work in pages and over the browser's own UI. Main goes back only if Chromium hasn't already, so there's no double step. On Linux I leave it to Electron's `app-command`, since handling it too would go back twice.
   - Windows `app-command` (keyboard Back/Forward keys) is wired.
   - macOS three-finger swipes are mapped the way Chrome's code maps them (left = Back).
   - macOS two-finger swipes show an arrow at the page edge and go back or forward past 160 px. They respect the "Swipe between pages" system setting and a page's `overscroll-behavior-x`.
4. **Shortcuts — done.**
   - New on Mac: ⌘. (Stop), ⌘⌥U, ⌘⌥J, ⌘⇧⌫, ⌘⇧D, ⌘⇧H, ⌘O, ⌘E (Use Selection for Find), and hidden ⌘⇧J and ⌘⇧O as extra keys for Downloads and the Bookmark Manager.
   - New on Windows: Ctrl+J (Downloads), Ctrl+Shift+J (Console), Ctrl+U, Ctrl+O, Ctrl+Shift+Delete, Ctrl+Shift+D, Shift+F5, Alt+Home, F1.
   - Esc stops a loading page (the page still gets the key). Alt/Option-click on a link downloads it.
   - I checked the ones that already existed (bookmarks bar, history, tab switching, fullscreen, close window, incognito).
   - **"Ask Lumio" on Windows moved from Ctrl+J to Ctrl+Shift+K**, because Ctrl+J is Downloads in Chrome. On Mac it stays ⌘J.
5. **Home button and On startup — done.** The Home button is off by default and opens either the New Tab page or a chosen address. On startup has three choices: New Tab page / Continue where you left off / Specific pages. The pages list has Add, Edit, Remove and "Use current pages". These settings also sync.
6. **Per-site zoom — done.** From reading Electron's code, Chromium shares a zoom level between tabs of the same site, but only until Lumio quits. Levels are now saved per site, outside incognito, and come back after a restart.
   - Zoom steps follow Chrome's list (25–500%).
   - The zoom badge follows the tab you're on. Zooming opens a bubble with "110% − + Reset" that closes itself after 1.5 s; clicking the badge keeps it open, and it works with the keyboard.
   - Settings › Appearance has a Page zoom default, and Privacy › Zoom levels lists sites with a Remove button.
7. **Find bar per tab — done.** Each tab keeps its own bar, words and match count. ⌘E puts the page's selection into Find (and the Mac's shared find text, outside incognito). ⌘G and ⇧⌘G already worked.
8. **Open File, Save formats, pinch zoom — done.** Open File opens in the current tab, like Chrome. Save Page As offers Complete, HTML Only and Single File (MHTML). Pinch is a visual zoom up to 500%, like Chrome.

Delete Browsing Data opens the History page's clear dialog (`lumio://history/#clear`). Help opens the website's FAQ; I added `id="faq"` to `website/public/index.html`, but it won't be live until the website is redeployed.

**Files changed:** `main/main.js`, `main/menu.js`, `main/tabs.js`, `main/store.js`, `main/sync/adapters.js`, `preload/internal.js`, `preload/shell.js`, `renderer/ui/shell.js`, `renderer/ui/overlay.js`, `renderer/ui/overlay.css`, `renderer/pages/settings.html`, `renderer/pages/history.js`, `website/public/index.html`, `tests/shell.test.mjs`, `tests/pages-theme.test.mjs`.

**New files:** `main/navigation.js`, `main/page-hud.js`, `main/zoom.js`, `main/startup.js`, `renderer/ui/hud.html`, `renderer/ui/hud.css`, `renderer/ui/hud.js`, `renderer/ui/elide.mjs`, `renderer/ui/navigation.js`, `renderer/ui/overlay-zoom.js`, `renderer/pages/settings-nav.js`, `renderer/pages/settings-nav.css`.

**Tests added:** `tests/zoom.test.mjs`, `tests/startup.test.mjs`, `tests/navigation.test.mjs` (includes a no-duplicate-shortcuts check), `tests/hud.test.mjs` (uses Playwright's fake clock so a busy machine can't make it flaky), plus one new test each in `tests/shell.test.mjs` and `tests/pages-theme.test.mjs`. The CI-only e2e file is `tests/e2e/navigation.e2e.mjs`.

**Risks and loose ends**
- **Windows two-finger swipe:** I assumed Chromium's built-in swipe-back covers it inside Electron, so I didn't add my own. That assumption is unverified.
- **Mac swipe tuning:** the 160 px threshold and the "fingers lifted" guess (shrinking scroll steps) may need adjusting on real trackpads.
- **Pinch zoom side effects:** after a pinch, Lumio AI's click positions and the password dropdown may land in slightly wrong places.
- **"HTML Only" save:** Electron doesn't say which format was picked, so a `.htm` extension means HTML Only.
- **First-load zoom:** a saved site level is applied when the page commits, so the first page of that site in a session may briefly render at 100%.
- **Merge overlaps:**
  - "Bookmark All Tabs" (⌘⇧D) may clash with the organizing team's folder version.
  - The Delete Browsing Data shortcut may clash with the privacy team's.
  - The menu command names are new; another branch could add the same names.
  - The `preload/shell.js` channel lists may conflict.
  - The `find-close` message now hides the find bar for a tab switch instead of closing it.
- **Not done:** I didn't add the Chrome touch of showing a bookmark's address in the status bubble when hovering the bookmarks bar.

## nav-2 — INTERRUPTED by a usage limit (run wf_3019b4c4-8f4); its partial edits are in the working tree. Its last notes:

Now the edits to `main/tabs.js`.
Now update `sessions.begin` signature, then wire everything in `main/main.js`.
Now the renderer side. First, pure helpers that node tests can import.
You've hit your session limit · resets 4:50am (America/New_York)

## tests — INTERRUPTED by a usage limit (run wf_3019b4c4-8f4); its partial edits are in the working tree. Its last notes:

You've hit your session limit · resets 4:50am (America/New_York)

## review — INTERRUPTED by a usage limit (run wf_3019b4c4-8f4); its partial edits are in the working tree. Its last notes:

You've hit your session limit · resets 4:50am (America/New_York)

## nav-2 — INTERRUPTED by a usage limit (run wf_f927006a-e87); its partial edits are in the working tree. Its last notes:

Now the headless-Chrome UI tests: the strip, the infobars, the tab search list, the sad tab page and the new Settings rows.
Let me fix the marker's size (a zero-width box counts as hidden) and the card alignment, then fix the test details.
Now the e2e tests (CI only). Let me look at nav-1's restart test pattern first.
You've hit your session limit · resets 9:50am (America/New_York)

## tests — INTERRUPTED by a usage limit (run wf_f927006a-e87); its partial edits are in the working tree. Its last notes:

You've hit your session limit · resets 9:50am (America/New_York)

## review — INTERRUPTED by a usage limit (run wf_f927006a-e87); its partial edits are in the working tree. Its last notes:

You've hit your session limit · resets 9:50am (America/New_York)
