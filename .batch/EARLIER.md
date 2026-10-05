# Earlier work in this batch (b5)
# Earlier work in batch b5 (rebuilt from logs)

## omnibox — FINISHED (run wf_795b670e-e17)

I built all six omnibox items. `npm test` passes: 195 tests, 192 pass, 0 fail, 3 skipped (the 3 skips are Windows-only, the same as before). The baseline was 154; I added 41 unit and headless tests. I wrote 8 new e2e tests but didn't run them, per the rules; they run on CI. No server changes, no new dependencies, no new theme tokens, and nothing committed.

**Per item**
1. **Remote search suggestions — done.** Uses each engine's public suggest endpoint (Google, DuckDuckGo, Bing, Brave), plus suggest URLs for site search and OpenSearch engines. They're requested 150 ms after typing pauses, a newer request cancels the older one, and results are cached briefly and capped at 64 KB. Requests send no cookies or referrer.
   - Never sent in incognito, or for addresses, IPs, localhost, file paths, other schemes or @scopes.
   - Never sent for text that looks private: emails, 9+ digit numbers, "password:", API keys, or long mixed-case words with digits.
   - Settings › Privacy has the "Improve searches and browsing" toggle, on by default.
2. **Inline autocomplete — done.** Ranking uses frecency (visits weighted by how recent they are; typed addresses count double). Completion only happens for sites or pages typed before or visited often, and only matches from the start of the host or address. Typing the next letter keeps the completion; Backspace removes it. Clearing or deleting history also forgets typed addresses.
3. **Switch to tab, scopes, actions — done.**
   - Open tabs in other windows show as "Switch to this tab"; normal and incognito windows never see each other's tabs.
   - `@tabs`, `@bookmarks`, `@history` and `@lumio` work with a space, or Tab after a partial like `@ta`.
   - Actions: Clear browsing data, Manage passwords, Open settings, New incognito window.
4. **Keys and answers — done.** Paste and Go / Paste and Search are in a new right-click menu on the address bar, and on Cmd/Ctrl+Shift+V. Also:
   - Shift+Delete or a × button removes a history row.
   - Alt+Enter opens a new tab, Shift+Enter a new window, Ctrl+Enter adds www. and .com.
   - Calculator answers (own parser, no eval) and unit conversions for length, weight, volume, time, speed and temperature. Picking the answer row copies the result.
5. **Zero-suggest and clipboard link — done.** Clicking the empty bar (or ArrowDown, or deleting all text) shows the most-visited pages, at most 2 per site. It doesn't open just because a new tab focuses the bar. The clipboard is read only then, never in incognito, and only http(s) links without a username or password are shown.
6. **Search engines — done.**
   - Settings › Search engine has a select that includes added engines, plus a manager: add/edit/delete, make default, and turn on engines found on sites.
   - Site search chips: "yt cats", or "yt" + Tab. Built-in domains like google.com need Tab, so typing "google.com something" still searches normally.
   - OpenSearch detection adds inactive entries: https pages only, same site, once per file, at most 50.
   - The welcome flow has a new choice step (random order, nothing preselected). `searchEngines` and `searchSuggest` sync; found engines stay on the device.

**Behaviour changes to know about**
- **Ctrl+Enter on Windows changed** from "new tab" to adding www. and .com, as in Chrome. New tab is now Alt+Enter; Cmd+Enter on the Mac still opens a new tab.
- **"Link you copied" timing is an estimate.** Electron can't tell when something was copied, so Lumio counts from when it first saw it (from launch for the first look).
- **YouTube (`yt`) and Wikipedia (`wiki`) come ready as site search.** Typing "wiki something" therefore searches Wikipedia. People can delete both.
- **Clicking × in the dropdown closes it** and shows a "Removed from history" toast, because clicking the dropdown takes focus from the bar. Shift+Delete keeps the list open.
- **Clear browsing data** calls `cmd.clearBrowsingData` if the privacy team adds it; otherwise it opens Settings › Privacy.
- **Welcome e2e changed:** the flow now has the search step, and the test chooses DuckDuckGo on the way.

**Likely merge conflicts and what's left**
- **Likely merge conflicts:** the one-line lists in `preload/shell.js` (the allowed send channels) and in `main/sync/adapters.js` (synced settings); other teams may edit the same lines. The other shared files have small edits.
- I moved the omnibox code out of `renderer/ui/shell.js` into the new `renderer/ui/omnibox.js`. That's 74 lines removed from shell.js, which may conflict if another team edited those same lines.
- **Not done:**
  - Learning which suggestion was picked for a given prefix.
  - Favicons on suggestion rows (left for the polish team).
  - Preconnecting to the top suggestion.
  - Ticking the boxes in `docs/launch-plan.md` (shared file).

**Files** (all in `/Users/juan/Developer/lumio-browser-b5`)
- New: `main/omnibox-answers.js`, `main/omnibox-service.js`, `main/search-engines.js`, `main/search-suggest.js`, `renderer/ui/omnibox.js`, `renderer/ui/omnibox.css`, `renderer/pages/search-engines.js`, `renderer/pages/search-engines.css`
- Changed: `main/main.js`, `main/omnibox.js`, `main/tabs.js`, `main/sync/adapters.js`, `preload/shell.js`, `renderer/ui/shell.js`, `renderer/ui/shell.html`, `renderer/ui/overlay.js`, `renderer/ui/overlay.css`, `renderer/pages/settings.html`, `renderer/pages/settings.js`, `renderer/pages/welcome.html`, `renderer/pages/welcome.js`, `renderer/pages/welcome.css`
- New tests: `tests/omnibox-depth.test.mjs` (16), `tests/search-engines.test.mjs` (6), `tests/omnibox-service.test.mjs` (11), `tests/omnibox-ui.test.mjs` (8)
- E2E (not run here): new `tests/e2e/omnibox.e2e.mjs` (7); `tests/e2e/welcome.e2e.mjs` gains 1 test for the search step

## bookmarks — INTERRUPTED by a usage limit (run wf_795b670e-e17); its partial edits are in the working tree. Its last notes:

Now the shell side: a new bookmarks bar module.
Now the overlay module: folder menus with submenus and the edit bubble.
Now the bookmark manager page.
You've hit your session limit · resets 4:50am (America/New_York)

## groups-lists — INTERRUPTED by a usage limit (run wf_795b670e-e17); its partial edits are in the working tree. Its last notes:

You've hit your session limit · resets 4:50am (America/New_York)

## tests — INTERRUPTED by a usage limit (run wf_795b670e-e17); its partial edits are in the working tree. Its last notes:

You've hit your session limit · resets 4:50am (America/New_York)

## review — INTERRUPTED by a usage limit (run wf_795b670e-e17); its partial edits are in the working tree. Its last notes:

You've hit your session limit · resets 4:50am (America/New_York)

## bookmarks — INTERRUPTED by a usage limit (run wf_161566c2-c19); its partial edits are in the working tree. Its last notes:

Update the server test to expect the `collections` field and accept `bookmarkTree` records.
You've hit your session limit · resets 9:50am (America/New_York)

## groups-lists — INTERRUPTED by a usage limit (run wf_161566c2-c19); its partial edits are in the working tree. Its last notes:

You've hit your session limit · resets 9:50am (America/New_York)

## tests — INTERRUPTED by a usage limit (run wf_161566c2-c19); its partial edits are in the working tree. Its last notes:

You've hit your session limit · resets 9:50am (America/New_York)

## review — INTERRUPTED by a usage limit (run wf_161566c2-c19); its partial edits are in the working tree. Its last notes:

You've hit your session limit · resets 9:50am (America/New_York)
