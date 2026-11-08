import { DeviceCodeResponseSchema } from '@uncage/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deviceFlow, generateUserCode, normalizeUserCode, USER_CODE_ALPHABET } from './device.js';
import { sha256Hex } from './web.js';
import { SlidingWindow } from './rate-limit.js';
import { pgliteHubStore } from './node/index.js';
import type { HubStore } from './store/store.js';

describe('user codes', () => {
  it('are XXXX-XXXX from an unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const c = generateUserCode();
      expect(c).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect([...c.replace('-', '')].every((ch) => USER_CODE_ALPHABET.includes(ch))).toBe(true);
    }
    for (const ambiguous of ['0', 'O', '1', 'I', 'L']) expect(USER_CODE_ALPHABET).not.toContain(ambiguous);
  });

  it('normalize forgivingly', () => {
    expect(normalizeUserCode(' abcd efgh ')).toBe('ABCD-EFGH');
    expect(normalizeUserCode('ABCDEFGH')).toBe('ABCD-EFGH');
    expect(normalizeUserCode('ABCD-EFG0')).toBeNull();
    expect(normalizeUserCode('ABC')).toBeNull();
  });
});

describe('deviceFlow', () => {
  let store: HubStore;
  let now = Date.parse('2026-11-07T00:00:00Z');
  const created: Array<{ userId: string; name?: string; machineKeyHash?: string }> = [];
  const flow = (limits = { failures: 10, codes: 1000 }) =>
    deviceFlow({
      limits: {
        userFailures: new SlidingWindow(limits.failures, 600_000, () => now),
        codesPerClient: new SlidingWindow(limits.codes, 60_000, () => now),
      },
      store,
      verificationUri: 'https://app.example.com/device',
      site: { id: 'app.example.com', name: 'app.example.com', url: 'https://app.example.com/api/uncage' },
      transports: () => [{ kind: 'ws', url: 'wss://app.example.com/api/uncage/agent' }],
      async createMachine(o) {
        created.push(o);
        return { machineId: `mch_${created.length}`, machineToken: `tok_${created.length}` };
      },
      now: () => now,
    });

  beforeEach(async () => {
    store = await pgliteHubStore({ dataDir: 'memory://' });
    created.length = 0;
    now = Date.parse('2026-11-07T00:00:00Z');
  });
  afterEach(() => store.close());

  it('happy path: pending → approved → token once → expired', async () => {
    const f = flow();
    const code = await f.createCode({ name: 'Nathan’s MacBook', os: 'darwin' }, 'ip1');
    expect(DeviceCodeResponseSchema.parse(code)).toBeTruthy();
    expect(code.intervalSec).toBe(2);
    expect(code.expiresInSec).toBe(600);
    expect(code.verificationUri).toBe(`https://app.example.com/device?code=${code.userCode}`);
    // Stored hashed, never in plaintext.
    const rec = await store.getDeviceCode(await sha256Hex(code.deviceCode));
    expect(rec?.userCodeHash).toBe(await sha256Hex(code.userCode));
    expect(JSON.stringify(rec)).not.toContain(code.deviceCode);

    expect(await f.poll(code.deviceCode)).toEqual({ status: 'pending' });
    expect(await f.lookup(code.userCode.toLowerCase(), { id: 'alice' })).toMatchObject({ name: 'Nathan’s MacBook', os: 'darwin' });
    expect(await f.approve(code.userCode, { id: 'alice' })).toBe('ok');
    expect(await f.lookup(code.userCode, { id: 'alice' })).toBeNull();
    now += 2000;
    const ok = await f.poll(code.deviceCode);
    expect(ok).toMatchObject({ status: 'ok', machineId: 'mch_1', machineToken: 'tok_1', site: { id: 'app.example.com' }, transports: [{ kind: 'ws', url: 'wss://app.example.com/api/uncage/agent' }] });
    expect(created).toEqual([{ userId: 'alice', name: 'Nathan’s MacBook', os: 'darwin' }]);
    // The token is issued exactly once.
    now += 2000;
    expect(await f.poll(code.deviceCode)).toEqual({ status: 'expired' });
    expect(created).toHaveLength(1);
  });

  it('concurrent polls after approval issue one machine', async () => {
    const f = flow();
    const code = await f.createCode({}, 'ip1');
    await f.approve(code.userCode, { id: 'alice' });
    const results = await Promise.all([f.poll(code.deviceCode), f.poll(code.deviceCode), f.poll(code.deviceCode)]);
    // One wins; the others are told to slow down or that the code is used up.
    expect(results.filter((r) => r?.status === 'ok')).toHaveLength(1);
    expect(created).toHaveLength(1);
  });

  it('denied', async () => {
    const f = flow();
    const code = await f.createCode({}, 'ip1');
    expect(await f.deny(code.userCode, { id: 'alice' })).toBe('ok');
    expect(await f.poll(code.deviceCode)).toEqual({ status: 'denied' });
    expect(await f.approve(code.userCode, { id: 'alice' })).toBe('not_found');
    expect(created).toHaveLength(0);
  });

  it('expired after 600 s: approve says expired, poll says expired', async () => {
    const f = flow();
    const code = await f.createCode({}, 'ip1');
    now += 600_000;
    expect(await f.approve(code.userCode, { id: 'alice' })).toBe('expired');
    expect(await f.poll(code.deviceCode)).toEqual({ status: 'expired' });
    expect(await f.lookup(code.userCode, { id: 'alice' })).toBeNull();
  });

  it('approved but not collected before expiry → expired, no machine', async () => {
    const f = flow();
    const code = await f.createCode({}, 'ip1');
    await f.approve(code.userCode, { id: 'alice' });
    now += 601_000;
    expect(await f.poll(code.deviceCode)).toEqual({ status: 'expired' });
    expect(created).toHaveLength(0);
  });

  it('slow_down when polled faster than intervalSec', async () => {
    const f = flow();
    const code = await f.createCode({}, 'ip1');
    expect(await f.poll(code.deviceCode)).toEqual({ status: 'pending' });
    now += 1000;
    expect(await f.poll(code.deviceCode)).toEqual({ status: 'slow_down' });
    now += 1000;
    expect(await f.poll(code.deviceCode)).toEqual({ status: 'slow_down' }); // measured from the last poll
    now += 2000;
    expect(await f.poll(code.deviceCode)).toEqual({ status: 'pending' });
  });

  it('user-code guessing: 10 failures per user per 10 minutes, then rate_limited', async () => {
    const f = flow();
    const real = await f.createCode({}, 'ip1');
    for (let i = 0; i < 10; i++) expect(await f.approve('ZZZZ-ZZZZ', { id: 'mallory' })).toBe('not_found');
    await expect(f.approve(real.userCode, { id: 'mallory' })).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
    await expect(f.deny(real.userCode, { id: 'mallory' })).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(f.lookup(real.userCode, { id: 'mallory' })).rejects.toMatchObject({ code: 'rate_limited', details: { retryAfterSec: expect.any(Number) } });
    // Other users are unaffected; successes do not count.
    expect(await f.lookup(real.userCode, { id: 'alice' })).not.toBeNull();
    // Window passes → allowed again.
    now += 600_001;
    const fresh = await f.createCode({}, 'ip1');
    expect(await f.approve(fresh.userCode, { id: 'mallory' })).toBe('ok');
  });

  it('lookups of unknown codes count as failures too', async () => {
    const f = flow({ failures: 3, codes: 1000 });
    for (let i = 0; i < 3; i++) expect(await f.lookup('ZZZZ-ZZZZ', { id: 'mallory' })).toBeNull();
    await expect(f.lookup('ZZZZ-ZZZZ', { id: 'mallory' })).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('POST /device/code is limited per client', async () => {
    const f = flow({ failures: 10, codes: 2 });
    await f.createCode({}, 'ip1');
    await f.createCode({}, 'ip1');
    await expect(f.createCode({}, 'ip1')).rejects.toMatchObject({ code: 'rate_limited' });
    await f.createCode({}, 'ip2');
    now += 60_001;
    await f.createCode({}, 'ip1');
  });

  it('parallel guesses reserve their attempt before awaiting', async () => {
    const f = flow({ failures: 3, codes: 1000 });
    const rs = await Promise.allSettled(Array.from({ length: 10 }, () => f.lookup('ZZZZ-ZZZZ', { id: 'mallory' })));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    // Successes give their reservation back.
    const g = flow({ failures: 2, codes: 1000 });
    const c = await g.createCode({}, 'ip');
    for (let i = 0; i < 5; i++) expect(await g.lookup(c.userCode, { id: 'alice' })).not.toBeNull();
  });

  it('passes the machineKey hash to createMachine', async () => {
    const f = flow();
    const key = 'k'.repeat(43);
    const code = await f.createCode({ machineKey: key }, 'ip1');
    await f.approve(code.userCode, { id: 'alice' });
    await f.poll(code.deviceCode);
    expect(created).toEqual([{ userId: 'alice', machineKeyHash: await sha256Hex(key) }]);
    expect(JSON.stringify(await store.getDeviceCode(await sha256Hex(code.deviceCode)))).not.toContain(key);
  });

  it('unknown codes', async () => {
    const f = flow();
    expect(await f.poll('nope')).toBeNull();
    expect(await f.approve('ABCD-EFGH', { id: 'alice' })).toBe('not_found');
    expect(await f.approve('garbage', { id: 'alice' })).toBe('not_found');
  });
});
