/**
 * Everything that depends on where the app is pointed (read at `expo start` / EAS build time):
 *
 * - `EXPO_PUBLIC_HUB_URL` — the website (connected-demo), e.g. `http://192.168.1.20:3200` in Expo Go
 *   or `https://demo.example.com` for a build. Its host gets the app link for `/device`:
 *   Android `intentFilters` (autoVerify; the site serves `/.well-known/assetlinks.json` from
 *   `ANDROID_PACKAGE` + `ANDROID_SHA256`) and, with `APPLE_TEAM_ID`, iOS `associatedDomains`
 *   (`applinks:<host>`; the site serves `apple-app-site-association` from `APPLE_TEAM_ID` +
 *   `IOS_BUNDLE_ID`; not verified on a device). Both need an https site.
 * - `ANDROID_PACKAGE` / `IOS_BUNDLE_ID` — the app ids (defaults below; use your own for a build).
 * - `EAS_PROJECT_ID` — the EAS project (`eas init` prints it); needed for push tokens.
 * - `GOOGLE_SERVICES_JSON` — path to Firebase's `google-services.json` (FCM, Android push); defaults
 *   to `./google-services.json` when that file exists (git-ignored). On EAS, a file environment variable.
 * - `APPLE_TEAM_ID` — enables the iOS associated domain (universal links; paid Apple account).
 */
import { existsSync } from 'node:fs';
import type { ConfigContext, ExpoConfig } from 'expo/config';

const DEFAULT_ID = 'dev.uncage.connectedexpo';

function hubUrl(): URL | undefined {
  const raw = process.env.EXPO_PUBLIC_HUB_URL?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const url = hubUrl();
  const https = url?.protocol === 'https:';
  const androidPackage = process.env.ANDROID_PACKAGE?.trim() || DEFAULT_ID;
  const bundleId = process.env.IOS_BUNDLE_ID?.trim() || DEFAULT_ID;
  const projectId = process.env.EAS_PROJECT_ID?.trim();
  const appleTeamId = process.env.APPLE_TEAM_ID?.trim();
  const googleServicesFile =
    process.env.GOOGLE_SERVICES_JSON?.trim() || (existsSync('./google-services.json') ? './google-services.json' : undefined);

  const plugins: ExpoConfig['plugins'] = [...(config.plugins ?? [])];
  // A plain-http site (a laptop on the LAN) needs cleartext traffic in a development build.
  if (url && !https) plugins.push(['expo-build-properties', { android: { usesCleartextTraffic: true } }]);

  return {
    ...config,
    name: config.name ?? 'Uncage Demo',
    slug: config.slug ?? 'uncage-connected-expo',
    ios: {
      ...config.ios,
      bundleIdentifier: bundleId,
      ...(appleTeamId ? { appleTeamId } : {}),
      // Universal links need https and a paid Apple Developer account (the entitlement fails to
      // sign without one), so they are added only with APPLE_TEAM_ID. Not verified on a device.
      ...(https && url && appleTeamId ? { associatedDomains: [`applinks:${url.hostname}`] } : {}),
    },
    android: {
      ...config.android,
      package: androidPackage,
      ...(googleServicesFile ? { googleServicesFile } : {}),
      // App Links need https; the site proves the link with /.well-known/assetlinks.json.
      ...(https && url
        ? {
            intentFilters: [
              {
                action: 'VIEW',
                autoVerify: true,
                data: [{ scheme: 'https', host: url.hostname, pathPrefix: '/device' }],
                category: ['BROWSABLE', 'DEFAULT'],
              },
            ],
          }
        : {}),
    },
    plugins,
    extra: {
      ...config.extra,
      ...(projectId ? { eas: { projectId } } : {}),
    },
  };
};
