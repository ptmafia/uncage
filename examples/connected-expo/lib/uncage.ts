/**
 * The app's link to the website's hub, free of React Native imports so it runs under Vitest:
 * every platform piece (SecureStore, expo/fetch, the global fetch) is passed in. `lib/app.tsx`
 * wires the real ones.
 *
 * - Sign-in: `POST <site>/api/app/token` (connected-demo, lib/app-routes.ts) returns
 *   `{ token, user, expiresAt }`; the token goes into SecureStore and every hub request carries
 *   `Authorization: Bearer <token>` (async `headers` of `createUncageClient`). A site of your own
 *   issues the token from its own sign-in and checks it in the hub's `getUser`.
 * - Session persistence: a `usePersistSession` storage adapter over SecureStore, one key per user.
 * - Fetch: event streams need a streaming body reader (`expo/fetch`); everything else, uploads
 *   included, goes through React Native's own fetch (it sends `Blob` bodies everywhere).
 */
import { createUncageClient, type UncageClient } from '@uncage/client';
import type { PersistSessionStorage } from '@uncage/react';

/** The subset of `expo-secure-store` used here (an in-memory fake in tests). */
export interface KeyValueStore {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export interface AppUser {
  id: string;
  name: string;
}

export interface StoredAuth {
  token: string;
  user: AppUser;
  /** ISO time; absent when the site does not say. */
  expiresAt?: string;
}

/** SecureStore keys allow only `[A-Za-z0-9._-]`. */
export const AUTH_KEY = 'uncage.auth';
export const sessionKey = (userId: string): string => `uncage.session.${userId.replace(/[^A-Za-z0-9._-]/g, '_')}`;

/** Renew the app token when it expires within this long (connected-demo tokens last 30 days). */
export const RENEW_BEFORE_MS = 7 * 24 * 3600_000;

/**
 * The site's origin from `EXPO_PUBLIC_HUB_URL` (e.g. `http://192.168.1.20:3200`): trailing slashes
 * removed; `undefined` when unset or not an http(s) URL.
 */
export function normalizeSiteUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (url.username || url.password) return undefined;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

/** The hub's browser API under the site (connected-demo mounts it at `/api/uncage`). */
export const hubBaseUrl = (siteUrl: string): string => `${siteUrl}/api/uncage`;

/** `Authorization: Bearer` for a token, or no headers when signed out. */
export function bearerHeaders(token: string | undefined | null): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

function isStoredAuth(v: unknown): v is StoredAuth {
  if (!v || typeof v !== 'object') return false;
  const a = v as Partial<StoredAuth>;
  return (
    typeof a.token === 'string' &&
    a.token.length > 0 &&
    !!a.user &&
    typeof a.user.id === 'string' &&
    typeof a.user.name === 'string' &&
    (a.expiresAt === undefined || typeof a.expiresAt === 'string')
  );
}

/** Reads the saved sign-in; a corrupt or expired entry is removed and reads as signed out. */
export async function loadAuth(store: KeyValueStore, now: number = Date.now()): Promise<StoredAuth | undefined> {
  let raw: string | null;
  try {
    raw = await store.getItemAsync(AUTH_KEY);
  } catch {
    return undefined; // keychain unavailable (e.g. locked device right after boot)
  }
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!isStoredAuth(parsed) || isExpired(parsed, now)) {
    await store.deleteItemAsync(AUTH_KEY).catch(() => undefined);
    return undefined;
  }
  return parsed;
}

export const saveAuth = (store: KeyValueStore, auth: StoredAuth): Promise<void> =>
  store.setItemAsync(AUTH_KEY, JSON.stringify(auth));

export const clearAuth = (store: KeyValueStore): Promise<void> => store.deleteItemAsync(AUTH_KEY);

function isExpired(auth: StoredAuth, now: number): boolean {
  if (auth.expiresAt === undefined) return false;
  const t = Date.parse(auth.expiresAt);
  return Number.isFinite(t) && t <= now;
}

/** True when the token should be renewed now (expires within `RENEW_BEFORE_MS`). */
export function needsRenewal(auth: StoredAuth, now: number = Date.now()): boolean {
  if (auth.expiresAt === undefined) return false;
  const t = Date.parse(auth.expiresAt);
  return Number.isFinite(t) && t - now < RENEW_BEFORE_MS;
}

/** An error from the site's own routes, with the server's message when it sent one. */
export class SiteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SiteError';
  }
}

async function siteError(res: Response): Promise<SiteError> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.message) return new SiteError(res.status, body.error.code ?? 'error', body.error.message);
  } catch {
    // not JSON
  }
  return new SiteError(res.status, 'http_error', `The site answered ${res.status}.`);
}

/**
 * `POST /api/app/token`. Without `token`: a new sign-in (`{ username }` on a private demo; the
 * public demo ignores it and creates a guest). With `token`: renewal (an invalid one is a 401).
 */
export async function requestAppToken(
  siteUrl: string,
  fetchImpl: typeof fetch,
  o: { username?: string; token?: string } = {},
): Promise<StoredAuth> {
  let res: Response;
  try {
    res = await fetchImpl(`${siteUrl}/api/app/token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', ...bearerHeaders(o.token) },
      body: JSON.stringify(o.username !== undefined ? { username: o.username } : {}),
    });
  } catch (err) {
    throw new SiteError(0, 'network_error', `Cannot reach ${siteUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw await siteError(res);
  const body = (await res.json()) as unknown;
  if (!isStoredAuth(body)) throw new SiteError(res.status, 'invalid_response', 'The site sent no app token.');
  return { token: body.token, user: { id: body.user.id, name: body.user.name }, ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}) };
}

/**
 * A `usePersistSession` adapter: the open session id per user in SecureStore, so the app reopens
 * the last conversation after a restart and another account never restores it.
 */
export function sessionStorageAdapter(store: KeyValueStore, userId: string): PersistSessionStorage {
  const key = sessionKey(userId);
  return {
    get: () => store.getItemAsync(key),
    set: (id) => (id === undefined ? store.deleteItemAsync(key) : store.setItemAsync(key, id)),
  };
}

const headerValue = (headers: RequestInit['headers'], name: string): string | undefined => {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  if (Array.isArray(headers)) return headers.find(([k]) => k.toLowerCase() === name)?.[1];
  const rec = headers as Record<string, string>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name);
  return key !== undefined ? rec[key] : undefined;
};

/** True for the hub's event stream request (`accept: text/event-stream`). */
export const isEventStream = (init?: RequestInit): boolean =>
  (headerValue(init?.headers, 'accept') ?? '').includes('text/event-stream');

/**
 * One `fetch` for the client: event streams through `streamFetch` (`expo/fetch`, whose body is a
 * `ReadableStream`), every other request through `plainFetch` (React Native's fetch).
 */
export function routedFetch(streamFetch: typeof fetch, plainFetch: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    isEventStream(init) ? streamFetch(input, init) : plainFetch(input, init)) as typeof fetch;
}

/** The hub client: bearer from `getToken()` (read on every request and stream reconnect). */
export function createAppClient(o: {
  siteUrl: string;
  getToken: () => string | undefined | Promise<string | undefined>;
  streamFetch: typeof fetch;
  plainFetch: typeof fetch;
}): UncageClient {
  return createUncageClient({
    baseUrl: hubBaseUrl(o.siteUrl),
    fetch: routedFetch(o.streamFetch, o.plainFetch),
    headers: async () => bearerHeaders(await o.getToken()),
  });
}
