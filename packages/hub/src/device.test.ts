import { DeviceCodeResponseSchema } from '@uncage/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deviceFlow, generateUserCode, normalizeUserCode, sha256, USER_CODE_ALPHABET } from './device.js';
import { pgliteHubStore } from './store/pglite.js';
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
  const created: Array<{ userId: string; name?: string }> = [];
  const flow = () =>
    deviceFlow({
      store,
      verificationUri: 'https://app.example.com/device',
      site: { id: 'app.example.com', name: 'app.example.com', url: 'https://app.example.com/api/uncage' },
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
    const code = await f.createCode({ name: 'Nathan’s MacBook', os: 'darwin' });
    expect(DeviceCodeResponseSchema.parse(code)).toBeTruthy();
    expect(code.intervalSec).toBe(2);
    expect(code.expiresInSec).toBe(600);
    expect(code.verificationUri).toBe(`https://app.example.com/device?code=${code.userCode}`);
    // Stored hashed, never in plaintext.
    const rec = await store.getDeviceCode(sha256(code.deviceCode));
    expect(rec?.userCodeHash).toBe(sha256(code.userCode));
    expect(JSON.stringify(rec)).not.toContain(code.deviceCode);

    expect(await f.poll(code.deviceCode)).toEqual({ status: 'pending' });
    expect(await f.lookup(code.userCode.toLowerCase())).toMatchObject({ name: 'Nathan’s MacBook', os: 'darwin' });
    expect(await f.approve(code.userCode, { id: 'alice' })).toBe('ok');
    expect(await f.lookup(code.userCode)).toBeNull();
    const ok = await f.poll(code.deviceCode);
    expect(ok).toMatchObject({ status: 'ok', machineId: 'mch_1', machineToken: 'tok_1', site: { id: 'app.example.com' } });
    expect(created).toEqual([{ userId: 'alice', name: 'Nathan’s MacBook', os: 'darwin' }]);
    // The token is issued exactly once.
    expect(await f.poll(code.deviceCode)).toEqual({ status: 'expired' });
    expect(created).toHaveLength(1);
  });

  it('concurrent polls after approval issue one machine', async () => {
    const f = flow();
    const code = await f.createCode({});
    await f.approve(code.userCode, { id: 'alice' });
    const results = await Promise.all([f.poll(code.deviceCode), f.poll(code.deviceCode), f.poll(code.deviceCode)]);
    expect(results.filter((r) => r?.status === 'ok')).toHaveLength(1);
    expect(created).toHaveLength(1);
  });

  it('denied', async () => {
    const f = flow();
    const code = await f.createCode({});
    expect(await f.deny(code.userCode, { id: 'alice' })).toBe('ok');
    expect(await f.poll(code.deviceCode)).toEqual({ status: 'denied' });
    expect(await f.approve(code.userCode, { id: 'alice' })).toBe('not_found');
    expect(created).toHaveLength(0);
  });

  it('expired after 600 s: approve says expired, poll says expired', async () => {
    const f = flow();
    const code = await f.createCode({});
    now += 600_000;
    expect(await f.approve(code.userCode, { id: 'alice' })).toBe('expired');
    expect(await f.poll(code.deviceCode)).toEqual({ status: 'expired' });
    expect(await f.lookup(code.userCode)).toBeNull();
  });

  it('approved but not collected before expiry → expired, no machine', async () => {
    const f = flow();
    const code = await f.createCode({});
    await f.approve(code.userCode, { id: 'alice' });
    now += 601_000;
    expect(await f.poll(code.deviceCode)).toEqual({ status: 'expired' });
    expect(created).toHaveLength(0);
  });

  it('unknown codes', async () => {
    const f = flow();
    expect(await f.poll('nope')).toBeNull();
    expect(await f.approve('ABCD-EFGH', { id: 'alice' })).toBe('not_found');
    expect(await f.approve('garbage', { id: 'alice' })).toBe('not_found');
  });
});
