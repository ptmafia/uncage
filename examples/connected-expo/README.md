# connected-expo: the Uncage React Native (Expo) reference app

A phone app for [connected-demo](../connected-demo): the same account, computers and chats as the website, with the agent still running on the user's own computer.

- **Computers and chats**: the signed-in user's computers (online or offline, which one new chats run on) and their chats. "New chat" picks a runtime the chosen computer reports.
- **Chat**: streamed replies, tool steps (tap one to see its output), approval cards with **Allow once** / **Deny**, and model / effort / permission pickers. The runtime picker starts a new chat on another runtime.
- **Photos**: attach images from the library (expo-image-picker). Sent images load with the app token (`Image source={{ uri, headers }}`).
- **Resume**: the event stream restarts after the last event when the app returns to the foreground (`useReconnect` on `AppState` "active"). The last open chat reopens after a restart (`usePersistSession` with a SecureStore adapter).
- **Approve a computer**: `uncage setup <site>` prints a QR code for `https://<site>/device?code=…`. With app links set up (development build, https site) it opens this app's approval screen (`useDeviceApproval`). Otherwise use **Approve a computer** on the home screen and type the code.
- **Push notifications** (development build only): "approval needed" and "run finished / failed" from the hub's `onAttention` (connected-demo with `EXPO_PUSH=1`). Tapping one opens that chat.

Status: type-checked, unit-tested (`lib/`) and bundled for Android and iOS (`expo export`) in this repository. **Not yet run on a device; awaiting device confirmation.** iOS universal links and iOS push are **not verified on a device**, because they need a paid Apple Developer account.

## How it talks to the site

| What | Where |
| --- | --- |
| Sign-in | `POST <site>/api/app/token` with `{ "username": "…" }` returns `{ token, user, expiresAt }` (connected-demo's demo-only sign-in, no password; the public demo ignores the name and creates a guest). The token is stored with expo-secure-store and renewed within 7 days of expiry. |
| Hub API | `createUncageClient({ baseUrl: '<site>/api/uncage', fetch, headers: async () => ({ authorization: 'Bearer …' }) })`. Event streams go through `expo/fetch`, which can read a streaming body. Other requests, uploads included, use the global fetch, which in Expo SDK 58+ is expo/fetch too (React Native's fetch if you set `EXPO_PUBLIC_USE_RN_FETCH=1`; `lib/uncage.ts` keeps the stream on expo/fetch either way). Picked photos arrive as `file://` copies in the app's cache, which expo/fetch reads; it does not read `content://` URIs, so copy those to a file first. The app sends no `Origin`, so the hub accepts the bearer request. |
| Push | `POST <site>/api/app/push-token` `{ token }` after sign-in (on every launch), `DELETE` on sign-out (`lib/push.ts`). |
| App links | `/.well-known/assetlinks.json` and `/.well-known/apple-app-site-association`, served by connected-demo from its env (below). |

Everything platform-specific is in `lib/app.tsx`. `lib/uncage.ts`, `lib/push.ts`, `lib/links.ts` and `lib/attachments.ts` take the platform pieces as arguments, so they run under Vitest.

For a site of your own, replace `/api/app/token` with your own sign-in that returns a token, and accept that token in your hub's `getUser`.

## Configuration

Read when Expo starts or EAS builds (`app.config.ts`):

| Variable | What |
| --- | --- |
| `EXPO_PUBLIC_HUB_URL` | The website, e.g. `http://192.168.1.20:3200` (Expo Go on the LAN) or `https://demo.example.com`. Required. A plain-http URL turns on cleartext traffic for Android builds. An https URL adds the Android App Link for `https://<host>/device` (`autoVerify`). |
| `EAS_PROJECT_ID` | The EAS project id (`eas init` prints it), needed for push tokens. |
| `ANDROID_PACKAGE` / `IOS_BUNDLE_ID` | App ids (default `dev.uncage.connectedexpo`). Use your own for a build. |
| `GOOGLE_SERVICES_JSON` | Path to Firebase's `google-services.json` (Android push). Defaults to `./google-services.json` when present. |
| `APPLE_TEAM_ID` | With an https site, adds the iOS associated domain `applinks:<host>` (universal links). Needs a paid Apple Developer account. Not verified on a device. |

## 1. Expo Go (free, no build)

Expo Go covers chat, computers, approvals, pickers, photos and resume. It has no push notifications (Expo Go has no remote push on Android since SDK 53, and the app turns push off there) and no app links.

The same connected-demo server is reached two ways:
- **The Mac** (website and agent) uses `http://localhost:3200`. The agent accepts plain http only for localhost; anywhere else it needs https. So `PUBLIC_URL` stays at its default, and `uncage setup` is given the localhost URL.
- **The phone** uses the Mac's LAN IP (`EXPO_PUBLIC_HUB_URL=http://<LAN IP>:3200`). That works because the app signs in with a bearer token and sends no `Origin`, so the site does not care which host name it used.

Because of this, the QR code and link from `uncage setup` point at `localhost`, which the phone cannot open. In Expo Go, approve the computer by typing the code under **Approve a computer** in the app.

1. Install **Expo Go** on the phone (Play Store / App Store). The phone and the Mac must be on the same Wi-Fi.
2. Find the Mac's LAN IP: `ipconfig getifaddr en0` (e.g. `192.168.1.20`).
3. Start connected-demo listening on all interfaces, from the repository root. `HOST=0.0.0.0` makes it reachable from the phone. Leave `PUBLIC_URL` unset (default `http://localhost:3200`).

   ```sh
   pnpm install && pnpm build
   cd examples/connected-demo
   HOST=0.0.0.0 pnpm dev
   ```

4. Start the app in Expo Go mode (`start:go`: plain `pnpm start` opens a development build, which Expo Go cannot open), then scan the QR code in the terminal: with the Camera app on iOS, or from inside Expo Go on Android.

   ```sh
   cd examples/connected-expo
   EXPO_PUBLIC_HUB_URL=http://192.168.1.20:3200 pnpm start:go
   ```

5. Sign in to the app with a username, e.g. `alice`. Sign in to the website on the Mac (`http://localhost:3200`) with the **same** username, so both see the same computers and chats.
6. Connect the Mac with the CLI built from this repository (the published `@uncage/cli` is 0.3 until 0.4 is released: it has no QR code or `uncage://` handler, and a plain `uncage setup` would also install a background service). From the repository root: `node packages/cli/dist/bin.js setup http://localhost:3200 --no-daemon`, then `node packages/cli/dist/bin.js agent` in another terminal. It prints a code like `ABCD-EFGH`. In the app, tap **Approve a computer**, type the code, tap **Continue**, then **Approve**. (macOS may ask whether `node` may accept incoming connections; allow it, because the phone reaches the Mac through `HOST=0.0.0.0`.) Alternatively, open the link it prints in the Mac's browser and approve it there. The computer then appears in the app; tap **New chat**.

## 2. Android development build (free: EAS free tier + Firebase)

A development build adds push notifications and App Links. You need a free [Expo account](https://expo.dev/signup), a free [Firebase](https://console.firebase.google.com) project, and an **https** URL for connected-demo, because App Links only verify over https. A deployed demo works (see [connected-demo/DEPLOY.md](../connected-demo/DEPLOY.md)), or a tunnel to your Mac.

1. **EAS project**: `npm i -g eas-cli`, `eas login`, then in `examples/connected-expo` run `eas init`. Put the printed project id in `EAS_PROJECT_ID`.
2. **Package name**: choose one, e.g. `com.yourname.uncagedemo`, and use it as `ANDROID_PACKAGE` everywhere below.
3. **Firebase (FCM)**: in Firebase, add an Android app with that package name and download `google-services.json` into `examples/connected-expo/` (git-ignored; `app.config.ts` picks it up). For EAS cloud builds without committing it, upload it as a file environment variable named `GOOGLE_SERVICES_JSON` (`eas env:create --name GOOGLE_SERVICES_JSON --type file --value ./google-services.json`). Then give Expo the FCM V1 service account key: Firebase → Project settings → Service accounts → Generate new private key, and upload it with `eas credentials` (Android → Google Service Account → FCM V1). See Expo's [FCM credentials guide](https://docs.expo.dev/push-notifications/fcm-credentials/).
4. **Build** (an APK, the `development` profile in `eas.json`). The cloud build reads `build.development.env` in `eas.json`, not your shell, so put your values there: `EXPO_PUBLIC_HUB_URL` (your https demo), `ANDROID_PACKAGE` and `EAS_PROJECT_ID`. Then, with the same variables in your shell (the EAS CLI reads the config locally too):

   ```sh
   export EXPO_PUBLIC_HUB_URL=https://your-demo.example.com EAS_PROJECT_ID=… ANDROID_PACKAGE=com.yourname.uncagedemo
   eas build --profile development --platform android
   ```

   Install the APK from the link EAS prints, then run `pnpm start` in the same shell. The development build connects to it instead of Expo Go.
5. **App Links**: get the build's signing certificate SHA-256 with `eas credentials` (Android → Keystore). Start connected-demo with:

   ```sh
   ANDROID_PACKAGE=com.yourname.uncagedemo ANDROID_SHA256=AB:CD:…:EF EXPO_PUSH=1 …
   ```

   Check that `https://your-demo.example.com/.well-known/assetlinks.json` returns the JSON. Android verifies the link when the app is installed, so reinstall the APK if you set this up afterwards. With adb installed, check it with `adb shell pm get-app-links com.yourname.uncagedemo`.
6. **Try it**: sign in on the phone and allow notifications. Run `node packages/cli/dist/bin.js setup https://your-demo.example.com` (the 0.4 CLI built from this repository; the QR code needs it, not the published 0.3) on a computer and scan its QR code with the phone camera. The app's approval screen opens. Start a run that needs an approval on the website, then lock the phone: a push arrives, and tapping it opens the chat.

## 3. iOS (not verified on a device)

Expo Go on iOS covers everything in section 1. A development build with push and universal links needs a **paid** Apple Developer account: set `APPLE_TEAM_ID` and `IOS_BUNDLE_ID`, run `eas build --profile development --platform ios`, and on the site set `APPLE_TEAM_ID` + `IOS_BUNDLE_ID` for `apple-app-site-association`. This part is implemented and configurable but **not verified on a device**. Without it, the CLI's QR code opens the website's approval page in Safari, which works the same way.

## Development

```sh
pnpm --filter connected-expo typecheck
pnpm --filter connected-expo lint
pnpm --filter connected-expo test    # lib/: headers, SecureStore persistence, push registration, links, photos
pnpm --filter connected-expo bundle:check   # expo export for Android and iOS into dist/ (no device needed; CI runs it on Node 22)
```

In this pnpm monorepo, `metro.config.js` adds the workspace node_modules and makes `react`, `react-dom` and `react-native` resolve from this app only. React Native needs exactly its renderer's React version, and `@uncage/react` would otherwise load its own copy. The repository's `node-linker` stays as it is.
