import { describe, expect, it, vi } from 'vitest';
import {
  AUTH_KEY,
  bearerHeaders,
  clearAuth,
  createAppClient,
  hubBaseUrl,
  isEventStream,
  loadAuth,
  needsRenewal,
  normalizeSiteUrl,
  requestAppToken,
  routedFetch,
  saveAuth,
  sessionKey,
  sessionStorageAdapter,
  SiteError,
  type KeyValueStore,
  type StoredAuth,
} from './uncage';

type FetchFn = (u: RequestInfo | URL, i?: RequestInit) => Promise<Response>;

/** An in-memory SecureStore. */
function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItemAsync: async (k) => data.get(k) ?? null,
    setItemAsync: async (k, v) => void data.set(k, v),
    deleteItemAsync: async (k) => void data.delete(k),
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const NOW = Date.parse('2026-11-09T12:00:00Z');
const auth = (over: Partial<StoredAuth> = {}): StoredAuth => ({
  token: 'uat1.alice.1790000000.sig',
  user: { id: 'alice', name: 'alice' },
  expiresAt: '2026-12-09T12:00:00.000Z',
  ...over,
});

describe('site URL', () => {
  it('normalizes EXPO_PUBLIC_HUB_URL and refuses non-http or credentialed URLs', () => {
    expect(normalizeSiteUrl(' http://192.168.1.20:3200/ ')).toBe('http://192.168.1.20:3200');
    expect(normalizeSiteUrl('https://demo.example.com/app//')).toBe('https://demo.example.com/app');
    expect(normalizeSiteUrl(undefined)).toBeUndefined();
    expect(normalizeSiteUrl('')).toBeUndefined();
    expect(normalizeSiteUrl('javascript:alert(1)')).toBeUndefined();
    expect(normalizeSiteUrl('ftp://x.example')).toBeUndefined();
    expect(normalizeSiteUrl('https://user:pw@x.example')).toBeUndefined();
    expect(normalizeSiteUrl('not a url')).toBeUndefined();
    expect(hubBaseUrl('https://demo.example.com')).toBe('https://demo.example.com/api/uncage');
  });
});

describe('headers', () => {
  it('bearerHeaders: Authorization only with a token', () => {
    expect(bearerHeaders('t0k')).toEqual({ authorization: 'Bearer t0k' });
    expect(bearerHeaders(undefined)).toEqual({});
    expect(bearerHeaders('')).toEqual({});
  });

  it('the hub client sends the current bearer on requests and event streams; uploads use the plain fetch', async () => {
    let token: string | undefined = 'first';
    const plain = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      void init;
      return json([]);
    });
    const stream = vi.fn(async () => new Response(new ReadableStream({ start: (c) => c.close() }), { headers: { 'content-type': 'text/event-stream' } }));
    const client = createAppClient({
      siteUrl: 'http://192.168.1.20:3200',
      getToken: async () => token,
      streamFetch: stream as unknown as typeof fetch,
      plainFetch: plain as unknown as typeof fetch,
    });

    await client.listSessions();
    expect(String(plain.mock.calls[0]![0])).toBe('http://192.168.1.20:3200/api/uncage/sessions');
    expect((plain.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe('Bearer first');

    token = 'renewed';
    await client.listSessions();
    expect((plain.mock.calls[1]![1]!.headers as Record<string, string>).authorization).toBe('Bearer renewed');

    // An upload (a named Blob, as lib/attachments.ts makes) goes through the plain fetch with a Blob body.
    plain.mockResolvedValueOnce(
      json({ id: 'att_1', sessionId: 'ses_1', name: 'p.jpg', mime: 'image/jpeg', size: 3, kind: 'image', sha256: 'x', createdAt: '2026-11-09T00:00:00Z' }),
    );
    const file = Object.assign(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), { name: 'p.jpg' });
    await client.uploadAttachment('ses_1', file);
    const up = plain.mock.calls[2]!;
    expect(String(up[0])).toBe('http://192.168.1.20:3200/api/uncage/sessions/ses_1/attachments');
    expect(up[1]!.body).toBeInstanceOf(Blob);
    expect((up[1]!.headers as Record<string, string>).authorization).toBe('Bearer renewed');

    // The event stream goes through the streaming fetch (expo/fetch), with the bearer.
    const stop = client.subscribe('ses_1', { after: 0, onEvent: () => undefined });
    await vi.waitFor(() => expect(stream).toHaveBeenCalled());
    const [url, init] = stream.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toContain('/api/uncage/sessions/ses_1/events');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer renewed');
    stop();
  });

  it('routedFetch sends only text/event-stream requests to the streaming fetch', async () => {
    const stream = vi.fn(async () => new Response('s'));
    const plain = vi.fn(async () => new Response('p'));
    const f = routedFetch(stream as unknown as typeof fetch, plain as unknown as typeof fetch);
    await f('u', { headers: { Accept: 'text/event-stream' } });
    await f('u', { headers: new Headers({ accept: 'text/event-stream' }) });
    await f('u', { headers: [['accept', 'application/json']] });
    await f('u');
    expect(stream).toHaveBeenCalledTimes(2);
    expect(plain).toHaveBeenCalledTimes(2);
    expect(isEventStream({ headers: { accept: 'application/json' } })).toBe(false);
  });
});

describe('sign-in persistence (SecureStore)', () => {
  it('saves, loads and clears the app token', async () => {
    const store = memoryStore();
    expect(await loadAuth(store, NOW)).toBeUndefined();
    await saveAuth(store, auth());
    expect(await loadAuth(store, NOW)).toEqual(auth());
    await clearAuth(store);
    expect(store.data.has(AUTH_KEY)).toBe(false);
  });

  it('drops corrupt or expired entries', async () => {
    const corrupt = memoryStore({ [AUTH_KEY]: '{not json' });
    expect(await loadAuth(corrupt, NOW)).toBeUndefined();
    expect(corrupt.data.has(AUTH_KEY)).toBe(false);

    const wrongShape = memoryStore({ [AUTH_KEY]: JSON.stringify({ token: 1 }) });
    expect(await loadAuth(wrongShape, NOW)).toBeUndefined();

    const expired = memoryStore({ [AUTH_KEY]: JSON.stringify(auth({ expiresAt: '2026-11-01T00:00:00Z' })) });
    expect(await loadAuth(expired, NOW)).toBeUndefined();
    expect(expired.data.has(AUTH_KEY)).toBe(false);
  });

  it('a failing keychain reads as signed out', async () => {
    const store = { ...memoryStore(), getItemAsync: async () => Promise.reject(new Error('locked')) };
    expect(await loadAuth(store, NOW)).toBeUndefined();
  });

  it('renews within 7 days of expiry', () => {
    expect(needsRenewal(auth(), NOW)).toBe(false);
    expect(needsRenewal(auth({ expiresAt: '2026-11-12T00:00:00Z' }), NOW)).toBe(true);
    expect(needsRenewal(auth({ expiresAt: undefined }), NOW)).toBe(false);
  });
});

describe('POST /api/app/token', () => {
  it('signs in with { username } and returns the token, user and expiry', async () => {
    const f = vi.fn<FetchFn>(async () =>
      json({ token: 'uat1.bob.1.s', user: { id: 'bob', name: 'bob' }, expiresAt: '2026-12-09T00:00:00.000Z' }),
    );
    const got = await requestAppToken('http://h:3200', f as unknown as typeof fetch, { username: 'bob' });
    expect(got).toEqual({ token: 'uat1.bob.1.s', user: { id: 'bob', name: 'bob' }, expiresAt: '2026-12-09T00:00:00.000Z' });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://h:3200/api/app/token');
    expect(init!.method).toBe('POST');
    expect(JSON.parse(String(init!.body))).toEqual({ username: 'bob' });
    expect((init!.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('renews with the bearer token', async () => {
    const f = vi.fn<FetchFn>(async () => json({ token: 'new', user: { id: 'a', name: 'a' } }));
    await requestAppToken('http://h', f as unknown as typeof fetch, { token: 'old' });
    expect((f.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe('Bearer old');
    expect(JSON.parse(String(f.mock.calls[0]![1]!.body))).toEqual({});
  });

  it('surfaces the site error message and status, and network failures', async () => {
    const refuse = async () => json({ error: { code: 'unauthorized', message: 'The app token is invalid or expired. Sign in again.' } }, 401);
    await expect(requestAppToken('http://h', refuse as unknown as typeof fetch, { token: 'x' })).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
      message: 'The app token is invalid or expired. Sign in again.',
    });
    const down = async () => Promise.reject(new TypeError('Network request failed'));
    const err = await requestAppToken('http://h', down as unknown as typeof fetch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SiteError);
    expect((err as SiteError).code).toBe('network_error');
    const empty = async () => json({ ok: true });
    await expect(requestAppToken('http://h', empty as unknown as typeof fetch)).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('session persistence adapter (usePersistSession)', () => {
  it('remembers the open session per user and forgets it on undefined', async () => {
    const store = memoryStore();
    const alice = sessionStorageAdapter(store, 'alice');
    const bob = sessionStorageAdapter(store, 'bob');
    expect(await alice.get()).toBeNull();
    await alice.set('ses_1');
    expect(await alice.get()).toBe('ses_1');
    expect(await bob.get()).toBeNull();
    await alice.set(undefined);
    expect(await alice.get()).toBeNull();
  });

  it('keys are valid SecureStore keys', () => {
    expect(sessionKey('alice')).toBe('uncage.session.alice');
    expect(sessionKey('a b/c@d')).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});
