# Chrome extensions in Lumio Browser

Lumio runs Chrome Web Store extensions in normal windows (not in Incognito: Electron can't
load extensions into an in-memory session). Three layers give extensions their `chrome.*` APIs:

1. **Electron 43** (built in): the extension system itself, content scripts, extension pages,
   MV3 service workers, and these APIs:
   `chrome.runtime` (messaging, `getManifest`, `getURL`, `onInstalled`), `chrome.storage`
   (local, sync and session, kept on this computer), `chrome.i18n`, `chrome.scripting`,
   `chrome.tabs` (part), `chrome.webRequest` (observing; blocking only where Electron allows),
   `chrome.extension`, `chrome.management` (part) and the `chrome.devtools.*` panels.
2. **electron-chrome-extensions 4.9** (`main/extensions.js`): `chrome.action` /
   `browserAction` (toolbar buttons, badges and popups), `chrome.tabs` and `chrome.windows`
   (query, create, update, remove, events), `chrome.contextMenus`, `chrome.commands`
   (`getAll`, `onCommand`), `chrome.cookies`, `chrome.notifications`, `chrome.permissions`,
   `chrome.webNavigation` (`getFrame`, `getAllFrames`, events), `chrome.runtime.openOptionsPage`
   and native messaging (`connectNative`, `sendNativeMessage`) with the apps installed for
   Chrome (some desktop apps, such as password managers, only answer Chrome itself).
3. **Lumio's stand-ins** (`main/extension-shims.js`, `preload/extension-shims.js`), added only
   when the extension asks for the permission and the API is missing:
   - `chrome.alarms`: timers kept by Lumio (and on disk), so they wake the service worker and
     survive a restart. The shortest alarm is 30 seconds, like in Chrome. This one replaces
     Electron's own `chrome.alarms`, whose alarms never go off.
   - `chrome.sidePanel`: the panel page opens in a new tab, also when
     "open the side panel on toolbar click" is set.
   - `chrome.identity`: `launchWebAuthFlow` opens the sign-in page in a small window and hands
     back the `https://<id>.chromiumapp.org/…` address; `getRedirectURL` works.
     `getAuthToken` (Chrome's own Google account) isn't possible and returns an error.

Lumio's own extension features (not APIs): pinning toolbar buttons, site access per extension
("When you click the extension", "On specific sites", "On all sites"; `main/extension-access.js`
loads a limited copy of the extension; with "When you click the extension" its button still works
but it can't read sites, because Electron has no `activeTab` grant on a click), "Allow access to file URLs", keyboard shortcuts for
extension commands (lumio://extensions/shortcuts; `main/extension-commands.js`), Pack extension
(CRX3 + .pem; `main/extension-pack.js`) and the new tab page override
(`chrome_url_overrides.newtab`) with the "Change it back / Keep it" question.

## Not available

These are missing from Electron and the library; an extension's details page lists the ones it
asks for under "May not work fully in Lumio" (`limitations()` in `main/extension-access.js`):

- `chrome.declarativeNetRequest` (rule-list blockers such as uBlock Origin Lite block nothing),
- `chrome.history`, `chrome.bookmarks`, `chrome.topSites`, `chrome.sessions`, `chrome.readingList`,
- `chrome.downloads`, `chrome.tabGroups`, `chrome.debugger`, `chrome.privacy`, `chrome.proxy`,
- `chrome.tts`, `chrome.ttsEngine`, `chrome.tabCapture`, `chrome.desktopCapture`, `chrome.gcm`,
- `chrome.identity.getAuthToken`, and Manifest V2 background pages behave like Electron's
  (MV2 is no longer supported by Chrome either).

Extensions never run on Lumio's own pages (`lumio://`) and can't open them.
