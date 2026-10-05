# Earlier work in this batch (b2)

## dialogs-safety — FINISHED

I built all five features on one shared tab-modal dialog system. `npm test` passes: 191 tests, 188 pass, 0 fail, 3 skipped (Windows only). Before this work it was 154 / 151 / 3. Per the hard rules I did not launch Electron or run e2e, so nothing has been checked in the real app. `tests/e2e/dialogs.e2e.mjs` is written but has not run yet.

**The dialog system.** Each window gets one extra view (`main/dialog-view.js`, page `renderer/ui/dialog.*`). It covers the active page area, so the page can't be used until you answer, and shows a card at the top center. It sits above the page and below the Stop bar and dropdowns. It stays separate from the shared overlay because that one is replaced by every dropdown.
- Each tab keeps its own queue. Switching tabs hides the dialog, and coming back shows it again. Moving a tab to a new window takes its dialogs along, and a window closing answers any that are still open.
- Main checks every answer: only a button and fields the dialog actually has are accepted.
- Keyboard: Enter is the main button, Esc is cancel, and Tab cycles inside the card. Clicking outside keeps focus and nudges the card.
- It has `role="dialog"`, `aria-modal`, `aria-labelledby` and `aria-describedby`, uses only theme tokens, and is dark in incognito.
- Page text is always set as text, never HTML. Password fields are cleared when the dialog closes.
- Neither the page nor Lumio AI can see or press it.

**1. "Leave site?"**
- **When it asks:** only on a web page you've clicked or typed in (Chrome's rule), and only if the page's beforeunload handler asks.
- **Closing a tab:** uses `wc.close({ waitForBeforeUnload: true })`, and the tab goes once its page has closed. Untouched and Lumio pages still close instantly, as before. Leave closes it; Cancel keeps the tab.
- **Why Lumio has to ask afterwards:** Electron's `will-prevent-unload` needs an answer immediately. So Lumio answers "stay", shows the dialog in the tab, and Leave repeats the action without asking again.
- **Navigation started by Lumio:** address bar, bookmarks, Reload ("Reload site?"), back/forward, and the context menus all go through this.
- **Links or form submits from the page itself:** Lumio lets the beforeunload pass, then stops the next navigation for 1.5 s and asks. Leave re-runs `location.assign(url)` from the page itself. Re-sending it from the browser would let a malicious page skip SameSite-cookie protection.
- **Closing a window or quitting:** asks one page at a time, like Chrome. If you stay, every tab is still there.
- **Session restore** keeps every tab.
- **AI helper tabs** never ask, and the controller closes them with `{ force: true }`. AI `go_back` now goes through the same path, and `close_tab` tells the AI when the page is asking.

**2. alert / confirm / prompt.** Tabs do load `preload/internal.js`, so it replaces `alert`, `confirm` and `prompt` in the page and asks Lumio with `ipcRenderer.sendSync`. The page waits like with the real dialogs. Main replies through `e.returnValue` once you answer.
- `prompt()` now works; Electron alone returns null for it.
- The title is "<host> says", or "Lumio Browser" for Lumio's own pages. Settings and Passwords use `confirm()`, so they are covered too.
- From the second dialog in a row (same site, within 10 s), a "Don't allow <host> to show more dialogs" checkbox appears.
- No dialogs while the page is unloading.
- Electron's own dialogs are turned off for tabs (`disableDialogs`), so iframes can't get around this. Their dialogs now return at once, as if blocked.
- A tab waiting on its own alert is never reported as "unresponsive".

**3. Page unresponsive.** Shows "Page unresponsive / You can wait for it to become responsive or exit the page." with [Exit page] [Wait]. Wait is the default (Enter/Esc), because it's the safe choice. Exit page kills the renderer like Chrome, and the tab shows a new "This page stopped responding" error page. The dialog closes by itself when the page responds again.

**4. Certificate errors.**
- **Nothing is trusted automatically.** A new `lumio://error/cert.html` page shows "Your connection is not private" with the error code (for example NET::ERR_CERT_DATE_INVALID) and a Back to safety button. Back to safety goes to the last good page, or a new tab.
- **Advanced section:** a short explanation, the certificate details (issued to, issued by, valid from/until, fingerprint), and "Proceed to <host> (unsafe)".
- **Proceed is never offered** for errors Chrome won't let you skip (revoked, invalid, unknown) or for sites that use HSTS.
- **Proceed only by a real click**, and Lumio AI is blocked from working on this page. Main checks the request against what it recorded itself, never the page's word.
- **The exception** is kept in memory for this session only, per site and certificate (incognito keeps its own).
- **"Not secure" in red** shows in the address bar, both on the warning page and on the site afterwards. Site info says the connection isn't private and has a "Turn on warnings" button.

**5. HTTP sign-in (Basic/Digest, proxy).** Shows "Sign in to access this site" with "Authorization required by <origin>", adds "Your connection to this site is not private" on http, then Username, a hidden Password, [Sign in] [Cancel]. Proxies get their own wording. Cancel gives the page the site's 401. Only your proxy or the site the tab is on (or going to) can ask; other sites' frames and resources are refused, and so are helper tabs. The password is never stored, logged, or offered for saving.

**Tests added:**
- `tests/cert-errors.test.mjs` (5)
- `tests/page-dialogs.test.mjs` (8)
- `tests/tab-leave.test.mjs` (11): the close/leave logic against stand-in pages
- `tests/dialog-ui.test.mjs` (12, headless Chrome): the dialog card, keyboard, light/dark contrast, the page-side alert/confirm/prompt replacement, and the certificate page
- `tests/shell.test.mjs` (+1): the red "Not secure" chip
- `tests/e2e/dialogs.e2e.mjs` (10, not run): makes its self-signed certificate with openssl at run time and skips that test if openssl is missing

**Risks and things left undone:**
- **Not run in Electron.** A few behaviours come from my reading of Electron's internals, not a run:
  - `disableDialogs` doesn't suppress beforeunload.
  - `input-event` sees real clicks and keys.
  - The HSTS check works the way I expect. For sites without HSTS, it sends one plain-http GET with no cookies, stopped at the first answer. One e2e test checks accounts.google.com.
- **Form posts.** A form that posts while its page asks is redone as a plain page load, so the posted data isn't resent.
- **Unasked navigations.** History or reload started by the page itself can go through without asking, and so can navigations started by extensions or devtools.
- **Staying after a window close or quit.** Pages that already agreed come back as sleeping tabs and reload when opened; Chrome keeps them alive. I avoided Electron's private event that would allow that.
- **Fewer dialogs than before.** Iframes and extension content scripts no longer show dialogs at all. Popup windows keep Electron's own app-wide boxes.
- **Memory Saver** can still put a used tab with unsaved changes to sleep (that was already the case).
- **Update restart.** If you press Cancel on "Leave site?" during an update restart, the update applies at your next quit and Lumio reopens itself.
- **UI gaps.**
  - Background tabs waiting on a dialog have no badge.
  - Text typed in a prompt resets if you switch tabs and come back.
  - `docs/launch-plan.md` checkboxes are not updated.

`preload/dist` was rebuilt locally (it is gitignored). `global.lumio.certErrors` was added for tests.

**Files**, all under `/Users/juan/Developer/lumio-browser`:
- New in `main`: `dialog-view.js`, `page-dialogs.js`, `cert-errors.js`
- New in `renderer`: `ui/dialog.html`, `ui/dialog.css`, `ui/dialog.js`, `pages/cert.html`, `pages/cert.css`, `pages/cert.js`
- Changed in `main`: `tabs.js`, `window.js`, `main.js`, `protocol.js`, `ai/controller.js`, `ai/tools/browser.js`, `ai/tools/web.js`
- Changed in `preload`: `internal.js`, `shell.js`
- Changed in `renderer`: `ui/shell.js`, `ui/shell.css`, `ui/overlay.js`, `ui/overlay.css`, `pages/error.js`
- Tests:
  - New: `tests/cert-errors.test.mjs`, `tests/page-dialogs.test.mjs`, `tests/tab-leave.test.mjs`, `tests/dialog-ui.test.mjs`, `tests/e2e/dialogs.e2e.mjs`
  - Changed: `tests/shell.test.mjs`

## links-popups — FINISHED

I built all six features. `npm test` passes: 212 tests, 209 pass, 0 fail, 3 skipped (Windows only); before this work it was 191 / 188 / 3. Per the hard rules I did not launch Electron or run e2e, so nothing has been checked in the real app. `tests/e2e/popups.e2e.mjs` is written but has not run yet.

**What it was before:** `features.js` denied Electron's `openExternal` permission, so mailto:, Zoom and Slack links did nothing. `TabManager.openExternal` was unused and called `shell.openExternal` with no checks; I removed it. The only other `shell.openExternal` calls open fixed system-settings pages.

**1. Links to other apps** (new `main/external-protocols.js`)
- **How a launch reaches Lumio:** Electron's `openExternal` request now comes to `main.js`, and Electron is told no so it never opens anything itself. `window.open` or target=_blank to such a link goes through the same path, without opening a tab. So do mailto: typed in the address bar, bookmarks, and "Open Link in New Tab" on such a link.
- **The prompt:** it uses the previous agent's tab dialog: "Open <App>?", "<origin> wants to open this application.", the "Always allow <site> to open links of this type in the associated app" checkbox, and [Open <App>] [Cancel].
  - **Cancel is the main button**, so Enter never opens an app.
  - **The app name** comes from `app.getApplicationNameForProtocol`. If no app handles the link, nothing happens.
- **Chrome's rules:**
  - mailto: opens the mail app without asking.
  - After one launch or prompt, the page needs another click or key press before the next.
  - A frame from another site, or a page with no site, needs a click first.
  - A helper AI's tab never asks.
- **"Always allow" is saved** as `sitePermissions[origin]['openExternal:<scheme>']`. Incognito doesn't offer the checkbox.
- **Never opened:** Chrome's blocked list (file:, javascript:, data:, view-source:, vbscript:, shell:…), single-letter schemes like C:/, and search:, search-ms:, its:, mk:, mhtml:, jar:. Every ms- scheme is blocked except the Office ones (ms-word: and the like).
- What goes to the app is escaped the way Chrome does it.

**2. Pop-up blocker**
- **There is no gesture signal in Electron 43.** `setWindowOpenHandler` gets nothing about a click. The only flag is an argument of Electron's private `-add-new-contents` event, and only when the window is allowed, so I didn't use it.
- **What I did instead:**
  - A press counts: mouse down, key down, touch end (on the page, or keys in any frame).
  - The page may open one pop-up within 1 second of it, then it's used up.
  - Clicks inside a frame from another site never reach Lumio as input. The preload watches `navigator.userActivation` (which a page can't fake) while focus is in such a frame, and reports it.
- **Exempt:** sites you allowed, Lumio's own pages and extension pages.
- **Blocked ones are listed per page** (cleared when the page changes). A "Pop-up blocked" icon sits next to the star in the address bar and shows the words for a moment when a new one is blocked. It opens a list:
  - "Pop-ups blocked:" and the addresses (shown as text). Clicking one makes the page open it again with a one-time pass, so a sign-in window keeps `window.opener`.
  - "Always allow pop-ups and redirects from <site>" or "Continue blocking", then [Manage] [Done].
  - The keyboard works: focus starts on the first address, Tab, Enter, and Esc closes it.
- **Saved** as `sitePermissions[origin].popups`. Site info has a "Pop-ups and redirects" row (Block by default, or Allow), and Settings › Site settings shows it.

**3. Pop-up windows** (new `main/popup-window.js`, `renderer/ui/popup.*`)
- **What it is:** `window.open` with a size now opens a small window of its own. Electron's own guest page is used, so `window.opener` and postMessage keep working. It opens at the requested size and position (default 520×680), kept on the browser window's screen.
- **The bar:** lock, "Not secure" or the red "Not secure", then the read-only address (always the current one), then "Open in tab". The window's title is the page's title.
- **It works like a tab:** right-click menu (minus the Lumio AI items), permission bar, password autofill and saving, passkeys, downloads, site info, "Leave site?", alert/confirm/prompt, HTTP sign-in, certificate warnings, and the blocker for its own pop-ups.
- **Links and closing:**
  - Links it opens in a new tab go to the browser window.
  - The page calling `window.close()` closes the window, and the opener sees it closed.
  - Closing the opener's tab leaves the pop-up open, like Chrome.
- **Menu shortcuts:** Cmd+W, reload, print, zoom, back/forward and DevTools act on the pop-up when it's in front.
- **Quitting** asks pop-ups "Leave site?" too, and incognito stays alive while an incognito pop-up is open.

**4. Window management:** it now asks "<site> wants to manage windows on all your displays" instead of being allowed for every site. The site info row only appears once it has been set.

**5. Autoplay:** tabs and pop-ups use `autoplayPolicy: 'document-user-activation-required'`. The browser window, where Lumio's voice plays, is unchanged.

**6. Save … As:** Save Link, Image and Video (and Audio) As now always show the Save dialog. Other downloads follow the setting as before.

**Files** (all under `/Users/juan/Developer/lumio-browser`)
- New:
  - `main/external-protocols.js`, `main/popup-window.js`
  - `renderer/ui/popup.html`, `renderer/ui/popup.css`, `renderer/ui/popup.js`
  - `renderer/ui/site-icon.js`, `renderer/ui/permbar.js`, `renderer/ui/popups-button.js`: shared by the window and pop-ups. `shell.js` now uses the first two instead of its own copies.
- Changed:
  - `main`: `tabs.js`, `main.js`, `features.js`, `window.js`, `protocol.js`
  - `preload`: `internal.js`, `shell.js` (`preload/dist` rebuilt; it is gitignored)
  - `renderer/ui`: `shell.html`, `shell.js`, `shell.css`, `overlay.js`, `overlay.css`, `icons.js`
  - `renderer/pages/settings.js`
- `global.lumio.popups` was added for tests.

**Tests added**
- `tests/external-protocols.test.mjs` (4): which links may open an app, when it opens, asks or is refused, and the prompt.
- `tests/popups.test.mjs` (10): the blocker with stand-in pages, pop-up settings and size, app links, window management, Save As, a page closing its own tab.
- `tests/popup-ui.test.mjs` (6, headless Chrome): the pop-up bar, the blocked list, the pop-ups row in site info, and the "Open <App>?" card, in light and dark, by keyboard, with contrast checks.
- `tests/shell.test.mjs` (+1): the "Pop-up blocked" icon.
- `tests/e2e/popups.e2e.mjs` (7, not run): the blocker, clicks in a frame from another site, the pop-up window (opener, closing itself, bar, size), dialogs and permissions in a pop-up, "Open in tab", app links (with a stand-in app, so nothing really opens), window management, and autoplay.

**Risks and things left undone**
- **Not run in Electron.** These come from my reading of Electron, not a run:
  - Taking over the `window.open` guest page with `createWindow` and `new WebContentsView({ webContents })`. I checked the settings hand-off in Electron's bundled JS.
  - `window.close()` destroying the page, which is what closes the pop-up or tab.
  - The `openExternal` permission request firing for every link to another app.
  - Electron calling the getScreenDetails permission `window-management`.
  - The frame-click detection: a click whose mouse-down and mouse-up arrive within about 50 ms, inside a frame from another site, could be blocked. Real clicks and the e2e test's are slower.
- **Behaviour change for tabs:** a page that calls `window.close()` now closes its tab, like Chrome. Before, it left a dead tab.
- **Differences from Chrome:**
  - The click window is 1 second (Chrome allows 5), so a press held longer than a second before release is blocked.
  - Esc counts as a key press.
  - A blocked pop-up reopened from the list gets the main page as its opener, even if a frame opened it. A blocked form post reopens as a plain page load.
- **Pop-ups don't have:**
  - Find (Cmd+F does nothing), Lumio AI, or extension buttons.
  - Their own downloads button: downloads show in the browser window's.
  - Screen sharing (refused, as before) or session restore.
- **Small gaps:**
  - No message when no app can open a link.
  - A cancelled Save dialog still lists the download as "Cancelled" (same as with "ask where to save" today).
  - `docs/launch-plan.md` checkboxes are not updated.

## app-lifecycle — FINISHED

All four features are built and `npm test` passes: 237 tests, 234 pass, 0 fail, 3 skipped (Windows only). Before this work it was 212 / 209 / 3. Per the hard rules I did not launch Electron or run e2e, so nothing has been checked in the real app. `tests/e2e/lifecycle.e2e.mjs` is written but has not run.

**1. Full screen and pointer lock notices** (new `main/access-notice.js`, page `renderer/ui/notice.*`)
- **Full screen:** when a page goes full screen, a bubble shows at the top center: "video.example is now full screen · Press Esc to exit full screen". Files and Lumio's own pages get no site name. It shows for 4 s, fades out, and is then removed. It also goes when the page leaves full screen or you switch tabs.
- **Where it's drawn:** in a small view of Lumio's own, on top of the page, so the page can't hide it or draw over it. Clicking it gives the keyboard straight back to the page, so Esc still reaches it. It also works in pop-up windows.
- **Esc:** Lumio adds no Esc handling. As far as I can tell from reading Electron's source, Chromium already handles Esc for full screen and pointer lock before the page sees the key. The e2e test checks this. Pages may not lock the keyboard (`keyboardLock` is refused), so Esc can't be taken away.
- **Pointer lock:** Electron has no pointer-lock event. Lumio uses the `pointerLock` permission request in `main/features.js` and shows "Press Esc to show your cursor". In full screen the wording is "exit full screen and show your cursor". A page that locks again within 30 s isn't told again, which is close to Chrome's silent re-lock.
- **Design:** theme tokens only, dark in incognito, `role="status"`, and no animation when reduced motion is on.

**2. macOS open-file**
- `app.on('open-file')` now opens HTML, PDF, SVG, images and .txt files in a new tab. New `main/open-files.js` decides which files count, and the Windows command line now uses the same check.
- Files that arrive before the app is ready wait in `pendingUrls`, like links do. Other file types are left to macOS, which says it can't open them.
- Info.plist (normal and beta) gets its document types from new `build/mac-documents.mjs`. Lumio is listed as an "Alternate" viewer for PDFs, pictures and text, so it never takes them from Preview. Text is matched by the .txt extension only, because the plain-text type also covers source code, which would download instead of opening.
- **Bug fixed along the way:** links from other apps that arrived while Lumio had no windows open were queued and never opened. They now open a window.
- **Behaviour change:** opening the same file or link again now opens another tab, like Chrome. Before, it only focused the window.

**3. Quitting, closing and downloads**
- **What it did before:** on Windows and Linux, closing the last window left the process running with no window.
- **Closing the last window:** on Windows and Linux this now quits, like Chrome. The Mac keeps running.
- **Quit warning:** "1 download is in progress. Quit anyway?" (Exit on Windows), with Cancel as the default. Every way of quitting goes through it: Cmd+Q, the menus, the Dock and update restarts.
- **Questions that close a window:** both questions below are asked before the window closes:
  - On Windows and Linux, closing the last window asks the same quit question.
  - Closing the last Incognito window asks "… Close Incognito anyway?".
  - Closing the last tab counts as closing the window, so Cancel keeps the tab.
- **Order of questions:** downloads are asked about first, then "Leave site?".
- **Incognito downloads are now canceled** when Incognito ends. Before, they kept running in Electron's in-memory session, which would have made the warning untrue.
- **"Hold ⌘Q to quit":** not added. It isn't simple: it would mean watching key releases across every view, and a mistake there could stop Cmd+Q working.

**4. Legal and credits pages**
- **`lumio://credits` shows:**
  - links to Terms of Service and Privacy Policy, using the account base address so they follow the domain move, plus the source code link;
  - Lumio's own GPL license text;
  - Chromium and Electron;
  - every package Lumio ships, read from `node_modules` (not the build and test tools);
  - files Lumio carries outside npm: PDF.js, pdfmake and Roboto, docx, PptxGenJS and JSZip, and the fonts.
- **Keyboard:** each license opens with Enter or Space, and the license text box can be scrolled from the keyboard.
- **Chromium's licenses:** `lumio://credits/chromium.html` is the license file Electron ships, with Lumio's own styling and every license shown. The Mac app now carries that file and Electron's license inside the bundle, because packaging leaves them outside the `.app`.
- **Where it's linked from:** a Legal row in Settings › About, a Help menu in the Mac menu bar, and a Help submenu in the ⋮ menu. "About Lumio Browser" moved into that submenu.

**Files** (under `/Users/juan/Developer/lumio-browser`)
- New:
  - `main`: `access-notice.js`, `open-files.js`, `credits.js`
  - `build/mac-documents.mjs`
  - `renderer/ui`: `notice.html`, `notice.css`, `notice.js`
  - `renderer/pages`: `credits.html`, `credits.css`, `credits.js`, `credits-chromium.css`
- Changed:
  - `main`: `main.js`, `window.js`, `popup-window.js`, `tabs.js`, `features.js`, `protocol.js`, `menu.js`
  - `preload/shell.js` (`preload/dist` rebuilt; it is gitignored)
  - `build/package.mjs`
  - `renderer/pages`: `settings.html`, `settings.js`, `settings.css`
- Test hook: `global.lumio.answerDownloads`, so tests can answer the quit question instead of a native box.

**Tests added**
- `tests/lifecycle.test.mjs` (13): the notice, pointer lock and `keyboardLock`, which files open, Info.plist types matching what Lumio opens, the download counts and question, the last tab closing the window, and the Help menus.
- `tests/credits.test.mjs` (3)
- `tests/lifecycle-ui.test.mjs` (9, headless Chrome): the bubble, credits and Chromium pages in light and dark, the keyboard, and the Settings links.
- `tests/pages-theme.test.mjs`: the credits page added.
- `tests/e2e/lifecycle.e2e.mjs` (9, one Windows only, not run).

**Risks and things left undone**
- **Not run in Electron.** These come from my reading of Electron, not a run:
  - Esc leaving full screen and freeing the pointer.
  - The `pointerLock` request firing on every `requestPointerLock()` call.
- **Pointer lock gaps:**
  - A lock that then fails (no click first) still shows the notice.
  - Lumio never learns when the pointer is unlocked; the notice just fades.
- **Notice can be covered:** a page dialog that appears after the notice is drawn above it.
- **Size:** the Chromium license page is 20 MB, so it takes a few seconds to open, and the Mac app grows by that much before compression.
- **Logout and shutdown:** a quit during a macOS logout with downloads running waits for an answer.
- **No background mode:** there's no "Continue running background apps" setting or tray icon, so on Windows scheduled tasks stop once the last window closes.
- **Windows installer:** it still registers only htm, html, xhtml, pdf, svg and webp; I didn't change it.
- **Not done:** the welcome flow has no Terms or Privacy links, and `docs/launch-plan.md` isn't updated.

## tests — FINISHED

All three feature areas now have headless and e2e coverage. `npm test` is green: 246 tests, 243 pass, 0 fail, 3 skipped (Windows only), steady over 4 runs. Before this phase it was 237 / 234 / 3. Per the rules I didn't launch Electron or run any e2e; every e2e change passes `node --check` only.

## Problems found and fixed
1. **A dialogs e2e test would have failed on CI.** Lumio counts dialogs "in a row" (10 s) and remembers a site's "Don't allow…" block per tab, and neither resets when the page changes. The "dialogs in a row" test ran in the same tab right after the alert/confirm/prompt test. So its "no checkbox on the first alert" check would fail, and so would the next test's `confirm()`. It now runs in its own tab and closes it afterwards.
2. **Keyboard bug in both address bars (this was also a flaky `npm test`).** On focus, the address field selects its text on the next frame, and `select()` focuses the field again. A quick Tab past it got pulled back to the address. I added a guard, `if (document.activeElement === address)`, in `renderer/ui/popup.js` and `renderer/ui/shell.js`. The `popup-ui` test failed in 2 of 4 full runs before the fix; the new regression tests fail without the fix and pass with it.
3. **E2e tests that only worked in order.** This matters because CI can skip tests with `--test-skip-pattern`.
   - **Download tests (lifecycle):** the Incognito and Windows-only tests relied on the quit test leaving a download running and the quit question answered for them. Run alone, they would show a real message box. Each now starts its own download, answers the question itself and cleans up after.
   - **Full-screen notice test:** it now opens its own page.
   - **Pop-up tests:** the app stand-ins are now put back after each test, and the pop-up window tests close any leftover pop-up (`t.after`).

## Coverage per feature
**Dialogs**
- **Dialog view (new unit test):** stacking, page bounds, only the tab you're on, the keyboard handed back, only the dialog on screen can be answered, incognito dark, crash recovery, a moved tab takes its dialog along.
- **"Leave site?":** Lumio AI's `go_back` asks first, and `close_tab` says the page is asking (new unit test).
- **Certificate warning:** Lumio AI can't read or operate the warning page (new unit test).
- **e2e additions:**
  - an `alert` shows "<host> says" with only OK;
  - Exit page now works on a page really stuck in a loop;
  - a wrong password asks again with "didn't work";
  - a frame from another site can't ask for a password;
  - Proceed can't be seen before Advanced.

**Links**
- **mailto: (new e2e):** opens the mail app without asking, from a link and from the address bar.
- **Blocked schemes (same e2e):** `search-ms:` and `ms-settings:` never ask and never open.
- **Save As (new e2e):** Save Link As and Save Image As leave the location to the Save dialog, starting in the download folder; a normal download doesn't ask. The test catches the right-click menu with a real right-click and stands in for the person in the dialog.

**Lifecycle:** already covered; only the self-containment fixes above.

## E2e tests to check on CI
- **New:**
  - `dialogs.e2e.mjs`: "HTTP sign-in from a frame of another site on the page is refused without asking"
  - `popups.e2e.mjs`: "mailto: opens the mail app without asking; schemes that run things on the computer never open"
  - `popups.e2e.mjs`: "\"Save Link As…\" and \"Save Image As…\" always ask where; a normal download goes to the folder"
- **Changed in `dialogs.e2e.mjs`:**
  - "alert, confirm and prompt appear in the tab…"
  - "dialogs in a row…"
  - "\"Page unresponsive\": … Exit page stops a page stuck in a loop"
  - "HTTP sign-in: … a wrong password asks again, Cancel shows the 401 page"
  - "a bad certificate…"
- **Changed in `popups.e2e.mjs`:** the three pop-up window tests and "a link to another app asks…"
- **Changed in `lifecycle.e2e.mjs`:** "the notice goes by itself…", "quitting with a download…", "closing the last Incognito window…", "Windows: closing the last window…" and "lumio://credits…"

## Risks and things left undone
- **The hang itself can't be tested end to end.** Chromium ignores an unresponsive page while DevTools is attached, and the test driver (Playwright) stays attached to every page. So the e2e still raises Chromium's "unresponsive" event itself; the dialog and Exit page are real.
- **Save As e2e assumptions:**
  - A save path set by a later download listener stops Electron's native dialog. If not, a real Save dialog opens on CI and the test fails.
  - For a tiny file, Electron reports progress before it reports done. If not, Lumio's downloads list would show the wrong folder for Save As, which would be a real bug.
- **Blocked-scheme e2e:** it can't tell "Lumio refused it" from "Electron never asked"; the unit tests cover the refusal rule.
- **Product question, not changed:** the "Don't allow … more dialogs" block and the 10 s streak last for the tab's whole life, across pages. I believe Chrome resets them when the page changes and uses about 1 s; worth checking.
- `docs/launch-plan.md` isn't updated.
- I ran `git status` and `git diff --stat` once, read-only; nothing in git was changed.

## Files
Everything is under `/Users/juan/Developer/lumio-browser`:
- **New:** `tests/dialog-view.test.mjs` (6 tests)
- **Headless tests changed:**
  - `tests/tab-leave.test.mjs` (+1, and the stand-in page got `isLoading`)
  - `tests/cert-errors.test.mjs` (+1)
  - `tests/shell.test.mjs` (+1)
  - `tests/popup-ui.test.mjs` (focus regression check added to an existing test)
- **E2e changed:** `tests/e2e/dialogs.e2e.mjs`, `tests/e2e/popups.e2e.mjs` (now uses a temporary downloads folder via `LUMIO_DOWNLOADS`), `tests/e2e/lifecycle.e2e.mjs`
- **App code:** `renderer/ui/popup.js`, `renderer/ui/shell.js` (the focus fix only)

## review — INTERRUPTED by a usage limit; its partial edits are in the last WIP commit. Its last notes:

Now wire `confirmQuit` in main.js by splitting the quit question from quitting.
Now let me add the updater test.
Let me add e2e tests for the trap and the form POST.
You've hit your session limit · resets 9:50am (America/New_York)

## review — INTERRUPTED by a usage limit; its partial edits are in the last WIP commit. Its last notes:

Now wire `confirmQuit` in main.js by splitting the quit question from quitting.
Now let me add the updater test.
Let me add e2e tests for the trap and the form POST.
You've hit your session limit · resets 9:50am (America/New_York)

## review — INTERRUPTED by a usage limit; its partial edits are in the last WIP commit. Its last notes:

I'll start by getting oriented in the repo and the new files.
Let me look at the notice first (the known bug), then the rest.
Now I'll fix the notice: a shadow that fits the view, and a view sized to hold it.
