# Batch 5 (organize): result

Branch: `batch5-organize`. No new runtime dependencies. No secrets, deploys or live calls. No PRs, tags or releases (TASK.md forbids them).

## Per item

### Omnibox: done (earlier run, see EARLIER.md)
I reviewed it lightly. One fix came out of the review: search engines that arrive through sync are now limited to web addresses.

### 1. Bookmarks: done
This was the earlier interrupted run's work in the WIP commit. I checked it against all 7 sub-items, it was already complete, and tests pass.
1. **Tree model** (`main/bookmarks.js`) with Bookmarks bar, Other bookmarks and Mobile bookmarks. The old flat list moves into the bar on first run.
2. **The bar.** Folder menus with submenus open in the overlay, and drag and drop works. Other bookmarks and All bookmarks sit at the right end, and » still works.
3. **The manager** (`lumio://bookmarks`): tree, search, multi-select, drag, new folder, rename, edit the address, delete with Undo, sort, and keyboard.
4. **The star bubble** has Name, a Folder dropdown with "Choose another folder…", and Remove and Done. Bookmark All Tabs puts the tabs in a new folder. New in this run: the bubble also has an "Add to reading list" button.
5. **Import and export.** Netscape HTML works both ways and keeps folders. Chrome (with a profile choice) and Safari keep their folders. There is a Firefox importer that reads `places.sqlite` from a copy.
6. **Sync.** The `bookmarkTree` collection is folder-aware, and the flat list still works for older Lumio versions.
7. **New tab page shortcuts:** My shortcuts or Most visited, with add, edit, remove and hide, each with Undo.

### 2. Groups and lists: done
1. **Tab groups.**
   - **Where the code is:** the model is `main/tab-groups.js` and the wiring is `main/groups-service.js`.
   - **Creating:** the tab menu has "Add Tab to New Group" and "Add Tab to Group ›", plus "Remove from Group".
   - **The chip:** it shows the group's name and color, using Chrome's 9 colors as theme tokens. A line in that color runs under the group's tabs. Clicking the chip collapses or expands the group, with animation.
   - **Group editor (right-click the chip, or Shift+F10):** it has the name, colors and New tab in group. It also has Save/Unsave, Ungroup, Close/Delete group and Move group to new window.
   - **Dragging:** you can drag tabs in and out of a group, and drag a whole group by its chip.
   - **Following the group:** a link opened from a grouped tab, and New Tab to the Right, join the group. Going to a tab inside a collapsed group expands it.
   - **Persistence:** groups are saved in the session and restored, including when a closed window is reopened.
   - **Saved groups** (`main/saved-groups.js`) sit at the left end of the bookmarks bar and reopen with one click, or go to the group if it's already open. While a saved group is open, its saved copy follows it. Saved groups sync.
2. **Reading list** (`main/reading-list.js`).
   - **Adding pages:** from the tab menu, the page and link right-click menus, the star bubble, the Bookmarks menu, and the panel's "Add current tab".
   - **Read state:** pages are unread or read. Opening one from the list marks it read. Removing one offers Undo.
   - **Incognito:** you can't add pages from an incognito window.
   - **Sync:** the reading list syncs.
3. **Side panel** (`renderer/ui/side-panel.js`, `main/side-panel.js`).
   - **The switcher:** a compact switcher at the top of the AI panel's column: Lumio AI, Reading list (with the unread count), Bookmarks (tree and search) and History (by day, with search).
   - **Reading mode slot:** the page-tools batch can add it with `registerSideView('reader', { label, render })`.
   - **Toolbar:** a new side panel button (`#side-btn`) opens the last view. The Lumio AI button and its shortcuts open the chat.
   - **Remembering:** the last view is saved in `sidePanelView`. The bookmarks bar's "All bookmarks" opens the Bookmarks view.
4. **Sync:** two new collections, `readingList` and `savedGroups`, in `main/sync/adapters.js`. The server's allowed list in `server/src/sync.ts` has them too.
   - Both are "optional", so they only sync with a server that lists them.
   - **Choice I made:** the reading list follows the Bookmarks sync switch and saved groups follow the Open tabs switch. I didn't add new switches.

### 3. Tests: done
- **New unit tests:** `tests/tab-groups.test.mjs` covers groups, saved groups and the reading list.
- **New headless UI tests:** `tests/organize-ui.test.mjs` covers the chips, editor, saved groups on the bar, the side panel views, light and dark, and the star's reading list button.
- **Sync:** a new test in `tests/sync-engine.test.mjs` syncs the reading list and saved groups between two computers.
- **Server:** the test now checks that the server lists the new collections.

### 4. Skeptical review: done
A separate subagent did the review and fixed its findings in commit 8336bd5. Screenshots are in `dist/review-shots/`.

## Review findings
| Severity | Where | Problem | Fixed |
|---|---|---|---|
| Medium (security) | `main/search-engines.js` | A search engine synced from another device could use a `lumio:`, `file:` or `javascript:` URL. | Yes: http(s) URLs with `%s` only. |
| Medium | `renderer/ui/side-panel.js` | The Lumio AI button or ⌘⇧L reopened the panel on the last side view instead of the chat. | Yes |
| Medium (a11y) | `renderer/ui/side-panel.js` | Tab couldn't reach the side panel's rows. | Yes |
| Medium (data loss) | `main/main.js` before-quit | Reading list and saved group changes made just before quitting were lost. | Yes: both files are written on quit. |
| Low/Medium | `main/groups-service.js` | One saved group open twice: both copies overwrote it. | Yes: only the first copy follows. |
| Low | `main/groups-service.js` | Deleting a saved group left the open group's chip looking saved. | Yes |
| Low | `renderer/pages/ntp-shortcuts.css` | With only a few shortcuts, they sat off to the left. | Yes |
| Low | `main/bookmarks.js` `legacyEntries` | Positions in the old flat list shift, so many bookmarks upload again when one is added. | No: a fix needs older versions of Lumio to change too. |
| Low | `main/bookmarks.js` `applyLegacy` | A delete from an older device removes every bookmark with that address. | No: rare, and older devices can't tell bookmarks apart. |
| Low | `renderer/ui/overlay-groups.js` | The editor's buttons don't change when the group changes elsewhere while it's open. | No: minor. |
| Low | `bookmarks-service.js` and `groups-service.js` | A `null` message to these handlers would throw. | No: only Lumio's own window can send them. |

## Not done
- **Not done, from the omnibox item (see EARLIER.md):** learning which suggestion was picked for a prefix, icons on suggestion rows, and preconnecting to the top suggestion.
- **Not added for tab groups:** multi-tab selection (Lumio has none), shared groups, and a "Tab groups" menu.
- **Smaller gaps:** Reopen Closed Tab doesn't put a tab back in its group. The side panel always shares the right column; there's no setting to put it on the left.

## Test counts
- Root `npm test`: 252 tests, 247 pass, 0 fail, 5 skipped. These are the same 5 skips as before (Mac-only and Windows-only tests). The starting point was 229 tests, 224 pass.
- Server: 38 tests, 38 pass.

## E2E tests (written, not run here)
- **New file `tests/e2e/organize.e2e.mjs`:**
  - "tab groups: a chip in the strip, collapse, the editor, and the session keeps them through a restart"
  - "a tab opened from a grouped tab joins the group; ungroup keeps the tabs"
  - "move group to new window takes its pages along, still grouped"
  - "saved groups: save, close, then reopen from the bookmarks bar"
  - "reading list: add the page, see it in the side panel, open it to mark it read"
  - "incognito: no reading list or saved groups"
- **From the earlier runs:** `tests/e2e/bookmarks.e2e.mjs` (6 tests), `tests/e2e/omnibox.e2e.mjs` (7), and 1 added to `tests/e2e/welcome.e2e.mjs`.

## Risky
- **Tab strip in `renderer/ui/shell.js`:** `renderTabs` now places elements through `tabGroups.layout()`, which also adds the group chips. Tab drag uses only the visible tabs and sends the index in the real tab list. Anything else that assumes `#tabs` holds only `.tab` elements needs checking.
- **`main/tabs.js` `changed()`** now calls `groups.normalize()`, which keeps each group's tabs together and can reorder tabs.
- **New window and panel elements:**
  - **Group CSS:** `.tab.grouped` has its own transitions.
  - **Side panel classes:** `body.side-other` hides the chat's parts while another view shows.

## Merge hints (shared files I changed)
- **`main/main.js`:**
  - **New lines:** the requires and the `groups`/`sidePanel` variables, and two new entries in `services`.
  - **Changed lines:** `onSessionChanged`, `tabContextMenu`, the `shell:init` fields, the `registerIpc` registrations, and the session restore and reopen lines that now pass `groups`.
  - **Other:** new `cmd.sidePanel` and `cmd.addToReadingList`, the sync adapters list, the before-quit flush, and the `global.lumio` getters.
- **`main/tabs.js`:**
  - **`create`:** a new `groupId` option.
  - **Tab lifecycle:** `insert`, `activate` and `move` each gained a line, and so did `restore`.
  - **Window state and session:** `state()`, `sessionTabs()` and `changed()` each gained a line.
  - **Context menu:** two reading list items.
- **`main/window.js`:** `groups` in the constructor options, `restore` and `session()`, and a `readingList` hook.
- **`main/menu.js`:** reading list items in both Bookmarks menus.
- **`preload/shell.js`:** the one-line `INVOKE`/`SEND` regexes and the `EVENTS` list (very likely to conflict).
- **`main/sync/adapters.js`:** two new adapters and the exports line.
- **`server/src/sync.ts`:** the `COLLECTIONS` line.
- **`renderer/ui/`:**
  - **`shell.js`:** imports, `renderTabs`, `startTabDrag` and init.
  - **`shell.html`:** stylesheets, `#side-btn`, and `#side-switch`/`#side-view` inside `#panel`.
  - **`ai-panel.js`:** `close()` and `isOpen()`.
  - **`overlay.js` and `overlay.html`:** one import and one stylesheet.
- **`renderer/assets/theme.css`:** 11 `--group-*` tokens.
