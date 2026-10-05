batch7c-autofill-extensions

# Batch 7c result: autofill, passkeys, extensions UX, help and macOS integration

## Status per item

| Item | Status |
|---|---|
| autofill-passkeys (earlier run) | **Done.** See `.batch/EARLIER.md`. The review fixes below touch it. |
| 1. extensions-help-mac | **Done.** The interrupted runs had already written nearly all of it into the WIP commit, and it passed `npm test`. I checked it against every point in TASK.md, then fixed what the review found. |
| 2. Tests | **Done.** The WIP already covered every feature with unit, headless-UI and e2e tests. I added regression tests for each review fix. |
| 3. Skeptical review | **Done.** A fresh subagent reviewed the whole batch and rendered the new UI in light and dark (`dist/review-shots/`). All high/medium findings are fixed, plus most low ones. |

### What item 1 contains (from the WIP, checked against the spec)
- **Extensions UX**
  - The puzzle-piece menu (`main/extensions-ui.js`, `renderer/ui/overlay-extensions.*`): run, pin/unpin, and per-site access ("When you click the extension" / "On <site>" / "On all sites").
  - The toolbar shows pinned extensions only (`renderer/ui/extensions-bar.*`). Right-clicking a button gives Lumio's own menu.
  - The details page at `lumio://extensions/?id=…` shows description, version, size, ID, permissions, "may not work in Lumio" notes, site access with a site list, pin, Incognito, file URLs, shortcuts, options, website and Remove.
    - Incognito is shown off and disabled with a note: Electron can't load extensions into the in-memory incognito session.
  - `lumio://extensions/shortcuts` uses Chrome's shortcut rules, and the shortcuts run from the menu bar.
  - Developer mode can load unpacked, pack a CRX3 with a new key or your own .pem, and update.
  - An extension can replace the new tab page (`chrome_url_overrides.newtab`), with a "Keep it / Change it back" prompt.
  - Stand-ins for missing APIs (`chrome.alarms`, `chrome.sidePanel`, `chrome.identity.launchWebAuthFlow`) are in `main/extension-shims.js` and `preload/extension-shims.js`. `docs/extensions-support.md` lists what Electron, electron-chrome-extensions and the stand-ins each provide.
- **Help**
  - Help menu and ⋮ › Help: Help center, Report an issue…, What's new, Version Info, Experiments.
  - The Report an issue dialog (`renderer/ui/overlay-help.*`, `main/help.js`) sends the page's address and screenshot only when ticked, and has a system-info toggle.
  - It posts to the server's `POST /api/feedback` (`server/src/feedback.ts`), which has tests, a D1 migration (`server/migrations/2026-10-05-feedback.sql`), and an owner-only list, screenshot view and delete on `/admin`.
  - Also: `lumio://version`, and `lumio://flags-lite` with smooth scrolling, dark mode for all websites and parallel downloading (`chrome://flags` maps to it).
  - DevTools can dock right, bottom or undocked, and Lumio remembers the last choice (`main/devtools.js`, View › Developer).
- **macOS**
  - The menu bar is laid out like Chrome's (`main/menu-extras.js`, `main/menu-commands.js`): Edit has Spelling and Grammar, Substitutions and Speech; View has Stop and a Developer submenu; History lists recently visited pages; Bookmarks lists the bar's items; plus Profiles and Tab menus, the Window list and Help.
  - Handoff and Look Up/Speech in the context menu (`main/mac-integration.js`). These are added only when the menu doesn't already have them.
  - **Skipped:** an AppleScript dictionary. Electron has no Cocoa scripting support, so it isn't trivial; this is noted in the code.

## Review findings and fixes

| # | Sev | Finding | Fixed |
|---|---|---|---|
| 1 | med | The AI agent could open and operate `lumio://extensions` (turn on file-URL or all-sites access), `flags-lite`, `passwords` and `version`, because only Settings was blocked. | Yes. `PRIVATE_PAGE` in `main/ai/tools/browser.js` now blocks reading, operating and opening all of them. Test in `tabs-context.test.mjs`. |
| 2 | med | The new-tab-page prompt took keyboard focus 400 ms after ⌘T, with "Change it back" focused. Typing an address followed by Enter turned the extension off and lost the typed URL. The prompt could also replace the address suggestions. | Yes. The prompt no longer takes focus; "Keep it" is focused inside the card; it waits while another popup is showing. Tests updated and added. |
| 3 | med | The autofill dropdown, password dropdown or security-key note could replace an open Report an issue dialog, losing the typed text. | Yes. Autofill treats `feedback`, `formsave` and `ntp-override` as questions it never covers. The password dropdown and the key note skip an open report. |
| 4 | med | A page could fill and submit an address or card form by itself and get "Save/Update address?" or "Save card?" (planting or overwriting data with one Enter). | Yes. Lumio now offers to save only when a field was typed by the person or filled by Lumio. Test added (fails without the fix). |
| 5 | med | Shortcuts that an extension's manifest suggested could silently clash with Lumio's own keys (e.g. ⌘⇧L) or another extension's. | Yes. As Chrome does, a suggested key that is already taken shows as "Not set"; keys the person set win. Test added. |
| 6 | med | An older live server rejects the new sync collections (passkeys, addresses, cards), which made the whole sync push fail. | Yes, on the client: newer collections go in their own batches; if the server refuses them, everything else still syncs and they're retried in an hour. Test against a simulated old server. **Still deploy the server before or with this release.** |
| 7 | low | `lumio://extensions/shortcuts/` (trailing slash) loaded with no CSS or JS. | Yes. Root-absolute asset paths. Test added (fails without the fix). |
| 8 | low | Closing the shortcuts page while recording a shortcut left extension shortcuts off until relaunch. | Yes. Recording is tied to the page's webContents and cleared when it is destroyed or navigates. Test added. |
| 9 | low | The security-key note could come from a background tab, and finishing it closed another tab's passkey prompt. | Yes. It shows for the active tab only and hides only its own note. |
| 10 | low | The report's screenshot stayed in memory after a tab switch hid the dialog. | Yes. `hideOverlay` drops `w.feedback` (one line in `window.js`). |
| 11 | low | The server read the whole body before checking its size, and kept an unsalted IP hash for 180 days. | Yes. Content-length is checked first; the cron blanks `ip:` sender hashes after an hour; the privacy page says so. Server test extended. |
| 12 | low | "Allow access to file URLs" did nothing for content scripts when site access was limited. | Yes. File patterns are kept in the limited copy when the switch is on. Test added. |
| 13 | low | The whole menu was rebuilt 2 s after every history save, re-reading every manifest; on the Mac this can close an open menu. | Yes. It rebuilds only when the recent-history items changed, and extension shortcuts and Lumio's reserved keys are cached. |
| 14 | low | The loaded-path check used `===`; a symlinked path could cause a reload loop. | Yes. Paths are compared with realpath. |
| 15 | low | After a Web Store update the new version briefly runs unrestricted until the limits are reapplied on `setImmediate`. | **No.** It would need hooking the store updater before load. The window is brief and only affects people who limited site access. |
| 16 | low | The "Dark mode for all websites" flag (`WebContentsForceDark`) is app-wide and may also darken Lumio's own light pages. | Partly: the flag's description now says so. It's opt-in and experimental. **Check on a Mac.** |
| 17 | low | A11y: the details page lost focus on redraw; the puzzle menu's rows and ⋮ buttons lacked menu roles; the autofill dropdown has no aria-expanded or activedescendant link to its field. | Focus and roles fixed, with a test. **The autofill dropdown ARIA is not done**: it is drawn in a separate overlay view, so the field can't point at it. |
| 18 | low | The developer bar squeezed its note into a thin column at narrow widths. | Yes. It wraps. Rechecked in a screenshot. |

On the screenshots (`dist/review-shots/`): everything else looked right in both light and dark, with no hard-coded colours. One minor point: the red error text on a disabled "Broken" extension card is faint because of the card's opacity (not changed).

## Tests
- `npm test` (root, which includes the server tests): **237 tests, 232 pass, 0 fail, 5 skipped**. The skips are Windows-only, Mac-only and Safari import.
  - Baseline at the start of this run: 232 tests, 227 pass, 5 skipped.
- `npm test` in `server/`: **43/43 pass**.
- e2e tests (written, not run here; for CI):
  - `tests/e2e/extensions.e2e.mjs`:
    - puzzle menu and pinning
    - site access
    - keyboard shortcuts from the menu bar
    - chrome.alarms stand-in
    - details page
    - new tab override with "Change it back"
    - Report an issue (to a stand-in server)
    - lumio://version and flags-lite
    - menu bar
    - DevTools docking
    - Handoff (Mac)
  - `tests/e2e/autofill.e2e.mjs`: autofill and security keys.
  - `tests/e2e/browser.e2e.mjs`: updated for the pinned-only toolbar.
  - The NTP e2e test clicks "Change it back" directly, so the focus change doesn't affect it.

## Risky / not done
- **Deploy the server (sync collections and `/api/feedback`) before releasing this build.** The client now tolerates an old sync server, but Report an issue needs the new route and the `feedback` D1 table. Run the migration file.
- Security keys, Handoff, the Mac menu bar, Look Up and force-dark are only covered by e2e tests on CI or not at all; none of them has been tried on a real Mac.
- The new-tab-page prompt no longer takes focus, so a keyboard-only user has to click it or use Esc in the card; Chrome's bubble works the same way. Without an answer it's asked again at the next launch.
- Not done: findings 15 and 16 (partly) and the autofill dropdown ARIA (17), as listed above. The AppleScript dictionary was skipped.
- `docs/launch-plan.md` checkboxes were not ticked, to avoid merge conflicts.

## Merge hints (shared files changed in this batch)
- **Hub files:**
  - `main/main.js` (wiring, `menuState`, history-menu rebuild check)
  - `main/menu.js` (Edit, View, Window and Help use `menu-extras`)
  - `main/tabs.js` (`newTabUrl` hook, `contextMenuExtras` gets `existing`)
  - `main/window.js` (two hooks, plus one line in `hideOverlay`)
  - `main/protocol.js` (page hosts, sub-page routing)
  - `main/omnibox.js` (chrome://version and chrome://flags)
  - `renderer/ui/shell.{js,html,css}` (extensions bar)
  - `renderer/ui/overlay.{js,html}` (dispatch to the new modules)
  - `renderer/pages/settings.{html,js}`
  - `preload/shell.js` (channels)
- **Also likely touched by other batches:**
  - `main/ai/tools/browser.js` (`PRIVATE_PAGE`)
  - `main/sync/engine.js` and `main/sync/adapters.js`
  - `server/src/index.ts` and `server/schema.sql`
  - `website/public/privacy.html` and `website/public/admin.*`
  - `README.md`
- `ALL_PAGES` in main.js and `PAGE_HOSTS` in protocol.js gained `version` and `flags-lite`. Other batches adding pages will conflict on those same lines; keep both sets.
