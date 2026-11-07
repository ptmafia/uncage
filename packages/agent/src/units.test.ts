import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeviceCodeResponse } from '@uncage/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { agentConfigPath, loadAgentConfig, newMachineKey, updateAgentSites } from './config.js';
import { agentWsUrl, normalizeHubUrl, pollDeviceToken, requestDeviceCode } from './device.js';
import { planPull } from './files.js';
import { backoffDelay, siteHost } from './site.js';
import { startTestHub, tmpHome } from './test-helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined);
});
const home = async () => {
  const h = await tmpHome();
  cleanups.push(h.cleanup);
  return h.home;
};

describe('normalizeHubUrl / agentWsUrl', () => {
  it('appends /api/uncage when the URL has no path, keeps an explicit path', () => {
    expect(normalizeHubUrl('https://app.example.com')).toBe('https://app.example.com/api/uncage');
    expect(normalizeHubUrl('https://app.example.com/')).toBe('https://app.example.com/api/uncage');
    expect(normalizeHubUrl('app.example.com')).toBe('https://app.example.com/api/uncage');
    expect(normalizeHubUrl('https://app.example.com/hub/')).toBe('https://app.example.com/hub');
    expect(normalizeHubUrl('http://localhost:3000')).toBe('http://localhost:3000/api/uncage');
  });
  it('refuses plain http to non-loopback hosts, other schemes and credentials', () => {
    expect(() => normalizeHubUrl('http://app.example.com')).toThrow(/https/);
    expect(() => normalizeHubUrl('ftp://x.com')).toThrow();
    expect(() => normalizeHubUrl('https://u:p@x.com')).toThrow(/credentials/);
  });
  it('maps to wss (ws only for loopback)', () => {
    expect(agentWsUrl('https://app.example.com/api/uncage')).toBe('wss://app.example.com/api/uncage/agent');
    expect(agentWsUrl('http://127.0.0.1:8080/api/uncage')).toBe('ws://127.0.0.1:8080/api/uncage/agent');
    expect(() => agentWsUrl('http://evil.example.com/api/uncage')).toThrow(/insecure/);
  });
  it('siteHost is filesystem-safe', () => {
    expect(siteHost('https://App.Example.com/api/uncage')).toBe('app.example.com');
    expect(siteHost('http://127.0.0.1:8080/x')).toBe('127.0.0.1-8080');
  });
});

describe('backoffDelay', () => {
  const t = { backoffMinMs: 1000, backoffMaxMs: 30_000 };
  it('doubles from 1 s to a 30 s cap, jittered within [base/2, base]', () => {
    expect(backoffDelay(0, t, () => 1)).toBe(1000);
    expect(backoffDelay(0, t, () => 0)).toBe(500);
    expect(backoffDelay(3, t, () => 1)).toBe(8000);
    expect(backoffDelay(10, t, () => 1)).toBe(30_000);
    expect(backoffDelay(99, t, () => 0)).toBe(15_000);
  });
});

describe('agent config', () => {
  const site = { id: 'app.example.com', name: 'App', url: 'https://app.example.com/api/uncage', machineId: 'mch_1', token: 'secret-token' };

  it('missing file → no sites, bypass off', async () => {
    expect(await loadAgentConfig(await home())).toEqual({ sites: [], localPolicy: { allowBypass: false } });
  });

  it('round-trips sites, preserves hand-written localPolicy and comments, writes 0600', async () => {
    const h = await home();
    await mkdir(join(h, '.uncage'), { recursive: true });
    await writeFile(agentConfigPath(h), '# my notes\nlocalPolicy:\n  allowBypass: true # yes really\n  allowedPermissionModes: [default, acceptEdits]\n');
    const key = newMachineKey();
    await updateAgentSites(h, () => [{ ...site, machineKey: key }]);
    const raw = await readFile(agentConfigPath(h), 'utf8');
    expect(raw).toContain('# my notes');
    expect(raw).toContain('# yes really');
    expect(((await stat(agentConfigPath(h))).mode & 0o777).toString(8)).toBe('600');
    expect(await loadAgentConfig(h)).toEqual({
      sites: [{ ...site, machineKey: key }],
      localPolicy: { allowBypass: true, allowedPermissionModes: ['default', 'acceptEdits'] },
    });
  });

  it('tightens a group/world-readable file to 0600 on load', async () => {
    const h = await home();
    await updateAgentSites(h, () => [site]);
    await chmod(agentConfigPath(h), 0o644);
    await loadAgentConfig(h);
    expect(((await stat(agentConfigPath(h))).mode & 0o777).toString(8)).toBe('600');
  });

  it('rejects unsafe site ids, unknown keys and bad modes', async () => {
    const h = await home();
    await expect(updateAgentSites(h, () => [{ ...site, id: '../etc' }])).rejects.toThrow();
    await mkdir(join(h, '.uncage'), { recursive: true });
    await writeFile(agentConfigPath(h), 'localPolicy:\n  allowBypas: true\n');
    await expect(loadAgentConfig(h)).rejects.toThrow(/Invalid/);
    await writeFile(agentConfigPath(h), 'localPolicy:\n  allowedPermissionModes: [yolo]\n');
    await expect(loadAgentConfig(h)).rejects.toThrow(/allowedPermissionModes/);
  });

  it('machine keys are 32 random bytes, base64url', () => {
    const k = newMachineKey();
    expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(k, 'base64url')).toHaveLength(32);
    expect(newMachineKey()).not.toBe(k);
  });
});

describe('device flow client', () => {
  it('pairs against a real hub with programmatic approval, sending the machineKey', async () => {
    const t = await startTestHub();
    cleanups.push(() => t.close());
    const key = newMachineKey();
    const code = await requestDeviceCode(fetch, t.api, { name: 'Mac', os: 'darwin', machineKey: key });
    expect(code.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const polling = pollDeviceToken({ fetch, hubUrl: t.api, code: { ...code, intervalSec: 1 } });
    await new Promise((r) => setTimeout(r, 200));
    expect(await t.hub.approveDevice(code.userCode, { id: 'alice' })).toBe('ok');
    const grant = await polling;
    expect(grant).toMatchObject({ status: 'ok', site: { url: t.api } });
    // Re-pairing with the same key keeps the machine id.
    const code2 = await requestDeviceCode(fetch, t.api, { machineKey: key });
    await t.hub.approveDevice(code2.userCode, { id: 'alice' });
    const grant2 = await pollDeviceToken({ fetch, hubUrl: t.api, code: { ...code2, intervalSec: 1 } });
    expect(grant2.machineId).toBe(grant.machineId);
    expect(grant2.machineToken).not.toBe(grant.machineToken);
  }, 15_000);

  const code: DeviceCodeResponse = { deviceCode: 'd', userCode: 'ABCD-EFGH', verificationUri: 'https://x/device', intervalSec: 2, expiresInSec: 600 };
  const scripted = (statuses: unknown[]) => {
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(statuses.shift()), { status: 200 });
    }) as unknown as typeof fetch;
    return { f, calls };
  };

  it('honours slow_down (+5 s) and keeps polling on pending', async () => {
    const waits: number[] = [];
    const { f } = scripted([{ status: 'pending' }, { status: 'slow_down' }, { status: 'ok', machineId: 'm', machineToken: 't', site: { id: 's', name: 's', url: 'https://x/api/uncage' } }]);
    const g = await pollDeviceToken({ fetch: f, hubUrl: 'https://x/api/uncage', code, sleep: async (ms) => void waits.push(ms) });
    expect(g.machineId).toBe('m');
    expect(waits).toEqual([2000, 2000, 7000]);
  });

  it('denied and expired end with clear errors', async () => {
    await expect(pollDeviceToken({ fetch: scripted([{ status: 'denied' }]).f, hubUrl: 'https://x', code, sleep: async () => undefined })).rejects.toThrow(/denied/);
    await expect(pollDeviceToken({ fetch: scripted([{ status: 'expired' }]).f, hubUrl: 'https://x', code, sleep: async () => undefined })).rejects.toThrow(/expired/);
  });
});

describe('planPull fence', () => {
  it('rejects traversal and absolute paths even if the frame schema were bypassed', async () => {
    const h = await home();
    await expect(planPull(h, '../etc/hosts', 100)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(planPull(h, '/etc/hosts', 100)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(planPull(h, 'a/../../x', 100)).rejects.toMatchObject({ code: 'invalid_request' });
  });
  it('caps the total at 50 MiB even when maxBytes asks for more', async () => {
    const h = await home();
    await writeFile(join(h, 'f.txt'), 'abc');
    expect((await planPull(h, 'f.txt', 10 ** 12)).map((f) => f.rel)).toEqual(['f.txt']);
  });
});
