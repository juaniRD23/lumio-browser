// Lumio for iPhone and Android: the phone companion (lumio…/companion) in an
// app, with the parts a web page can't do on its own.
// - Signing in: Google doesn't allow its sign-in inside an app's web view, so
//   the app signs in in the phone's browser and gets a one-time code back
//   (lumio://auth?code=…); the web view trades it for its own session.
// - Notifications: Expo push. They only say what kind of thing happened
//   ("Lumio needs your OK"); the details are end-to-end encrypted and show in
//   the app.
// - Links to other sites open in the phone's browser.
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Linking, Platform, StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from 'react-native-webview';
import type { WebViewSource } from 'react-native-webview/lib/WebViewTypes';
import * as WebBrowser from 'expo-web-browser';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';

const SITE = String(Constants.expoConfig?.extra?.site || 'https://lumio.gw607953.workers.dev').replace(/\/$/, '');
const APP = `${SITE}/companion`;
const HOST = new URL(SITE).host;

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldPlaySound: false, shouldSetBadge: false, shouldShowBanner: true, shouldShowList: true }),
});

type Msg = { type: 'sign-in' } | { type: 'push' };

export default function App() {
  const web = useRef<WebView>(null);
  const [source, setSource] = useState<WebViewSource>({ uri: APP });
  const [canGoBack, setCanGoBack] = useState(false);

  // A tapped notification opens the app on Now.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener(() => setSource({ uri: `${APP}?from=notification` }));
    return () => sub.remove();
  }, []);

  // Android's back button goes back in the app first.
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!canGoBack) return false;
      web.current?.goBack();
      return true;
    });
    return () => sub.remove();
  }, [canGoBack]);

  const run = (js: string) => web.current?.injectJavaScript(`${js}; true;`);

  const signIn = useCallback(async () => {
    const res = await WebBrowser.openAuthSessionAsync(`${SITE}/api/auth/app/finish`, 'lumio://auth');
    if (res.type !== 'success') return;
    const code = /[?&]code=([a-f0-9]{48})/.exec(res.url)?.[1];
    if (!code) return;
    setSource({ uri: `${SITE}/api/auth/app/session`, method: 'POST', body: `code=${code}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  }, []);

  const enablePush = useCallback(async () => {
    try {
      if (!Device.isDevice) throw new Error('Notifications work on a real phone, not a simulator.');
      if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('default', { name: 'Lumio', importance: Notifications.AndroidImportance.HIGH });
      let { status } = await Notifications.getPermissionsAsync();
      if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
      if (status !== 'granted') throw new Error('Notifications are off. You can turn them on in Settings.');
      const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
      if (!projectId) throw new Error('Notifications aren’t set up in this build yet.');
      const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
      run(`window.lumioNativePush(${JSON.stringify(token)})`);
    } catch (err) {
      run(`window.lumioNativePushError(${JSON.stringify(err instanceof Error ? err.message : String(err))})`);
    }
  }, []);

  // Messages from the web app (window.ReactNativeWebView.postMessage).
  const onMessage = useCallback((e: WebViewMessageEvent) => {
    let msg: Msg;
    try { msg = JSON.parse(e.nativeEvent.data); } catch { return; }
    if (msg.type === 'sign-in') signIn();
    if (msg.type === 'push') enablePush();
  }, [signIn, enablePush]);

  // Lumio's pages stay in the app; everything else opens in the phone's browser.
  const onShouldStart = useCallback((req: WebViewNavigation) => {
    try {
      const u = new URL(req.url);
      if (u.host === HOST || u.protocol === 'about:' || u.protocol === 'blob:' || u.protocol === 'data:') return true;
    } catch { return false; }
    Linking.openURL(req.url).catch(() => {});
    return false;
  }, []);

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <WebView
        ref={web}
        source={source}
        style={styles.web}
        originWhitelist={['https://*', 'about:*']}
        onMessage={onMessage}
        onShouldStartLoadWithRequest={onShouldStart}
        onOpenWindow={(e) => Linking.openURL(e.nativeEvent.targetUrl).catch(() => {})}
        onNavigationStateChange={(nav) => setCanGoBack(nav.canGoBack)}
        sharedCookiesEnabled
        thirdPartyCookiesEnabled={false}
        domStorageEnabled
        allowsBackForwardNavigationGestures
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        decelerationRate="normal"
        setSupportMultipleWindows={false}
        applicationNameForUserAgent="LumioApp/1.0"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#070708' },
  web: { flex: 1, backgroundColor: '#070708' },
});
