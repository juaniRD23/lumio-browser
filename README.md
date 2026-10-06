# Lumio Browser

A Chromium web browser with **Lumio AI** built in. Lumio sits in a side panel next to the page. Ask it anything, or tell it what to do: it reads and operates web pages, and with your permission it controls your computer too. It asks before it acts.

**Download:** [lumio-browser.gw607953.workers.dev](https://lumio-browser.gw607953.workers.dev) · macOS 14+ (Apple silicon and Intel) · Windows 10/11 (x64)

## What it does

- **An AI that does things.** Lumio reads the page you're on, clicks, types, fills forms, scrolls and opens tabs, using real mouse and keyboard input. It can also see your screen and use other apps on your Mac or PC.
- **You stay in control.** Three approval modes: **Ask** (confirm every action), **Auto** (browse on its own, ask before touching your computer), **Bypass**. While Lumio works, the page (or, when it controls your computer, the whole screen) glows blue with a **Stop** button. Esc stops it too.
- **Task progress.** For bigger jobs, Lumio keeps a checklist above the chat box and ticks off steps as it goes.
- **Safe by design.** Page content is treated as untrusted data, never as instructions. Lumio never types passwords, payment or ID details. It stops to confirm before anything irreversible.
- **Runs on your Lumio plan.** Sign in with a Lumio account and the AI runs on your plan. Every plan includes some use each week, Free too, and Go, Plus, Pro and Max include much more. It uses one fast, inexpensive model (GPT-6 Luna); you choose how hard it thinks (Low, Medium or High) right under the chat box.
- **Everything a browser needs:**
  - tabs, multiple windows, pinned tabs, incognito windows, find, zoom, downloads, and a PDF viewer;
  - history search with time-range clearing;
  - a bookmarks bar and bookmark manager;
  - site permissions, and importing from Chrome, Edge, Brave, Arc or Vivaldi;
  - **translate pages** in place with Lumio AI, and a **reading mode** that reads articles aloud;
  - **Share**: copy a link, a QR code made on your computer, send a tab to your other computers, screenshots you can mark up, and the Mac's share sheet;
  - **media controls** in the toolbar for every tab that plays, with Picture in picture;
  - **install sites as apps** in their own window, with a launcher in Applications on the Mac;
  - **Chrome extensions** from the Chrome Web Store;
  - a **password manager** that saves, fills, generates, and imports or exports CSV, encrypted with your system keychain;
  - **updates in one click**: when a new release is out, a blue Update button appears next to your profile picture.

## Install

**Mac:** open the `.dmg` and drag Lumio Browser to Applications. The app isn't signed with an Apple Developer ID yet, so the first time you open it macOS blocks it. Go to **System Settings → Privacy & Security**, scroll down, click **Open Anyway**, and confirm.

**Windows:** unzip, open the folder, and run `Lumio Browser.exe`. Windows SmartScreen may say it protected your PC; click **More info → Run anyway**.

To let Lumio control your Mac, turn on Lumio Browser under **Accessibility** and **Screen Recording** in System Settings → Privacy & Security. Settings → Lumio AI has shortcuts.

## Build from source

Requires Node 22+ and, for the Mac helper, Xcode command-line tools.

```sh
npm install
npm start                # run from source
npm test                 # unit tests
npm run test:e2e         # end-to-end tests (drive the real app)
npm run install:app      # build and install /Applications/Lumio Browser.app
npm run release          # dist/release: Mac DMGs (Apple silicon, Intel) and a Windows ZIP
```

## How it's built

- **Electron 43.** Each tab is a `WebContentsView`, and each window has one shell page (`renderer/ui`) and one AI controller.
- **Agent:** `main/ai` holds the agent loop, the approval policy, browser tools, and computer tools. Computer tools go through a small native helper: Swift on macOS (`native/LumioHelper`), PowerShell on Windows (`native/windows`).
- **Lumio account:** `main/account.js` uses the lumio-usa.online desktop sign-in hand-off. `main/ai/lumio.js` runs the AI through the account's plan (`/api/browser/agent`); the server owns the model, the tool definitions and the system prompt.
- **Passwords:** `main/passwords.js` and `main/password-manager.js`, plus the isolated preload in `preload/internal.js`. Each password is encrypted with Electron `safeStorage`.
- **While it works:** `main/ai/indicators.js` (page glow and Stop bar) and `main/ai/screen-aura.js` (screen glow and Stop pill, left out of screen captures). `main/ai/tools/plan.js` is the Task progress checklist.
- **Updates:** `main/updater.js` checks GitHub Releases, verifies the installer's SHA-256 and swaps the app in after it quits.
- **Extensions:** [electron-chrome-extensions](https://github.com/samuelmaddock/electron-browser-shell) and electron-chrome-web-store.

## License

Lumio Browser is free software: you can redistribute it and/or modify it under the terms of the **GNU General Public License v3.0 or later**. See [LICENSE](LICENSE). The Lumio name and logo, the lumio-usa.online service, and Lumio plans are not covered by this license.
