import type { DeviceCodeResponse, DeviceTokenResponse } from '@uncage/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createHub } from './hub.js';
import { pgliteHubStore } from './node/index.js';
import { startTestHub, type TestHub } from './test-utils.js';
import type { HubOptions, HubUser } from './types.js';
import { sha256Hex } from './web.js';

// Native apps and browser extensions as clients of the browser API: bearer auth through the
// site's getUser, no Origin from native apps, chrome-extension:// origins via trustedOrigins.

let th: TestHub | undefined;
afterEach(async () => {
  await th?.close();
  th = undefined;
});

/** getUser accepting `Authorization: Bearer tok-<user>` (apps) or `Cookie: u=<user>` (websites). */
const appGetUser: HubOptions['getUser'] = async (req) => {
  const bearer = /^Bearer tok-(\w+)$/.exec(req.headers.get('authorization') ?? '');
  if (bearer) return { id: bearer[1]! } satisfies HubUser;
  const cookie = /(?:^|;\s*)u=(\w+)/.exec(req.headers.get('cookie') ?? '');
  return cookie ? { id: cookie[1]! } : null;
};
const start = async (o: Partial<HubOptions> = {}) => (th = await startTestHub({ getUser: appGetUser, ...o }));

const jsonInit = (method: string, body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const bearer = (user: string) => ({ authorization: `Bearer tok-${user}` });

async function newCode(t: TestHub, machine: { name?: string; os?: string } = { name: 'MacBook', os: 'darwin' }): Promise<DeviceCodeResponse> {
  return (await (await fetch(`${t.api}/device/code`, jsonInit('POST', machine))).json()) as DeviceCodeResponse;
}
const lookup = (t: TestHub, code: string, headers: Record<string, string> = bearer('alice')) =>
  fetch(`${t.api}/device/lookup?code=${encodeURIComponent(code)}`, { headers });
const decide = (t: TestHub, body: unknown, headers: Record<string, string> = bearer('alice')) =>
  fetch(`${t.api}/device/decision`, jsonInit('POST', body, headers));
const poll = async (t: TestHub, deviceCode: string) =>
  (await (await fetch(`${t.api}/device/token`, jsonInit('POST', { deviceCode }))).json()) as DeviceTokenResponse;

describe('apps and extensions on the browser API', () => {
  it('device and session routes accept no-Origin bearer requests; foreign Origin still refused', async () => {
    const t = await start();
    // Native app: bearer token, no Origin, no Sec-Fetch-Site.
    expect((await fetch(`${t.api}/machines`, { headers: bearer('alice') })).status).toBe(200);
    expect((await fetch(`${t.api}/sessions`, { headers: bearer('alice') })).status).toBe(200);
    // POST /sessions gets past auth and the cross-site guard (no computer connected yet → machine_not_found).
    const created = await fetch(`${t.api}/sessions`, jsonInit('POST', { runtime: 'fake' }, bearer('alice')));
    expect(created.status).toBe(404);
    expect(((await created.json()) as { error: { code: string } }).error.code).toBe('machine_not_found');
    const code = await newCode(t);
    expect((await lookup(t, code.userCode)).status).toBe(200);
    const ok = await decide(t, { code: code.userCode, approve: true });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ result: 'ok' });

    // Website cookie from a foreign page: refused on every state-changing route.
    const evil = { cookie: 'u=alice', origin: 'https://evil.example' };
    const code2 = await newCode(t);
    const refused = await decide(t, { code: code2.userCode, approve: true }, evil);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('forbidden_origin');
    expect((await fetch(`${t.api}/sessions`, jsonInit('POST', { runtime: 'fake' }, evil))).status).toBe(403);
    expect((await decide(t, { code: code2.userCode, approve: true }, { cookie: 'u=alice', 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    // A cross-site page cannot spend the user's failed-code budget through the lookup either.
    expect((await lookup(t, 'ZZZZ-ZZZZ', { cookie: 'u=alice', 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await lookup(t, 'ZZZZ-ZZZZ', evil)).status).toBe(403);
    // The code refused above is still pending.
    expect(await (await lookup(t, code2.userCode)).json()).toMatchObject({ name: 'MacBook' });
    // Same-site website request still works.
    expect((await decide(t, { code: code2.userCode, approve: false }, { cookie: 'u=alice', origin: t.origin })).status).toBe(200);
    // Not signed in.
    expect((await lookup(t, code2.userCode, {})).status).toBe(401);
    expect((await decide(t, { code: code2.userCode, approve: true }, {})).status).toBe(401);
  });

  it('trustedOrigins lets chrome-extension://abc POST; other extension ids refused', async () => {
    const t = await start({ trustedOrigins: ['chrome-extension://abcdefghijklmnopabcdefghijklmnop'] });
    const ext = { cookie: 'u=alice', origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' };
    const code = await newCode(t);
    // Extensions with host permissions may also send Sec-Fetch-Site: cross-site; the trusted origin wins.
    const ok = await decide(t, { code: code.userCode, approve: true }, { ...ext, 'sec-fetch-site': 'cross-site' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ result: 'ok' });
    const created = await fetch(`${t.api}/sessions`, jsonInit('POST', { runtime: 'fake' }, ext));
    expect(((await created.json()) as { error: { code: string } }).error.code).toBe('machine_not_found');

    const other = { cookie: 'u=alice', origin: 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' };
    const code2 = await newCode(t);
    expect((await decide(t, { code: code2.userCode, approve: true }, other)).status).toBe(403);
    expect((await fetch(`${t.api}/sessions`, jsonInit('POST', { runtime: 'fake' }, other))).status).toBe(403);
    // Exact match only: a prefix or a different scheme is not trusted.
    expect((await decide(t, { code: code2.userCode, approve: true }, { ...other, origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnopx' })).status).toBe(403);
    expect((await decide(t, { code: code2.userCode, approve: true }, { ...other, origin: 'moz-extension://abcdefghijklmnopabcdefghijklmnop' })).status).toBe(403);
  });

  it('createHub rejects trustedOrigins with wildcards or paths', async () => {
    const store = await pgliteHubStore({ dataDir: 'memory://' });
    try {
      const make = (trustedOrigins: string[]) => createHub({ publicUrl: 'https://x.test', getUser: async () => null, store, trustedOrigins });
      for (const bad of [
        '*',
        'chrome-extension://*',
        'https://*.example.com',
        'https://app.example.com/',
        'https://app.example.com/path',
        'chrome-extension://abc/',
        'chrome-extension://abc/popup.html',
        'https://app.example.com?x=1',
        'https://app.example.com#x',
        'https://user:pw@app.example.com',
        'app.example.com',
        'null',
        '',
        'HTTPS://App.Example.com',
        'https://app.example.com:443',
      ]) {
        await expect(make([bad]), bad).rejects.toThrow(/trustedOrigins/);
      }
      const hub = await make(['chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'https://app.example.com', 'http://localhost:8081', 'moz-extension://0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0']);
      await hub.close();
    } finally {
      await store.close();
    }
  });

  it('device lookup/decision: approve binds, deny, not_found, expired, rate_limited after 10 bad codes', async () => {
    const t = await start();
    // Approve binds the computer to the signed-in user.
    const a = await newCode(t);
    expect(await (await lookup(t, a.userCode)).json()).toEqual(await t.hub.lookupDevice(a.userCode, { id: 'alice' }));
    expect(await (await lookup(t, a.userCode.toLowerCase().replace('-', ' '))).json()).toMatchObject({ name: 'MacBook', os: 'darwin', repairsMachine: null });
    expect(await (await decide(t, { code: a.userCode, approve: true })).json()).toEqual({ result: 'ok' });
    const tok = await poll(t, a.deviceCode);
    expect(tok.status).toBe('ok');
    const machines = (await (await fetch(`${t.api}/machines`, { headers: bearer('alice') })).json()) as Array<{ id: string }>;
    expect(machines.map((m) => m.id)).toEqual([tok.status === 'ok' ? tok.machineId : '']);
    expect(await (await fetch(`${t.api}/machines`, { headers: bearer('bob') })).json()).toEqual([]);
    // Decided codes are gone.
    expect(await (await lookup(t, a.userCode)).json()).toBeNull();
    expect(await (await decide(t, { code: a.userCode, approve: true })).json()).toEqual({ result: 'not_found' });

    // Deny.
    const d = await newCode(t);
    expect(await (await decide(t, { code: d.userCode, approve: false })).json()).toEqual({ result: 'ok' });
    expect(await poll(t, d.deviceCode)).toEqual({ status: 'denied' });

    // Expired (a pending code past its expiry).
    await t.store.insertDeviceCode({
      deviceCodeHash: await sha256Hex('expired-device-code'),
      userCodeHash: await sha256Hex('WXYZ-2345'),
      status: 'pending',
      createdAt: new Date(Date.now() - 700_000).toISOString(),
      expiresAt: new Date(Date.now() - 100_000).toISOString(),
    });
    expect(await (await lookup(t, 'WXYZ-2345')).json()).toBeNull();
    expect(await (await decide(t, { code: 'WXYZ-2345', approve: true })).json()).toEqual({ result: 'expired' });

    // Invalid bodies.
    for (const body of [{ code: '', approve: true }, { code: 'x'.repeat(33), approve: true }, { code: a.userCode }, { code: a.userCode, approve: 'yes' }, null]) {
      const r = await decide(t, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect((await fetch(`${t.api}/device/lookup`, { headers: bearer('alice') })).status).toBe(400);

    // Failed codes so far for alice: the decided code's lookup (null) and decision (not_found), the
    // expired lookup (null) = 3; seven more reach the limit of 10 and the next attempt, even with a
    // valid code, is refused. (Expired decisions and refused / invalid requests do not count.)
    const c = await newCode(t);
    expect(await (await lookup(t, 'ZZZZ-ZZZ2')).json()).toBeNull();
    for (let i = 0; i < 6; i++) expect(await (await decide(t, { code: `QQQQ-QQQ${i + 2}`, approve: true })).json()).toEqual({ result: 'not_found' });
    const limited = await lookup(t, c.userCode);
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
    const limited2 = await decide(t, { code: c.userCode, approve: true });
    expect(limited2.status).toBe(429);
    // Shared with hub.lookupDevice, per user.
    await expect(t.hub.lookupDevice(c.userCode, { id: 'alice' })).rejects.toMatchObject({ code: 'rate_limited' });
    expect(await (await lookup(t, c.userCode, bearer('bob'))).json()).toMatchObject({ name: 'MacBook' });
  });

  it('installInfo.connectUrl encodes the setup URL', async () => {
    const t = await start();
    const info = (await (await fetch(`${t.api}/machines/install`, { headers: bearer('alice') })).json()) as Record<string, string>;
    expect(info.setup).toBe(`uncage setup ${t.origin}`);
    expect(info.connectUrl).toBe(`uncage://connect?url=${encodeURIComponent(t.origin)}`);
    expect(new URL(info.connectUrl!).searchParams.get('url')).toBe(t.origin);
    await t.close();
    // A custom basePath: the setup URL is the hub URL.
    th = await startTestHub({ getUser: appGetUser, basePath: '/x/hub' });
    const info2 = (await (await fetch(`${th.origin}/x/hub/machines/install`, { headers: bearer('alice') })).json()) as Record<string, string>;
    expect(info2.connectUrl).toBe(`uncage://connect?url=${encodeURIComponent(`${th.origin}/x/hub`)}`);
  });
});
