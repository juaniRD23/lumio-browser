# Lumio for iPhone and Android

The phone companion (`website/public/companion.*`, served at `/companion`) in
an app, made with Expo. The app adds what a web page can't do on its own:
signing in with Google (in the phone's browser, then a one-time code for the
app's web view), native notifications (Expo push), and opening other sites
in the phone's browser.

## Try it

```bash
cd mobile
npm install
npx expo start
```

Scan the QR code with Expo Go (iPhone) or a development build (Android:
push notifications need a development build since SDK 53).

The site it opens is `expo.extra.site` in `app.json`
(https://lumio-co.online). The value is built into each app, so store builds
need a new build after it changes. Builds made before the switch open
lumio.gw607953.workers.dev, which keeps working (same Worker and database).

## Store builds

1. `npx eas-cli login`, then `npx eas-cli init` (adds the EAS project ID,
   which push notifications need).
2. `npx eas-cli build --platform ios` / `--platform android`.
3. `npx eas-cli submit` (App Store Connect / Google Play Console).

Bundle IDs: `online.lumio-usa.companion` (iOS), `online.lumiousa.companion`
(Android).
