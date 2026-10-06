# Merge report: v0.6.8 (merge-v0.6.8)

All ten "Chrome parity" batches are merged into `merge-v0.6.8`, starting from `features-v0.6.3`. This file is for the owner and should be removed before the public merge.

Nothing ran in Electron or e2e here; that happens on the Mac CI. No deploys, releases, tags, PRs or issues were made. No secrets were added.

## Batches merged, in order

Each merge commit's message has the details. In short:

1. **batch2-launch-blockers** (ea2857d). No conflicts.
2. **batch3-motion** (0153ca3).
   - The overlay's show/in/out steps also draw batch 2's blocked pop-ups list.
   - The ⋮ menu's Help keeps Terms, Privacy and licenses.
   - `focusPane` sits next to batch 2's pop-up-aware print, save and find.
3. **batch4-navigation** (c2f9c1d).
   - Strip extras (selection, tear-off, scrolling) run inside batch 3's animated strip.
   - The zoom bubble and tab search use the overlay's steps.
   - Crashed or hung tabs reload the page that died.
   - Closed tabs keep their history.
   - Help menus keep both Help and the legal pages.
   - Sync SETTINGS union. Ctrl+J opens Downloads.
4. **batch5-organize** (e4a4c4d).
   - Tab groups' chips go through batch 3's animated strip.
   - Group and reading list items join batch 4's tab menu and act on every selected tab.
   - Bookmarks, the group editor and suggestions use the overlay's steps.
   - The omnibox keeps batch 3's look.
   - Sessions keep groups along with each tab's history.
   - Bookmark All Tabs makes a folder.
5. **batch6-privacy** (6139005).
   - Site settings back the permissions. The pop-up blocker reads Site settings › Pop-ups and redirects (`allowsPopups`).
   - The permission chip replaces the window's permission bar.
   - Delete browsing data is its own page.
   - The AI can't get past warning pages.
6. **batch7a-platform** (61c5855).
   - Every service is per profile: bookmarks, groups, side panel and reading list, search engines, NTP shortcuts, Customize, site data, Delete browsing data (`addProfileServices`, `profileIpc`).
   - Crash restore stays with the first profile.
   - The ⋮ menu gains Task manager.
   - Reset settings also clears the other batches' settings.
   - Spanish for batches 2–6.
7. **batch7b-page-tools** (704564d). The page tools are per profile where they hold profile data:
   - Translator and reader settings belong to each profile.
   - Send to your devices uses the window profile's sync and companion. Nothing is sent from incognito.
   - Installed apps remember their profile's session and permissions. Guest can't install apps.
   - Started from an app launcher, the profiles come back with the first browser window (`startWaitingProfiles`).
   - The popovers use the overlay's steps.
   - ⋮ gains Save and share, Translate… and Reading mode.
8. **batch7c-autofill-extensions** (2a6a23b).
   - AutofillManager and ExtensionsUI are per profile. Extension buttons use the profile's partition.
   - Sync adds passkeys, addresses and cards (the SETTINGS and COLLECTIONS unions). The engine handles both optional and refused collections.
   - Help is app-wide, with the window's account and profile folder.
   - 7c's Mac menu bar is merged with batch 4/5/7a items. Stop shows everywhere.
   - The AI is kept off settings, extensions, flags-lite, passwords, version and apps.
9. **batch7d-layout** (bf72189).
   - Tabs to the side follow the profile's setting. Shortcuts, caret browsing, force dark and protocol handlers are app-wide.
   - `menuTemplate()` applies picked shortcuts to the app menu, and the ⋮ entries follow them.
   - Split view is merged with batch 4's close, detach and zoom and batch 5's groups, restore and session.
   - Split items, Name Window and layout items join batch 4's tab and strip menus.
   - Strip drags: dropping on a 15% edge zone makes a split view; anywhere else in the page tears the tab off.
   - The flyout and Name Window use the overlay's steps.
   - Force dark is one setting (seam 4).
   - There is now one `page:relaunch` (7a System), instead of three.
10. **batch8-crash-drm** (c95d5dc).
    - The DRM wait is in `startProfile`, before the first window (seam 2).
    - The crash-reports setting is in the root settings; Guest can't change it.
    - The AI is also kept off lumio://welcome.
    - Settings has the "Help improve Lumio" card. Protected content IDs sit under Site settings.
    - Server: feedback, crashes and crash_attempts are in schema.sql, and both routes and cleanups are registered once. /admin shows both.

## Seams

| # | Seam | Status |
|---|---|---|
| 1 | Pop-up blocker honors batch 6's per-site Pop-ups | Done (6139005), tested in tests/popups.test.mjs |
| 2 | DRM wait in startProfile before the first window | Done (c95d5dc), tested in tests/drm.test.mjs |
| 3 | Settings is one coherent page | Done. Sections from 3, 4, 6, 7a, 7c, 7d and 8 each appear once. The side links, scroll-spy and 7a's search (which scans the DOM when you type) cover all of them. Keyboard sits before Accessibility. |
| 4 | Force dark is one setting | Done. The flags-lite flag is removed; an old `flags.forceDark` migrates to `forceDarkPages`. flags-lite links to Settings › Appearance. |
| 5 | Reading mode in the side panel's switcher | Done (3c52a86) |
| 6 | Tab strip across batches | Done (7090e42). Group actions work on multi-select, and drags keep groups. Vertical tabs show groups (header row, collapse, editor). Hover cards work in vertical tabs and show per-tab memory from 7a. |
| 7 | Context menus without duplicates | Done (34302fb), with a test |
| 8 | ⋮ lists every batch's commands with their shortcuts | Done (23413c4). tests/merged-menus.test.mjs |
| 9 | Shortcut customization lists every command, with no duplicate keys | Done (23413c4) |
| 10 | Spanish covers every batch's strings | Done (cfbdf27). About 600 entries plus tests/i18n-js.test.mjs. Strings that go back to web pages (error messages) and brand or file names stay English. |
| 11 | Session file across batches | Done (dbb2123). `windowOptions` keeps history, groups, split, layout and name. Old files still load. |
| 12 | Sync: union of settings and data types, with tests | Done (e038778). tests/sync-integration.test.mjs. Form autocomplete entries and spellcheck dictionary words don't sync yet: that needs a new collection plus a server deploy. |
| 13 | Server schema, migrations, routes and wrangler | Done (e038778). server/test/schema.test.mjs |
| 14 | Theme tokens, light/dark, reduced motion | Done. The color-literal test is green and new CSS uses tokens. Batch 3's reduced motion keeps 1 ms transitions, and tests account for that. |
| 15 | e2e names, helpers and merged behavior | Done (cfbdf27). There are no duplicate names, and imports resolve. The tests were not run here. |
| 16 | docs/launch-plan.md | Done (2aac9e8). 191 items done, 31 partly, 10 not done, plus a "Status after the v0.6.8 merge" section. |

Also done along the way:

- Links from a second launch now wait until startup has finished (batch 8 low finding 4).
- Protocol handlers now ask through batch 6's chip, and permission answers use decisions throughout. The e2e pass found these.
- `server/package.json`'s schema script now names the real database (`lumio`).

## Final review findings

REVIEW_PLACEHOLDER

## Tests

FINAL_TESTS_PLACEHOLDER

## e2e files most likely to fail on the Mac CI

- **power-user.e2e.mjs**: the protocol-handler flow, now through the chip and bubble, has never run in Electron. The force-dark relaunches check screen pixels.
- **layout.e2e.mjs**: the new real-mouse edge-drag test is the first run of synthesized pointer input through pointer capture. If it fails, look at the timing between moves first.
- **popups.e2e.mjs**: several real pop-up windows. The window-management bubble only opens when nothing else is open. It also depends on download interception.
- **tabs.e2e.mjs**: native tab and strip menus (`Menu.popup`), tear-off windows, the Dock badge, and a forced renderer crash.
- **share-media.e2e.mjs**: the app launcher `.app`, Picture in Picture, clipboard images, and window focus for `navigator.share`.
- **extensions.e2e.mjs**: Handoff, Mac menu labels and roles, and Web Store extension loading.
- **drm.e2e.mjs** and **crash-reports.e2e.mjs**: timing (the DRM wait now comes after the 4 s extensions wait), relaunches, and a real Crashpad minidump upload.
- **account / autofill / welcome / security**: Keychain, Touch ID and passkeys, security keys, and network access (Safe Browsing list).
- **profiles.e2e.mjs**: multiple windows, the picker, and timed Guest deletion.
- **navigation.e2e.mjs**: swipe gestures.

## Server deploy steps (not done here)

Run from `server/`.

1. Run the two new migrations, in this order. They are independent of each other.
   1. `npx wrangler d1 execute lumio --remote --file migrations/2026-10-05-feedback.sql`
   2. `npx wrangler d1 execute lumio --remote --file migrations/2026-10-05-crashes.sql`

   If production predates v0.6.3, first run `2026-10-02-sync.sql`, `2026-10-03-plan-codes.sql` and `2026-10-03-step-timing.sql`. Step-timing reports "duplicate column" if its columns are already there; that's harmless.
2. Deploy the Worker (`npx wrangler deploy`). Do this before or together with the app release: Report an issue, crash reports, `/v1/translate` and the new sync collections need it. Older clients keep working.
3. New secrets or vars: none are required. Optional: a `CRASH_IP_SECRET` to HMAC crash IP hashes (batch 8 low finding 3); the code doesn't read it yet.
4. Website: bump privacy.html's "Last updated" date, then redeploy the site (/admin shows the issue reports and crashes).

## Still needs the owner

- Mac CI e2e runs and checks on a real Mac (menus, Handoff, Touch ID, launchers, force dark).
- DRM: a castlabs EVS account and secrets, VMP signing, and pinning the castlabs-evs version (docs/drm.md).
- Known gaps from the batch reports:
  - passkeys and autofill don't work in installed-app windows (7b);
  - the autofill dropdown's ARIA (7c);
  - the AppleScript dictionary (7c);
  - extensions in incognito (an Electron limit).
- See docs/launch-plan.md's closing section for the full list.
