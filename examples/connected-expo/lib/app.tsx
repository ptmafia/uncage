/**
 * Wires lib/uncage.ts and lib/push.ts to the real platform: SecureStore, `expo/fetch`, the global
 * fetch, expo-notifications. `AuthProvider` holds the sign-in and the hub client.
 */
import type { UncageClient } from '@uncage/client';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Device from 'expo-device';
import { fetch as expoFetch } from 'expo/fetch';
import * as SecureStore from 'expo-secure-store';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { registerForPush, sendPushToken, type PushRegistration } from './push';
import {
  clearAuth,
  createAppClient,
  loadAuth,
  needsRenewal,
  normalizeSiteUrl,
  requestAppToken,
  saveAuth,
  SiteError,
  type KeyValueStore,
  type StoredAuth,
} from './uncage';

/** `EXPO_PUBLIC_*` variables are inlined into the bundle at build time (set when starting Expo). */
export const SITE_URL = normalizeSiteUrl(process.env.EXPO_PUBLIC_HUB_URL);

export const secureStore: KeyValueStore = {
  getItemAsync: (k) => SecureStore.getItemAsync(k),
  setItemAsync: (k, v) => SecureStore.setItemAsync(k, v),
  deleteItemAsync: (k) => SecureStore.deleteItemAsync(k),
};

// The global fetch (uploads, JSON): expo/fetch in SDK 58+ (React Native's fetch with
// EXPO_PUBLIC_USE_RN_FETCH=1). The event stream always uses expo/fetch explicitly, which is typed
// slightly differently from the DOM's fetch but has the same call shape.
const plainFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
const streamFetch = expoFetch as unknown as typeof fetch;

export const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

const projectId = (): string | undefined => {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId || Constants.easConfig?.projectId || undefined;
};

interface AuthContextValue {
  siteUrl: string | undefined;
  loading: boolean;
  auth?: StoredAuth;
  client?: UncageClient;
  push?: PushRegistration;
  signIn(username: string): Promise<void>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>.');
  return v;
}

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [loading, setLoading] = useState(true);
  const [auth, setAuth] = useState<StoredAuth | undefined>();
  const [push, setPush] = useState<PushRegistration | undefined>();
  const tokenRef = useRef<string | undefined>(undefined);
  tokenRef.current = auth?.token;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let saved = await loadAuth(secureStore);
      if (saved && SITE_URL && needsRenewal(saved)) {
        try {
          saved = await requestAppToken(SITE_URL, plainFetch, { token: saved.token });
          await saveAuth(secureStore, saved);
        } catch (err) {
          // Revoked or invalid: sign in again. Offline: keep the old token (still valid).
          if (err instanceof SiteError && err.status === 401) {
            await clearAuth(secureStore).catch(() => undefined);
            saved = undefined;
          }
        }
      }
      if (!cancelled) {
        setAuth(saved);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Register for push once signed in (development builds on a real device only).
  const userId = auth?.user.id;
  useEffect(() => {
    if (!userId || !SITE_URL || !tokenRef.current) return;
    let cancelled = false;
    setPush(undefined);
    const env = { isDevice: Device.isDevice, isExpoGo, platform: Platform.OS, projectId: projectId() };
    void (async () => {
      const result = env.isExpoGo
        ? ({ status: 'unsupported', reason: 'expo-go' } as const)
        : await registerForPush({
            notifications: await import('expo-notifications'),
            env,
            siteUrl: SITE_URL,
            token: tokenRef.current ?? '',
            fetch: plainFetch,
          });
      if (!cancelled) setPush(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const signIn = useCallback(async (username: string) => {
    if (!SITE_URL) throw new Error('EXPO_PUBLIC_HUB_URL is not set.');
    const next = await requestAppToken(SITE_URL, plainFetch, { username: username.trim().toLowerCase() });
    await saveAuth(secureStore, next);
    setAuth(next);
  }, []);

  const signOut = useCallback(async () => {
    const token = tokenRef.current;
    if (SITE_URL && token && push?.status === 'registered') {
      await sendPushToken(plainFetch, SITE_URL, token, push.token, 'DELETE').catch(() => undefined);
    }
    await clearAuth(secureStore).catch(() => undefined);
    setPush(undefined);
    setAuth(undefined);
  }, [push]);

  const client = useMemo(
    () =>
      userId && SITE_URL
        ? createAppClient({ siteUrl: SITE_URL, getToken: () => tokenRef.current, streamFetch, plainFetch })
        : undefined,
    [userId],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      siteUrl: SITE_URL,
      loading,
      ...(auth ? { auth } : {}),
      ...(client ? { client } : {}),
      ...(push ? { push } : {}),
      signIn,
      signOut,
    }),
    [loading, auth, client, push, signIn, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * A `/device?code=` link that arrived while signed out (see app/+native-intent.tsx): the sign-in
 * screen opens it after signing in.
 */
let pendingDeviceCode: string | undefined;
export const setPendingDeviceCode = (code: string | undefined): void => {
  pendingDeviceCode = code;
};
export const takePendingDeviceCode = (): string | undefined => {
  const code = pendingDeviceCode;
  pendingDeviceCode = undefined;
  return code;
};
