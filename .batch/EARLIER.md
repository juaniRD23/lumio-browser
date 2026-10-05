# Earlier work in this batch (b6)
# Earlier work in batch b6 (rebuilt from logs)

## site-controls — FINISHED (run wf_736ff4a0-233)

All six site-controls items are built and `npm test` passes: 189 tests, 186 passed, 0 failed, 3 skipped (Windows-only). I could not run the Electron app or the e2e suite here, so the new e2e tests and anything that depends on real Chromium behaviour are unproven until CI runs them.

**What I built**

1. **Permission prompts — done.** The infobar is gone. A chip in the address bar opens a bubble with "Allow while visiting the site", "Allow this time" and "Don't allow". Notifications and automatic downloads get only Allow / Don't allow, like Chrome.
   - "Allow this time" lasts until the tab leaves the site or closes.
   - Notifications are quiet by default: only a crossed-out chip shows, and clicking it offers "Allow for this site". I chose this deliberately; it is a change from Chrome.
   - Anything blocked on the page (a permission, JavaScript, images) shows a crossed-out icon that shrinks after 6 seconds.
   - Each category has a default you can change.
   - Window management is no longer granted without asking. Screen capture is now asked every time, then the existing picker opens. Reading a file the person picked is allowed without a prompt.
   - Keyboard: arrows move between buttons, Esc returns focus to the chip, Enter answers.
2. **Site settings pages — mostly done.** There are pages for Site settings (lumio://settings/content), every category, All sites, one site's page and Third-party cookies (lumio://settings/cookies). They have allowed/blocked lists you can add to, a Reset permissions button, and Delete data behind a confirmation. The site info popup's "Site settings" button opens the site's page, and the popup now shows defaults, a cookie count, Reset permissions and a "Reload to apply" note.
   - **Storage use:** Electron has no storage-use API, so it comes from the DevTools protocol. It counts databases, offline files and service workers, but not cookies or localStorage.
   - **USB, HID, serial and Bluetooth (partial):** these pages exist and blocks apply, but there is no device picker, so allowed sites still can't connect. The pages say so.
   - **Protected content:** the setting works, but video playback still depends on the DRM work in the launch-blockers batch.
   - **Pop-ups:** the setting and its lists are stored, but the launch-blockers team's pop-up blocker must read it: `profile.permissions.settings.value(origin, 'popups') === 'allow'`.
3. **Content toggles — done, with limits.**
   - **JavaScript off:** adds a `script-src 'none'` policy to the site's pages and frames and stops its scripts loading. Pages restored from the back/forward cache keep running until reloaded, and `<noscript>` content won't show. Blocking one site also removes its service worker; changing the default to block does not remove other sites' service workers.
   - **Images off:** the site's image requests are cancelled.
   - **Insecure content:** allowing a site rebuilds its tab (keeping history) with insecure content allowed, and the tab is rebuilt safe when it leaves. This is the riskiest piece and has no e2e test (it needs HTTPS fixtures).
   - **Automatic downloads:** a page's second download without a click or key press in between asks first. "Save link as" never counts.
   - **Sound:** a muted site's tabs are muted when they arrive.
   - **PDFs:** a global "Download PDFs" option makes Chromium save them instead of opening them.
   - **Autoplay:** global setting, blocked by default, and it only applies to tabs opened after the change.
4. **Third-party cookies — done, with one gap.** Allow / Block in Incognito (default) / Block, plus "allowed" exceptions per site. Cookies are dropped only on requests to a different site than the tab's page; there's no public suffix file. Lumio asks Chromium's own list by setting a test cookie in a throwaway session, and falls back to a small built-in list if that check fails. The gap: a third-party frame's own scripts can still read `document.cookie`; the page explains this.
   - **For the privacy-extras agent:** the network hook lives in `main/privacy.js`. Add Do Not Track / GPC with `privacy.hooks(session).add({ name, active, beforeSendHeaders(details, headers) {} })`, then call `.refresh()` when a setting changes. Register it for both the normal and incognito sessions, for example in the `SiteControls` constructor.
5. **Delete browsing data — done.** It's its own page (lumio://settings/clearBrowserData), opened with ⇧⌘⌫ / Ctrl+Shift+Del, from the menus, Settings › Privacy and the History page. It has Basic/Advanced tabs, all six time ranges, counts ("From 58 sites") and remembers your last choices. The old History-page dialog and the inline clear row in Settings are removed.
   - Electron cookies carry no creation time, so a new tracker records when each cookie first appears. Cookies older than this update are treated as old and kept when deleting a time range.
   - Storage is deleted for sites visited or setting cookies in the range.
   - The cache can only be emptied all at once; the dialog says "Always all time".
   - "Autofill form data" and "Hosted app data" show as disabled rows because Lumio saves neither.
6. **Delete site data when you close all windows — done.** This is "On-device site data" in Site settings, with Allowed and Clear-on-exit lists. It runs when Lumio quits (quitting waits up to 5 seconds), when the last window closes on Windows/Linux, and again at startup in case the last quit didn't finish.

**Other changes to know about**
- Old stored permission names (camera-and-microphone as one setting, clipboard, MIDI) are moved to the new categories once on upgrade.
- Incognito inherits blocks and content settings from normal windows, but never "allowed" permissions.
- Removed: the `page:set-site-permission` handler, `sitePermissions` in `page:settings`, the infobar CSS, and the History page's clear dialog.
- I didn't tick items in `docs/launch-plan.md`, to avoid merge conflicts.

**Files**
- New: `main/site-settings.js`, `main/sites.js`, `main/privacy.js`, `main/site-controls.js`, `main/site-data.js`, `main/browsing-data.js`, `main/site-ipc.js`, `renderer/assets/site-icons.js`, `renderer/ui/permission-chip.{js,css}`, `renderer/ui/overlay-site.{js,css}`, `renderer/pages/site-settings.{html,js,css}`, `renderer/pages/clear-data.{html,js,css}`
- Changed: `main/features.js` (Permissions rewritten, download gate), `main/main.js`, `main/tabs.js`, `main/window.js`, `main/menu.js`, `main/protocol.js`, `preload/shell.js`, `renderer/ui/shell.{html,js,css}`, `renderer/ui/overlay.{html,js}`, `renderer/pages/settings.{html,js,css}`, `renderer/pages/history.{html,js,css}`

**Tests**
- Unit (24): `tests/site-settings.test.mjs` covers the settings model, site lookup, network hooks, third-party cookies, the prompt flows, JavaScript/images/PDF handling, the download gate, sound, insecure-content checks, data on exit, Delete browsing data, and tab rebuild history.
- Headless Chrome (11): `tests/site-settings-ui.test.mjs` covers every new page in light and dark, the chip, the bubble (keyboard included) and the site info popup.
- e2e, CI only, not run here: `tests/e2e/site-controls.e2e.mjs` (12 tests), and the History test in `browser.e2e.mjs` now uses the new page.
- Two e2e checks are unverified assumptions: whether Electron includes the Cookie header in its request hooks, and whether Chromium sends cross-site cookies to http://localhost. The third-party cookie test skips itself if the second one doesn't hold.

## security — INTERRUPTED by a usage limit (run wf_736ff4a0-233); its partial edits are in the working tree. Its last notes:

Now I have a thorough understanding of the codebase. Let me start writing the pure modules, beginning with the bundled lists.
You've hit your session limit · resets 4:50am (America/New_York)

## tests — INTERRUPTED by a usage limit (run wf_736ff4a0-233); its partial edits are in the working tree. Its last notes:

You've hit your session limit · resets 4:50am (America/New_York)

## review — INTERRUPTED by a usage limit (run wf_736ff4a0-233); its partial edits are in the working tree. Its last notes:

You've hit your session limit · resets 4:50am (America/New_York)

## security — INTERRUPTED by a usage limit (run wf_96df48cb-e5e); its partial edits are in the working tree. Its last notes:

Now the interstitial (warning) page.
Now theme tokens.
Now the Security / Tracking protection sub-page.
You've hit your session limit · resets 9:50am (America/New_York)

## tests — INTERRUPTED by a usage limit (run wf_96df48cb-e5e); its partial edits are in the working tree. Its last notes:

You've hit your session limit · resets 9:50am (America/New_York)

## review — INTERRUPTED by a usage limit (run wf_96df48cb-e5e); its partial edits are in the working tree. Its last notes:

You've hit your session limit · resets 9:50am (America/New_York)
