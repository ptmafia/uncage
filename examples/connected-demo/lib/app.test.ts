/**
 * The mobile app / extension side of the demo: app tokens (bearer sign-in), Expo push tokens,
 * the hub's `onAttention` wiring and the app-link well-known files.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { AttentionEvent, PgPoolLike } from '@uncage/hub';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP_TOKEN_TTL_MS, appTokenKey, signAppToken, verifyAppToken } from './app-token.ts';
import { GUEST_MINTS_PER_MINUTE, guestMintLimiter, handleAppToken, handlePushToken, wellKnownResponse } from './app-routes.ts';
import { SESSION_COOKIE, signUser, userFromRequest } from './auth.ts';
import { attentionHandler, createDemoHub, housekeeping } from './hub.ts';
import { PUBLISHED_HUB_KEY } from './mode.ts';
import { appleAppSiteAssociation, assetLinks } from './well-known.ts';
import { filePushTokenStore, isExpoPushToken, MAX_PUSH_TOKENS_PER_USER, PUSH_TOKEN_MAX_AGE_MS, postgresPushTokenStore, pushTokenStore, type PushTokenStore } from './push-tokens.ts';

const SECRET = 's'.repeat(40);
let dir: string;
let saved: Record<string, string | undefined>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'connected-demo-app-'));
  saved = { DEMO_DATA_DIR: process.env.DEMO_DATA_DIR, DEMO_SECRET: process.env.DEMO_SECRET, DEMO_PUBLIC: process.env.DEMO_PUBLIC };
  process.env.DEMO_DATA_DIR = dir;
  process.env.DEMO_SECRET = SECRET;
  delete process.env.DEMO_PUBLIC;
  guestMintLimiter.reset();
  // Traditional mode (as under server.ts): the cookie key is DEMO_SECRET, no database needed.
  (globalThis as Record<symbol, unknown>)[PUBLISHED_HUB_KEY] = { basePath: '/api/uncage' };
});
afterEach(async () => {
  delete (globalThis as Record<symbol, unknown>)[PUBLISHED_HUB_KEY];
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(dir, { recursive: true, force: true });
});

const key = () => Buffer.from(SECRET);
const cookieFor = (name: string) => `${SESSION_COOKIE}=${encodeURIComponent(signUser(name, key()))}`;
const tok = (n: number) => `ExponentPushToken[tok${n}xxxxxxxxxxxxxxxx]`;

describe('app tokens', () => {
  it('sign and verify; tampered, foreign-key and expired tokens are refused', () => {
    const now = 1_800_000_000_000;
    const t = signAppToken('alice', { key: key(), now });
    expect(verifyAppToken(t, { key: key(), now })).toBe('alice');
    expect(verifyAppToken(t, { key: key(), now: now + APP_TOKEN_TTL_MS - 1000 })).toBe('alice');
    expect(verifyAppToken(t, { key: key(), now: now + APP_TOKEN_TTL_MS + 1000 })).toBeNull(); // expired
    expect(verifyAppToken(t.replace('alice', 'bob'), { key: key(), now })).toBeNull();
    expect(verifyAppToken(`${t}x`, { key: key(), now })).toBeNull();
    expect(verifyAppToken(t, { key: Buffer.from('o'.repeat(40)), now })).toBeNull();
    expect(verifyAppToken('', { key: key(), now })).toBeNull();
    expect(verifyAppToken('garbage', { key: key(), now })).toBeNull();
    expect(APP_TOKEN_TTL_MS).toBe(30 * 24 * 3600_000);
  });

  it('uses a key separate from the cookie: a cookie value is not an app token and vice versa', () => {
    expect(appTokenKey(key()).equals(key())).toBe(false);
    const cookie = signUser('alice', key());
    expect(verifyAppToken(cookie, { key: key() })).toBeNull();
    const t = signAppToken('alice', { key: key() });
    expect(userFromRequest(new Request('http://x/', { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(t)}` } }))).toBeNull();
  });

  it('bearer app token resolves the same user as the cookie', () => {
    const viaCookie = userFromRequest(new Request('http://x/', { headers: { cookie: cookieFor('alice') } }));
    const viaBearer = userFromRequest(new Request('http://x/', { headers: { authorization: `Bearer ${signAppToken('alice', { key: key() })}` } }));
    expect(viaCookie).toEqual({ id: 'alice', name: 'alice' });
    expect(viaBearer).toEqual(viaCookie);
    // A bearer header that fails never falls back to a cookie sent alongside.
    expect(userFromRequest(new Request('http://x/', { headers: { cookie: cookieFor('alice'), authorization: 'Bearer nope' } }))).toBeNull();
    expect(userFromRequest(new Request('http://x/', { headers: { cookie: cookieFor('alice'), authorization: 'Bearer' } }))).toBeNull();
  });

  it('a non-Bearer Authorization header (e.g. basic auth in front of staging) leaves the cookie in charge', () => {
    const basic = `Basic ${Buffer.from('staff:pw').toString('base64')}`;
    expect(userFromRequest(new Request('http://x/', { headers: { cookie: cookieFor('alice'), authorization: basic } }))).toEqual({ id: 'alice', name: 'alice' });
    expect(userFromRequest(new Request('http://x/', { headers: { authorization: basic } }))).toBeNull();
  });

  it('invalid/expired app token → 401 JSON from the hub; a valid one gets through with no Origin', async () => {
    const { hub, close } = await createDemoHub({ mode: 'traditional', env: { ...process.env } });
    try {
      const get = (auth?: string) =>
        hub.fetch(new Request('http://localhost:3200/api/uncage/machines', { headers: auth ? { authorization: auth } : {} }));
      const ok = await get(`Bearer ${signAppToken('alice', { key: key() })}`);
      expect(ok.status).toBe(200);
      for (const bad of ['Bearer nope', `Bearer ${signAppToken('alice', { key: key(), now: Date.now() - APP_TOKEN_TTL_MS - 1000 })}`, undefined]) {
        const res = await get(bad);
        expect(res.status).toBe(401);
        expect(res.headers.get('content-type')).toMatch(/application\/json/);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unauthorized');
      }
    } finally {
      await close();
    }
  });
});

describe('POST /api/app/token', () => {
  const post = (headers: Record<string, string> = {}, body?: unknown) =>
    new Request('http://localhost:3200/api/app/token', {
      method: 'POST',
      headers: { host: 'localhost:3200', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const read = async (res: Response) => (await res.json()) as { token: string; user: { id: string; name: string }; expiresAt: string };

  it('issues a token for the signed-in cookie user that resolves to the same user', async () => {
    const res = await handleAppToken(post({ cookie: cookieFor('alice'), origin: 'http://localhost:3200' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await read(res);
    expect(body.user).toEqual({ id: 'alice', name: 'alice' });
    expect(Date.parse(body.expiresAt) - Date.now()).toBeGreaterThan(APP_TOKEN_TTL_MS - 60_000);
    expect(userFromRequest(new Request('http://x/', { headers: { authorization: `Bearer ${body.token}` } }))).toEqual({ id: 'alice', name: 'alice' });
  });

  it('public demo: a visitor without a session gets a fresh guest; the username in the body is ignored', async () => {
    process.env.DEMO_PUBLIC = '1';
    const a = await read(await handleAppToken(post({}, { username: 'alice' })));
    const b = await read(await handleAppToken(post()));
    expect(a.user.id).toMatch(/^guest-[a-z2-7]{12}$/);
    expect(b.user.id).toMatch(/^guest-/);
    expect(a.user.id).not.toBe(b.user.id);
  });

  it('private demo: signs in by username like the login form; no name → 400, foreign Origin → 403', async () => {
    expect((await read(await handleAppToken(post({}, { username: ' Bob ' })))).user.id).toBe('bob');
    const missing = await handleAppToken(post());
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('invalid_request');
    expect((await handleAppToken(post({}, { username: 'a/b' }))).status).toBe(400);
    expect((await handleAppToken(post({ cookie: cookieFor('alice'), origin: 'https://evil.example' }))).status).toBe(403);
  });

  it(`public demo: at most ${GUEST_MINTS_PER_MINUTE} new guests per client IP per minute (429), per IP, and not for signed-in users`, async () => {
    process.env.DEMO_PUBLIC = '1';
    const saved = process.env.CLIENT_IP_HEADER;
    process.env.CLIENT_IP_HEADER = 'x-real-ip';
    try {
      const ip = (a: string, extra: Record<string, string> = {}) => post({ 'x-real-ip': a, ...extra });
      for (let i = 0; i < GUEST_MINTS_PER_MINUTE; i++) expect((await handleAppToken(ip('203.0.113.1'))).status).toBe(200);
      const limited = await handleAppToken(ip('203.0.113.1'));
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(((await limited.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
      expect((await handleAppToken(ip('203.0.113.2'))).status).toBe(200); // another visitor
      expect((await handleAppToken(ip('203.0.113.1', { cookie: cookieFor('alice') }))).status).toBe(200); // not a new guest
      // A minute later the window has moved on.
      const later = Date.now() + 61_000;
      expect(guestMintLimiter.take('203.0.113.1', later)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.CLIENT_IP_HEADER;
      else process.env.CLIENT_IP_HEADER = saved;
    }
  });

  it('an app token can renew itself', async () => {
    const res = await handleAppToken(post({ authorization: `Bearer ${signAppToken('carol', { key: key() })}` }));
    expect((await read(res)).user.id).toBe('carol');
    expect((await handleAppToken(post({ authorization: 'Bearer nope' }, { username: 'dave' }))).status).toBe(401);
  });
});

/** A one-connection `pg.Pool` look-alike over PGlite (same as demo.test.ts). */
function pglitePool(db: PGlite): PgPoolLike {
  let lock: Promise<void> = Promise.resolve();
  const acquire = async (): Promise<() => void> => {
    let release!: () => void;
    const prev = lock;
    lock = new Promise<void>((r) => (release = r));
    await prev;
    return release;
  };
  const run = async (sql: string, params?: unknown[]) => ({ rows: (await db.query(sql, params)).rows as unknown[] });
  return {
    async query(sql, params) {
      const release = await acquire();
      try {
        return await run(sql, params);
      } finally {
        release();
      }
    },
    async connect() {
      return { query: run, release: await acquire() };
    },
    end: () => db.close(),
  };
}

describe.each([
  ['filePushTokenStore', async () => ({ store: filePushTokenStore(join(dir, 'push-tokens')), close: async () => undefined })],
  [
    'postgresPushTokenStore (PGlite)',
    async () => {
      const db = new PGlite();
      return { store: postgresPushTokenStore(pglitePool(db)), close: () => db.close() };
    },
  ],
] as const)('push tokens stored per user, both stores: %s', (_name, make) => {
  let store: PushTokenStore;
  let close: () => Promise<void>;
  beforeEach(async () => ({ store, close } = await make()));
  afterEach(() => close());

  it('adds per user without duplicates, moves a token to its latest user, removes by token', async () => {
    expect(await store.list('alice')).toEqual([]);
    await store.add('alice', tok(1));
    await store.add('alice', tok(2));
    await store.add('alice', tok(1));
    await store.add('bob', tok(3));
    expect((await store.list('alice')).sort()).toEqual([tok(1), tok(2)]);
    expect(await store.list('bob')).toEqual([tok(3)]);
    // The device signed in as bob now: alice must not get its pushes any more.
    await store.add('bob', tok(2));
    expect(await store.list('alice')).toEqual([tok(1)]);
    expect((await store.list('bob')).sort()).toEqual([tok(2), tok(3)]);
    await store.remove(tok(2));
    expect(await store.list('bob')).toEqual([tok(3)]);
    await store.remove(tok(99)); // unknown: no-op
    await store.remove(tok(3), 'alice'); // not alice's: kept
    expect(await store.list('bob')).toEqual([tok(3)]);
    await store.remove(tok(3), 'bob');
    expect(await store.list('bob')).toEqual([]);
  });

  it('purges tokens not re-registered within the max age (30 days); a re-registration keeps a token', async () => {
    expect(PUSH_TOKEN_MAX_AGE_MS).toBe(30 * 24 * 3600_000);
    await store.add('alice', tok(1));
    await store.add('bob', tok(2));
    expect(await store.purgeOlderThan(PUSH_TOKEN_MAX_AGE_MS)).toBe(0);
    expect(await store.purgeOlderThan(PUSH_TOKEN_MAX_AGE_MS, Date.now() + PUSH_TOKEN_MAX_AGE_MS + 60_000)).toBe(2);
    expect(await store.list('alice')).toEqual([]);
    expect(await store.list('bob')).toEqual([]);
    // Gone from the index as well: the token can be registered again by anyone.
    await store.add('carol', tok(1));
    expect(await store.list('carol')).toEqual([tok(1)]);
  });

  it(`keeps at most ${MAX_PUSH_TOKENS_PER_USER} per user, dropping the oldest; re-registering refreshes a token`, async () => {
    for (let i = 0; i < MAX_PUSH_TOKENS_PER_USER; i++) await store.add('alice', tok(i));
    await store.add('alice', tok(0)); // refreshed: now the newest
    await store.add('alice', tok(100));
    const list = await store.list('alice');
    expect(list).toHaveLength(MAX_PUSH_TOKENS_PER_USER);
    expect(list).toContain(tok(0));
    expect(list).toContain(tok(100));
    expect(list).not.toContain(tok(1));
  });
});

describe('file push token store layout', () => {
  it('finds a token\'s owner through a reverse index instead of reading every user', async () => {
    const root = join(dir, 'idx');
    const store = filePushTokenStore(root);
    for (let i = 0; i < 30; i++) await store.add(`user${i}`, tok(i));
    expect((await readdir(join(root, 'by-token'))).length).toBe(30);
    // Make every other user's file unreadable garbage: moving and removing tok(5) must not need them.
    const { writeFile } = await import('node:fs/promises');
    for (let i = 0; i < 30; i++) if (i !== 5 && i !== 7) await writeFile(join(root, 'users', `user${i}.json`), 'not json');
    await store.add('user7', tok(5));
    expect(await store.list('user5')).toEqual([]);
    expect((await store.list('user7')).sort()).toEqual([tok(5), tok(7)]);
    await store.remove(tok(5));
    expect(await store.list('user7')).toEqual([tok(7)]);
    expect((await readdir(join(root, 'by-token'))).length).toBe(29);
    // Dropped by the per-user cap: its index entry goes too.
    for (let i = 100; i < 100 + MAX_PUSH_TOKENS_PER_USER; i++) await store.add('user7', tok(i));
    expect(await store.list('user7')).not.toContain(tok(7));
    await store.add('user8', tok(7));
    expect(await store.list('user8')).toEqual([tok(7)]);
  });
});

describe('housekeeping (server.ts hourly, the hub maintenance in FaaS mode)', () => {
  it('purges stale push tokens in every mode; assets only in public mode', async () => {
    await pushTokenStore().add('alice', tok(1));
    const later = Date.now() + PUSH_TOKEN_MAX_AGE_MS + 60_000;
    expect(await housekeeping({ ...process.env }, Date.now())).toEqual({ pushTokens: 0, assets: 0 });
    expect(await housekeeping({ ...process.env }, later)).toEqual({ pushTokens: 1, assets: 0 });
    expect(await pushTokenStore().list('alice')).toEqual([]);
  });
});

describe('POST /api/app/push-token', () => {
  const req = (method: string, body: unknown, headers: Record<string, string> = {}) =>
    new Request('http://localhost:3200/api/app/push-token', {
      method,
      headers: { host: 'localhost:3200', 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const bearer = (name: string) => ({ authorization: `Bearer ${signAppToken(name, { key: key() })}` });

  it('checks the Expo token format', () => {
    expect(isExpoPushToken('ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]')).toBe(true);
    expect(isExpoPushToken('ExpoPushToken[xxxxxxxxxxxxxxxxxxxxxx]')).toBe(true);
    for (const bad of ['', 'ExponentPushToken[]', 'ExponentPushToken[a b]', 'fcm-token', `ExponentPushToken[${'a'.repeat(300)}]`, 42]) {
      expect(isExpoPushToken(bad)).toBe(false);
    }
  });

  it('stores the token for the bearer (or cookie) user; refuses bad tokens, no user and foreign origins', async () => {
    expect((await handlePushToken(req('POST', { token: tok(1) }, bearer('alice')))).status).toBe(204);
    expect((await handlePushToken(req('POST', { token: tok(2) }, { cookie: cookieFor('alice'), origin: 'http://localhost:3200' }))).status).toBe(204);
    expect((await pushTokenStore().list('alice')).sort()).toEqual([tok(1), tok(2)]);
    const bad = await handlePushToken(req('POST', { token: 'nope' }, bearer('alice')));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('invalid_request');
    expect((await handlePushToken(req('POST', { token: tok(3) }))).status).toBe(401);
    expect((await handlePushToken(req('POST', { token: tok(3) }, { cookie: cookieFor('alice'), origin: 'https://evil.example' }))).status).toBe(403);
    // DELETE unregisters (sign-out), only the caller's own token.
    expect((await handlePushToken(req('DELETE', { token: tok(1) }, bearer('bob')))).status).toBe(204);
    expect((await pushTokenStore().list('alice')).sort()).toEqual([tok(1), tok(2)]);
    expect((await handlePushToken(req('DELETE', { token: tok(1) }, bearer('alice')))).status).toBe(204);
    expect(await pushTokenStore().list('alice')).toEqual([tok(2)]);
  });
});

describe('EXPO_PUSH: onAttention through expoPushNotifier', () => {
  const event: AttentionEvent = { kind: 'approval_requested', userId: 'alice', sessionId: 's1', machineId: 'm1', approval: { id: 'ap1', title: 'Run npm test', category: 'command' }, at: new Date().toISOString() };
  const ctx = { waitUntil: () => undefined };

  it('is off unless EXPO_PUSH=1', () => {
    expect(attentionHandler({ ...process.env })).toBeUndefined();
    expect(attentionHandler({ ...process.env, EXPO_PUSH: '0' })).toBeUndefined();
  });

  it("sends to the user's stored tokens with EXPO_ACCESS_TOKEN and drops tokens Expo reports unregistered", async () => {
    await pushTokenStore().add('alice', tok(1));
    await pushTokenStore().add('alice', tok(2));
    const calls: Array<{ body: Array<{ to: string }>; auth: string | null }> = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Array<{ to: string }>;
      calls.push({ body, auth: new Headers(init.headers).get('authorization') });
      return Response.json({
        data: body.map((m) => (m.to === tok(1) ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered', expoPushToken: tok(1) } } : { status: 'ok', id: 'x' })),
      });
    }) as typeof fetch;
    const handler = attentionHandler({ ...process.env, EXPO_PUSH: '1', EXPO_ACCESS_TOKEN: 'expo-secret' }, { fetch: fakeFetch });
    expect(handler).toBeTypeOf('function');
    await handler!(event, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.auth).toBe('Bearer expo-secret');
    expect(calls[0]!.body.map((m) => m.to).sort()).toEqual([tok(1), tok(2)]);
    expect(await pushTokenStore().list('alice')).toEqual([tok(2)]);
  });
});

describe('well-known files only when env set, correct JSON shape', () => {
  const FP = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':');

  it('assetlinks.json from ANDROID_PACKAGE + ANDROID_SHA256 (one or more fingerprints)', () => {
    expect(assetLinks({})).toBeNull();
    expect(assetLinks({ ANDROID_PACKAGE: 'dev.uncage.demo' })).toBeNull();
    expect(assetLinks({ ANDROID_SHA256: FP })).toBeNull();
    expect(assetLinks({ ANDROID_PACKAGE: 'dev.uncage.demo', ANDROID_SHA256: 'not-a-fingerprint' })).toBeNull();
    expect(assetLinks({ ANDROID_PACKAGE: 'not a package', ANDROID_SHA256: FP })).toBeNull();
    expect(assetLinks({ ANDROID_PACKAGE: 'dev.uncage.demo', ANDROID_SHA256: `${FP.toLowerCase()}, ${FP.replace(/^00/, 'FF')}` })).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: { namespace: 'android_app', package_name: 'dev.uncage.demo', sha256_cert_fingerprints: [FP, FP.replace(/^00/, 'FF')] },
      },
    ]);
  });

  it('apple-app-site-association from APPLE_TEAM_ID + IOS_BUNDLE_ID, claiming /device', () => {
    expect(appleAppSiteAssociation({})).toBeNull();
    expect(appleAppSiteAssociation({ APPLE_TEAM_ID: 'ABCDE12345' })).toBeNull();
    expect(appleAppSiteAssociation({ APPLE_TEAM_ID: 'bad', IOS_BUNDLE_ID: 'dev.uncage.demo' })).toBeNull();
    expect(appleAppSiteAssociation({ APPLE_TEAM_ID: 'ABCDE12345', IOS_BUNDLE_ID: 'dev.uncage.demo' })).toEqual({
      applinks: {
        details: [{ appIDs: ['ABCDE12345.dev.uncage.demo'], components: [{ '/': '/device', comment: 'Device approval (scan-to-connect)' }] }],
      },
    });
  });

  it('serves application/json without auth, 404 when unset', async () => {
    const env = { ANDROID_PACKAGE: 'dev.uncage.demo', ANDROID_SHA256: FP, APPLE_TEAM_ID: 'ABCDE12345', IOS_BUNDLE_ID: 'dev.uncage.demo' };
    for (const name of ['assetlinks.json', 'apple-app-site-association'] as const) {
      const res = wellKnownResponse(name, env);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(await res.json()).toBeTruthy();
      expect(wellKnownResponse(name, {}).status).toBe(404);
    }
  });
});
