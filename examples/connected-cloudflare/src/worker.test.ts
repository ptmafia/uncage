import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import type { PgPoolLike, ToolContext } from '@uncage/hub';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { COOKIE, signUser } from './auth.ts';
import type { Env } from './hub.ts';
import { notesDb, saveNoteTool } from './tools.ts';
import { createWorker, type ExecutionContext } from './worker.ts';

const exampleDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://localhost:8787';
const env: Env = {
  HYPERDRIVE: { connectionString: 'postgres://test@pglite/test' },
  DEMO_SECRET: 'x'.repeat(40),
  PUBLIC_URL: ORIGIN,
};

let db: PGlite;
beforeAll(() => {
  db = new PGlite();
});
afterAll(async () => {
  await db.close();
});

/**
 * A `pg.Pool` look-alike over the shared PGlite (one connection, handed out exclusively until
 * `release()`); `end` is a spy and leaves the database open, like ending one request's pool.
 */
function pglitePool(o: { fail?: RegExp } = {}) {
  let lock: Promise<void> = Promise.resolve();
  const acquire = async (): Promise<() => void> => {
    let release!: () => void;
    const prev = lock;
    lock = new Promise<void>((r) => (release = r));
    await prev;
    return release;
  };
  const run = async (sql: string, params?: unknown[]) => {
    if (o.fail?.test(sql)) throw new Error('injected database failure');
    return { rows: (await db.query(sql, params)).rows as unknown[] };
  };
  const pool = {
    async query(sql: string, params?: unknown[]) {
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
    end: vi.fn(async () => undefined),
  };
  return pool satisfies PgPoolLike;
}

/** A worker whose per-request pools are recorded, and an ExecutionContext collecting waitUntil. */
function setup(o: { pool?: () => ReturnType<typeof pglitePool>; env?: Partial<Env>; origin?: string } = {}) {
  const pools: Array<ReturnType<typeof pglitePool>> = [];
  const worker = createWorker({
    pool: () => {
      const p = o.pool ? o.pool() : pglitePool();
      pools.push(p);
      return p;
    },
  });
  const pending: Promise<unknown>[] = [];
  const ctx: ExecutionContext = {
    waitUntil(p) {
      // Workers' waitUntil throws when called unbound; the worker must bind it.
      if (this !== ctx) throw new TypeError('Illegal invocation');
      pending.push(p);
    },
  };
  const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${o.origin ?? ORIGIN}${path}`, init), { ...env, ...o.env }, ctx);
  const settled = async () => {
    while (pending.length > 0) await Promise.allSettled(pending.splice(0));
  };
  return { pools, call, settled };
}

const FORM = 'application/x-www-form-urlencoded';
const cookieFor = async (name: string) => `${COOKIE}=${await signUser(name, env.DEMO_SECRET)}`;

describe('connected-cloudflare worker', () => {
  it('worker routes the hub through fetchOnce and closes the hub after the response', async () => {
    const { pools, call, settled } = setup();
    const res = await call('/api/uncage/agent/info', { headers: { 'cf-connecting-ip': '203.0.113.7' } });
    expect(res.status).toBe(200);
    // The pool lives until the body has been read (streams keep working)…
    expect(pools).toHaveLength(1);
    expect(pools[0]!.end).not.toHaveBeenCalled();
    const info = (await res.json()) as { transports: Array<{ kind: string }> };
    // FaaS: no WebSocket server, so only the HTTP streaming transport is offered.
    expect(info.transports.map((t) => t.kind)).toEqual(['http']);
    await settled();
    // …then the hub closes and the request's pool is ended, once.
    expect(pools[0]!.end).toHaveBeenCalledTimes(1);

    const install = await call('/api/uncage/install.sh');
    expect(install.status).toBe(200);
    expect(await install.text()).toContain(`uncage setup`);
    await settled();
    expect(pools).toHaveLength(2);
    expect(pools[1]!.end).toHaveBeenCalledTimes(1);
  });

  it('device login: /login signs in, /device approves the code uncage setup got', async () => {
    const { pools, call, settled } = setup();
    const login = await call('/login', { method: 'POST', headers: { origin: ORIGIN, 'content-type': FORM }, body: 'user=alice&next=/device' });
    expect(login.status).toBe(303);
    expect(login.headers.get('location')).toBe('/device');
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    expect(cookie).toBe(await cookieFor('alice'));
    expect((await call('/login', { method: 'POST', headers: { 'content-type': FORM }, body: 'user=a&next=//evil.example' })).headers.get('location')).toBe('/');

    const code = (await (
      await call('/api/uncage/device/code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'laptop', os: 'darwin' }) })
    ).json()) as { deviceCode: string; userCode: string };
    expect((await call(`/device?code=${code.userCode}`)).status).toBe(401); // not signed in
    const shown = await call(`/device?code=${code.userCode}`, { headers: { cookie } });
    expect(await shown.text()).toContain('laptop');

    const forged = await call('/device', { method: 'POST', headers: { cookie: `${COOKIE}=alice.00`, 'content-type': 'application/x-www-form-urlencoded' }, body: `code=${code.userCode}` });
    expect(forged.status).toBe(401);
    const cross = await call('/device', { method: 'POST', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: `code=${code.userCode}` });
    expect(cross.status).toBe(403);
    const approved = await call('/device', { method: 'POST', headers: { cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: `code=${code.userCode}&decision=approve` });
    expect(approved.status).toBe(200);
    expect(await approved.text()).toContain('data-result="ok"');

    const token = (await (
      await call('/api/uncage/device/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceCode: code.deviceCode }) })
    ).json()) as { status?: string; token?: string };
    expect(token.token ?? token.status).toBeTruthy();
    await settled();
    // Every request's pool was ended.
    for (const p of pools) expect(p.end).toHaveBeenCalledTimes(1);
  });

  it('demo login: POST only, same-origin only, and refused on a public host unless ALLOW_DEMO_LOGIN=1', async () => {
    const local = setup();
    // GET never signs in (no login CSRF through a link or an <img>): it shows the form and the warning.
    const get = await local.call('/login?user=mallory');
    expect(get.status).toBe(200);
    expect(get.headers.get('set-cookie')).toBeNull();
    expect(await get.text()).toMatch(/method="post"[\s\S]*Demo sign-in|Demo sign-in[\s\S]*method="post"/);
    const cross = await local.call('/login', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': FORM }, body: 'user=mallory' });
    expect(cross.status).toBe(403);
    expect(cross.headers.get('set-cookie')).toBeNull();
    expect((await local.call('/login', { method: 'POST', headers: { 'content-type': FORM }, body: 'user=bad name' })).status).toBe(400);
    for (const host of ['http://127.0.0.1:8787', 'http://[::1]:8787']) {
      expect((await setup({ origin: host }).call('/login', { method: 'POST', headers: { 'content-type': FORM }, body: 'user=ok' })).status).toBe(303);
    }

    const pub = setup({ origin: 'https://uncage-demo.example.workers.dev' });
    for (const init of [{}, { method: 'POST', headers: { 'content-type': FORM }, body: 'user=mallory' }]) {
      const r = await pub.call('/login', init);
      expect(r.status).toBe(403);
      expect(r.headers.get('set-cookie')).toBeNull();
      expect(await r.text()).toContain('getUser');
    }
    // No sign-in form on the public host's pages either.
    expect(await (await pub.call('/')).text()).not.toContain('action="/login"');

    const opened = setup({ origin: 'https://uncage-demo.example.workers.dev', env: { ALLOW_DEMO_LOGIN: '1' } });
    expect((await opened.call('/login', { method: 'POST', headers: { 'content-type': FORM }, body: 'user=guest' })).status).toBe(303);
  });

  it('a missing or short DEMO_SECRET answers every route with one clear 500 setup message', async () => {
    for (const DEMO_SECRET of ['', 'short']) {
      const { call, pools } = setup({ env: { DEMO_SECRET } });
      for (const path of ['/', '/notes', '/api/uncage/agent/info']) {
        const r = await call(path);
        expect(r.status).toBe(500);
        expect(await r.text()).toContain('DEMO_SECRET must be set to at least 32 bytes');
      }
      expect(pools).toHaveLength(0); // nothing touched the database
    }
  });

  it('database down: hub routes, /notes and /device answer 503 and every pool is still ended', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const down = () => {
        const p = pglitePool({ fail: /./ });
        p.connect = async () => {
          throw new Error('connect ECONNREFUSED');
        };
        return p;
      };
      const { call, pools, settled } = setup({ pool: down });
      const hubRes = await call('/api/uncage/agent/info');
      expect(hubRes.status).toBe(503);
      expect(((await hubRes.json()) as { error: { code: string } }).error.code).toBe('unavailable');
      const cookie = await cookieFor('erin');
      expect((await call('/notes', { headers: { cookie } })).status).toBe(503);
      expect((await call('/device?code=ABCD-EFGH', { headers: { cookie } })).status).toBe(503);
      await settled();
      expect(pools).toHaveLength(3);
      for (const p of pools) expect(p.end).toHaveBeenCalledTimes(1);
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  it('/device: a failing approve is a 500 (429 is only for rate_limited)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const cookie = await cookieFor('frank');
      // The hub builds fine; only the device-code table fails.
      const broken = setup({ pool: () => pglitePool({ fail: /uncage_hub_device_codes/ }) });
      const r = await broken.call('/device', { method: 'POST', headers: { cookie, origin: ORIGIN, 'content-type': FORM }, body: 'code=ABCD-EFGH&decision=approve' });
      expect(r.status).toBe(500);
      expect(await r.text()).not.toContain('injected');

      // Wrong codes over the hub's limit (10 per user per window) → 429 with the hub's message.
      const ok = setup();
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        statuses.push((await ok.call('/device', { method: 'POST', headers: { cookie, origin: ORIGIN, 'content-type': FORM }, body: `code=ZZZZ-ZZ${String(i).padStart(2, '0')}` })).status);
      }
      expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
      expect(statuses.at(-1)).toBe(429);
      await ok.settled();
      await broken.settled();
    } finally {
      err.mockRestore();
    }
  });

  it('saveNote stores a note for the session owner only', async () => {
    const notes = notesDb(pglitePool());
    const tool = saveNoteTool(notes);
    expect(tool.name).toBe('save_note');
    const ctx = (user: string) => ({ user: { id: user }, sessionId: 'ses_1', runId: 'run_1', signal: new AbortController().signal }) as unknown as ToolContext;
    const input = tool.input.parse({ title: '  Groceries ', body: 'milk, eggs' });
    const out = (await tool.handler(input, ctx('user:carol'))) as { saved: boolean; noteId: string };
    expect(out.saved).toBe(true);
    expect(await notes.list('user:carol')).toMatchObject([{ id: out.noteId, title: 'Groceries', body: 'milk, eggs' }]);
    expect(await notes.list('user:dave')).toEqual([]);
    expect(tool.input.safeParse({ title: '', body: 'x' }).success).toBe(false);

    // GET /notes shows each signed-in user their own notes only.
    const { call, settled } = setup();
    expect((await call('/notes')).status).toBe(401);
    const carol = (await (await call('/notes', { headers: { cookie: await cookieFor('carol') } })).json()) as Array<{ title: string }>;
    expect(carol.map((n) => n.title)).toEqual(['Groceries']);
    expect(await (await call('/notes', { headers: { cookie: await cookieFor('dave') } })).json()).toEqual([]);
    await settled();
  });

  it('wrangler bundles the worker without errors', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'uncage-cf-bundle-'));
    try {
      const r = spawnSync('pnpm', ['exec', 'wrangler', 'deploy', '--dry-run', '--outdir', tmp], { cwd: exampleDir, encoding: 'utf8', timeout: 120_000 });
      expect(r.status, r.stderr).toBe(0);
      const bundle = readdirSync(tmp).find((f) => f.endsWith('.js'));
      expect(bundle).toBeDefined();
      expect(readFileSync(join(tmp, bundle!), 'utf8')).toContain('save_note');
      // Only `pg` needs nodejs_compat: the hub's Node-only parts (PGlite, ws, @uncage/hub/node) stay out.
      const map = JSON.parse(readFileSync(join(tmp, `${bundle}.map`), 'utf8')) as { sources: string[] };
      expect(map.sources.some((s) => s.includes('packages/hub/dist/'))).toBe(true);
      expect(map.sources.filter((s) => /pglite|node_modules\/ws\/|hub\/dist\/node\//.test(s))).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 130_000);
});
