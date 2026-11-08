import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeAcpPath } from '@uncage/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAcpAgents, discoverAcpAgents, hostPlatform } from './discover.js';
import { parseRegistry, type AcpRegistry } from './registry.js';
import { FAKE_ICON_SVG, fakeRegistry } from './test-registry.js';
import { createWhich } from './which.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const ICON = `data:image/svg+xml;base64,${Buffer.from(FAKE_ICON_SVG).toString('base64')}`;
/** The fake registry as a snapshot: icons already downloaded as data URIs. */
const registry = (): AcpRegistry => {
  const { version, agents } = parseRegistry(fakeRegistry);
  return { version, agents: agents.map((a) => ({ ...a, icon: ICON })), fetchedAt: '2026-11-08T00:00:00.000Z', source: 'bundled' };
};

/** A temp PATH with fake executables; `npx`/`uvx` record every invocation. */
async function fakePath(bins: Record<string, 'acp' | 'broken'>) {
  const root = await mkdtemp(join(tmpdir(), 'uncage-acp-disc-'));
  dirs.push(root);
  const bin = join(root, 'bin');
  const cache = join(root, 'cache');
  const log = join(root, 'invocations.log');
  await mkdir(bin);
  const script = (body: string) => `#!/bin/sh\n${body}\n`;
  for (const [name, kind] of Object.entries(bins)) {
    const body = kind === 'acp' ? `exec "${process.execPath}" "${fakeAcpPath}" "$@"` : 'echo broken >&2; exit 3';
    await writeFile(join(bin, name), script(body));
    await chmod(join(bin, name), 0o755);
  }
  for (const runner of ['npx', 'uvx']) {
    await writeFile(join(bin, runner), script(`echo "${runner} $*" >> "${log}"; exit 1`));
    await chmod(join(bin, runner), 0o755);
  }
  const invocations = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return { bin, cache, which: createWhich({ PATH: bin }), invocations };
}

const base = { presets: 'off' as const, agents: [] };

describe('ACP registry discovery', () => {
  it('a binary agent on PATH that passes the ACP handshake is enabled, with its icon; the process is gone afterwards', async () => {
    const p = await fakePath({ fakebin: 'acp' });
    const r = await discoverAcpAgents({ registry: registry(), config: base, allowBypass: false, which: p.which, platform: hostPlatform(), cacheDir: p.cache });
    expect(r.adapters.map((a) => [a.id, a.displayName, a.command])).toEqual([['acp-fakebin', 'Fake Bin', [join(p.bin, 'fakebin'), 'acp']]]);
    expect(r.catalog.find((c) => c.registryId === 'fakebin')).toMatchObject({ status: 'enabled', runtimeId: 'acp-fakebin', agentVersion: '1.0.0' });
    // The npx entry is listed as available (needs consent) and never run.
    expect(r.catalog.find((c) => c.registryId === 'fakenpx')).toMatchObject({ status: 'available', distribution: 'npx' });
    expect(await p.invocations()).toEqual([]);
  });

  it('the handshake result is cached per path and file version', async () => {
    const p = await fakePath({ fakebin: 'acp' });
    const o = { registry: registry(), config: base, allowBypass: false, which: p.which, platform: hostPlatform(), cacheDir: p.cache };
    const probes: string[] = [];
    const handshake = async (a: { command: string[] }) => {
      probes.push(a.command[0]!);
      return { status: 'available' as const, version: '9.9.9' };
    };
    await discoverAcpAgents({ ...o, handshake });
    await discoverAcpAgents({ ...o, handshake });
    expect(probes).toHaveLength(1);
    // A new binary at the same path (different size/mtime) is checked again.
    await writeFile(join(p.bin, 'fakebin'), `#!/bin/sh\nexec "${process.execPath}" "${fakeAcpPath}" "$@" # v2\n`);
    const r = await discoverAcpAgents({ ...o, handshake });
    expect(probes).toHaveLength(2);
    expect(r.catalog.find((c) => c.registryId === 'fakebin')?.agentVersion).toBe('9.9.9');
    expect((await stat(join(p.cache, 'detect.json'))).isFile()).toBe(true);
  });

  it('a binary that fails the handshake is not enabled', async () => {
    const p = await fakePath({ fakebin: 'broken' });
    const r = await discoverAcpAgents({ registry: registry(), config: base, allowBypass: false, which: p.which, platform: hostPlatform(), cacheDir: p.cache });
    expect(r.adapters).toEqual([]);
    expect(r.catalog.find((c) => c.registryId === 'fakebin')).toMatchObject({ status: 'failed' });
  });

  it('not on PATH → not installed; autoDetect false → nothing is probed', async () => {
    const p = await fakePath({});
    const r = await discoverAcpAgents({ registry: registry(), config: base, allowBypass: false, which: p.which, platform: hostPlatform(), cacheDir: p.cache });
    expect(r.adapters).toEqual([]);
    expect(r.catalog.find((c) => c.registryId === 'fakebin')?.status).toBe('not_installed');
    const q = await fakePath({ fakebin: 'acp' });
    let probed = 0;
    const r2 = await discoverAcpAgents({
      registry: registry(), config: { ...base, autoDetect: false }, allowBypass: false, which: q.which, platform: hostPlatform(), cacheDir: q.cache,
      handshake: async () => {
        probed++;
        return { status: 'available' };
      },
    });
    expect(probed).toBe(0);
    expect(r2.adapters).toEqual([]);
  });

  it('disable wins over detection; enable gives consent to an npx entry (registered, still not run here)', async () => {
    const p = await fakePath({ fakebin: 'acp' });
    const o = { registry: registry(), allowBypass: false, which: p.which, platform: hostPlatform(), cacheDir: p.cache };
    const off = await discoverAcpAgents({ ...o, config: { ...base, disable: ['fakebin'] } });
    expect(off.adapters).toEqual([]);
    expect(off.catalog.find((c) => c.registryId === 'fakebin')?.status).toBe('disabled');
    const on = await discoverAcpAgents({ ...o, config: { ...base, enable: ['fakenpx'], disable: ['acp-fakebin'] } });
    expect(on.adapters.map((a) => [a.id, a.command])).toEqual([['acp-fakenpx', ['npx', '-y', 'fake-npx@0.1.0', '--acp']]]);
    expect(on.catalog.find((c) => c.registryId === 'fakenpx')?.status).toBe('enabled');
    expect(await p.invocations()).toEqual([]);
  });

  it('manual entries win over registry entries with the same id', async () => {
    const p = await fakePath({ fakebin: 'acp' });
    const r = await buildAcpAgents(
      { presets: 'off', agents: [{ id: 'fakebin', displayName: 'Mine', command: ['node', fakeAcpPath], mcp: 'auto', enabled: true }] },
      { registry: registry(), allowBypass: false, which: p.which, platform: hostPlatform(), cacheDir: p.cache },
    );
    expect(r.adapters.map((a) => [a.id, a.displayName])).toEqual([['acp-fakebin', 'Mine']]);
    // It still gets the registry's official icon.
    expect(r.adapters[0]!.icon?.light).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(r.catalog.find((c) => c.registryId === 'fakebin')?.status).toBe('manual');
  });
});
