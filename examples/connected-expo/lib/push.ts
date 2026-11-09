/**
 * Push notifications: the Expo push token goes to the site (`POST /api/app/push-token`), and the
 * hub's `onAttention` (connected-demo with `EXPO_PUSH=1`) pushes "approval needed" and "run
 * finished / failed" with `data: { sessionId, approvalId?, kind }`. A tap opens that chat.
 *
 * No React Native imports here: `expo-notifications` and the device facts are passed in, so this
 * runs under Vitest. Remote push needs a development build: Expo Go has none on Android (SDK 53+).
 */
import { bearerHeaders } from './uncage';

/** The subset of `expo-notifications` used here. */
export interface NotificationsApi {
  getPermissionsAsync(): Promise<{ granted: boolean; canAskAgain?: boolean }>;
  requestPermissionsAsync(): Promise<{ granted: boolean }>;
  getExpoPushTokenAsync(o: { projectId: string }): Promise<{ data: string }>;
  setNotificationChannelAsync?(id: string, channel: { name: string; importance: number }): Promise<unknown>;
}

export interface PushEnv {
  /** `expo-device`'s `isDevice` (simulators and emulators get no push token). */
  isDevice: boolean;
  /** `expo-constants`' `executionEnvironment === 'storeClient'`: running inside Expo Go. */
  isExpoGo: boolean;
  platform: 'ios' | 'android' | string;
  /** The EAS project id (`extra.eas.projectId`, from `EAS_PROJECT_ID`). */
  projectId: string | undefined;
}

export type PushRegistration =
  | { status: 'registered'; token: string }
  | { status: 'unsupported'; reason: 'expo-go' | 'simulator' | 'no-project-id' }
  | { status: 'denied' }
  | { status: 'failed'; message: string };

/** `AndroidImportance.HIGH` (kept as a number so this file needs no expo import). */
export const ANDROID_IMPORTANCE_HIGH = 4;

/** Asks for permission, gets the Expo push token and registers it with the site. */
export async function registerForPush(o: {
  notifications: NotificationsApi;
  env: PushEnv;
  siteUrl: string;
  token: string;
  fetch: typeof fetch;
}): Promise<PushRegistration> {
  const { notifications: n, env } = o;
  if (env.isExpoGo) return { status: 'unsupported', reason: 'expo-go' };
  if (!env.isDevice) return { status: 'unsupported', reason: 'simulator' };
  if (!env.projectId) return { status: 'unsupported', reason: 'no-project-id' };
  try {
    if (env.platform === 'android' && n.setNotificationChannelAsync) {
      // Android 13+ shows the permission prompt only once a channel exists.
      await n.setNotificationChannelAsync('default', { name: 'Agent updates', importance: ANDROID_IMPORTANCE_HIGH });
    }
    let { granted } = await n.getPermissionsAsync();
    if (!granted) granted = (await n.requestPermissionsAsync()).granted;
    if (!granted) return { status: 'denied' };
    const { data: pushToken } = await n.getExpoPushTokenAsync({ projectId: env.projectId });
    await sendPushToken(o.fetch, o.siteUrl, o.token, pushToken, 'POST');
    return { status: 'registered', token: pushToken };
  } catch (err) {
    return { status: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}

/** `POST` (register) or `DELETE` (sign-out) `/api/app/push-token` `{ token }`; throws on failure. */
export async function sendPushToken(
  fetchImpl: typeof fetch,
  siteUrl: string,
  appToken: string,
  pushToken: string,
  method: 'POST' | 'DELETE',
): Promise<void> {
  const res = await fetchImpl(`${siteUrl}/api/app/push-token`, {
    method,
    headers: { 'content-type': 'application/json', ...bearerHeaders(appToken) },
    body: JSON.stringify({ token: pushToken }),
  });
  if (!res.ok) throw new Error(`The site refused the push token (${res.status}).`);
}

/** The chat a tapped notification belongs to (`data.sessionId` from the hub's `expoPushNotifier`). */
export function sessionIdFromNotification(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const id = (data as { sessionId?: unknown }).sessionId;
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : undefined;
}

/** A line for the settings area about why push is off. */
export function describePush(r: PushRegistration | undefined): string {
  if (!r) return 'Push notifications: checking…';
  switch (r.status) {
    case 'registered':
      return 'Push notifications: on';
    case 'denied':
      return 'Push notifications: permission denied (allow them in Settings)';
    case 'failed':
      return `Push notifications: failed (${r.message})`;
    case 'unsupported':
      return r.reason === 'expo-go'
        ? 'Push notifications: need a development build (not available in Expo Go)'
        : r.reason === 'simulator'
          ? 'Push notifications: need a real device'
          : 'Push notifications: set EAS_PROJECT_ID to enable';
  }
}
