import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isImageDataUri } from '@uncage/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACP_REGISTRY_URL,
  bundledRegistry,
  commandName,
  fetchCapped,
  loadRegistry,
  parseRegistry,
  refreshRegistry,
  refreshRegistryIfStale,
  registryIcon,
} from './registry.js';
import { FAKE_ICON_SVG as ICON, fakeRegistry } from './test-registry.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'uncage-acp-reg-'));
  dirs.push(d);
  return d;
}

function fakeFetch(routes: Record<string, () => Response>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const r = routes[url];
    if (!r) return new Response('not found', { status: 404 });
    return r();
  }) as typeof fetch;
}
const routes = (): Record<string, () => Response> => ({
  [ACP_REGISTRY_URL]: () => Response.json(fakeRegistry),
  'https://cdn.example.com/fakebin.svg': () => new Response(ICON, { headers: { 'content-type': 'image/svg+xml' } }),
  'https://cdn.example.com/fakenpx.svg': () => new Response('x'.repeat(40_000), { headers: { 'content-type': 'image/svg+xml' } }),
});

describe('ACP registry', () => {
  it('invalid entries are ignored (bad id, no distribution, option-like packages, path-like commands)', () => {
    const r = parseRegistry(fakeRegistry);
    expect(r.agents.map((a) => a.id)).toEqual(['fakebin', 'fakenpx']);
    expect(r.skipped.sort()).toEqual(['Bad Id', 'evilcmd', 'evilpkg', 'nodist']);
    expect(r.agents[0]!.distribution.binary?.['darwin-aarch64']).toEqual({ cmd: 'fakebin', args: ['acp'], env: {} });
    expect(() => parseRegistry({ agents: 'nope' })).toThrow();
  });

  it('refuses interpreter, shell and package-runner binaries and sensitive env names', () => {
    const bin = (cmd: string, env: Record<string, string> = {}) => ({ binary: { 'linux-x86_64': { archive: 'x', cmd, args: ['acp'], env } } });
    const entry = (id: string, distribution: unknown) => ({ id, name: id, version: '1.0.0', distribution });
    const refused = ['node', './node.exe', 'bun', 'deno', 'python3', 'python3.12', 'ruby', 'perl', 'sh', 'bash', 'zsh', 'fish', 'env', 'cmd.exe', 'powershell', 'pwsh', 'npx', 'uvx', 'bunx', 'pnpm', 'npm', 'osascript', 'Bash'];
    const envs = ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONSTARTUP', 'PATH', 'HOME', 'MY_PRELOAD'];
    const r = parseRegistry({
      version: '1',
      agents: [
        ...refused.map((c, i) => entry(`r${i}`, bin(c))),
        ...envs.map((e, i) => entry(`e${i}`, bin('agent', { [e]: 'x' }))),
        entry('npxenv', { npx: { package: 'a', env: { NODE_OPTIONS: '--require /tmp/x.js' } } }),
        entry('ok', bin('agent', { AGENT_MODE: 'acp' })),
      ],
    });
    expect(r.agents.map((a) => a.id)).toEqual(['ok']);
    expect(commandName('.\\pkg\\gemini.cmd')).toBe('gemini');
  });

  it('rejects control characters in names, drops them from descriptions, keeps only https links', () => {
    const r = parseRegistry({
      version: '1',
      agents: [
        { id: 'esc', name: 'Evil\u001b[31m', version: '1', distribution: { npx: { package: 'a' } } },
        { id: 'ver', name: 'Ver', version: '1\u0007', distribution: { npx: { package: 'a' } } },
        { id: 'ok', name: 'Ok', version: '1', description: 'bad\u001b]8;;x', website: 'http://example.com', repository: 'https://github.com/x/y', distribution: { npx: { package: 'a' } } },
      ],
    });
    expect(r.agents.map((a) => a.id)).toEqual(['ok']);
    expect(r.agents[0]).not.toHaveProperty('description');
    expect(r.agents[0]).not.toHaveProperty('website');
    expect(r.agents[0]!.repository).toBe('https://github.com/x/y');
  });

  it('downloads are https only (also after redirects) and stop reading once over the cap', async () => {
    let pulled = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const f = (async () => new Response(endless)) as unknown as typeof fetch;
    expect(await fetchCapped('https://cdn.example.com/big', f, 100_000, 5000)).toBeUndefined();
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
    const plain = (async () => new Response('ok')) as unknown as typeof fetch;
    expect(await fetchCapped('http://cdn.example.com/x', plain, 100, 5000)).toBeUndefined();
    const redirected = (async () => Object.defineProperty(new Response('ok'), 'url', { value: 'http://evil.example.com/x' })) as unknown as typeof fetch;
    expect(await fetchCapped('https://cdn.example.com/x', redirected, 100, 5000)).toBeUndefined();
    expect(new TextDecoder().decode(await fetchCapped('https://cdn.example.com/x', plain, 100, 5000))).toBe('ok');
    await expect(refreshRegistry({ cacheDir: await tmp(), fetch: plain, url: 'http://cdn.example.com/registry.json' })).rejects.toThrow(/https/);
  });

  it('the bundled snapshot is valid and carries official icons as data URIs (claude-acp and codex-acp too)', () => {
    const b = bundledRegistry();
    expect(b.source).toBe('bundled');
    expect(b.agents.length).toBeGreaterThan(10);
    const ids = b.agents.map((a) => a.id);
    for (const id of ['claude-acp', 'codex-acp', 'gemini', 'opencode']) expect(ids).toContain(id);
    for (const a of b.agents) if (a.icon) expect(isImageDataUri(a.icon)).toBe(true);
    const claude = registryIcon(b.agents.find((a) => a.id === 'claude-acp')!);
    expect(claude && isImageDataUri(claude.light) && isImageDataUri(claude.dark)).toBe(true);
  });

  it('registryIcon makes light/dark variants of a currentColor svg', () => {
    const data = `data:image/svg+xml;base64,${Buffer.from(ICON).toString('base64')}`;
    const icon = registryIcon({ icon: data });
    const decode = (u: string) => Buffer.from(u.split(',')[1]!, 'base64').toString('utf8');
    expect(decode(icon!.light)).not.toContain('currentColor');
    expect(decode(icon!.dark!)).not.toContain('currentColor');
    expect(decode(icon!.light)).not.toBe(decode(icon!.dark!));
    const plain = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path fill="#f00"/></svg>').toString('base64')}`;
    expect(registryIcon({ icon: plain })).toEqual({ light: plain });
    expect(registryIcon({})).toBeUndefined();
  });

  it('refresh downloads the registry and its icons (oversized icons dropped), then loadRegistry prefers the cache', async () => {
    const dir = await tmp();
    const r = await refreshRegistry({ cacheDir: dir, fetch: fakeFetch(routes()), now: () => new Date('2026-11-08T00:00:00Z') });
    expect(r.agents.map((a) => a.id)).toEqual(['fakebin', 'fakenpx']);
    expect(r.agents[0]!.icon).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(r.agents[1]!.icon).toBeUndefined();
    const loaded = await loadRegistry(dir);
    expect(loaded).toMatchObject({ source: 'cache', fetchedAt: '2026-11-08T00:00:00.000Z' });
    expect(loaded.agents.map((a) => a.id)).toEqual(['fakebin', 'fakenpx']);
  });

  it('offline: a failed refresh keeps the bundled snapshot; a corrupt cache falls back to it too', async () => {
    const dir = await tmp();
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(refreshRegistry({ cacheDir: dir, fetch: offline })).rejects.toThrow();
    expect((await loadRegistry(dir)).source).toBe('bundled');
    await writeFile(join(dir, 'registry.json'), '{"not":"a snapshot"');
    expect((await loadRegistry(dir)).source).toBe('bundled');
    expect((await loadRegistry(undefined)).source).toBe('bundled');
  });

  it('refreshRegistryIfStale tries at most once per day, also when offline', async () => {
    const dir = await tmp();
    const calls: string[] = [];
    let now = new Date('2026-11-08T00:00:00Z');
    const offline = (async (u: string) => {
      calls.push(String(u));
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await refreshRegistryIfStale({ cacheDir: dir, fetch: offline, now: () => now })).toBe('failed');
    expect(await refreshRegistryIfStale({ cacheDir: dir, fetch: offline, now: () => now })).toBe('fresh');
    expect(calls).toHaveLength(1);
    now = new Date('2026-11-09T00:00:01Z');
    const ok = fakeFetch(routes(), calls);
    expect(await refreshRegistryIfStale({ cacheDir: dir, fetch: ok, now: () => now })).toBe('refreshed');
    expect(await refreshRegistryIfStale({ cacheDir: dir, fetch: ok, now: () => now })).toBe('fresh');
    expect(JSON.parse(await readFile(join(dir, 'registry.json'), 'utf8')).agents).toHaveLength(2);
  });
});
