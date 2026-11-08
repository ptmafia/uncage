import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHub, HUB_VERSION, normalizeWorkspacePath } from './hub.js';
import { newNodeId, routedId, routeOf } from './ids.js';
import { defaultCliRange } from './install/render.js';
import { pgliteHubStore } from './node/index.js';
import type { HubStore } from './store/store.js';
import type { Hub, HubOptions } from './types.js';
import { fromBase64, randomHex, randomInt, randomToken, sha256Hex, toBase64, utf8Length } from './web.js';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const built = existsSync(join(pkgDir, 'dist/index.js'));
const needsBuild = built ? '' : ' (skipped: dist/index.js missing, run `pnpm --filter @uncage/hub build` first)';

let store: HubStore;
beforeAll(async () => {
  store = await pgliteHubStore({ dataDir: 'memory://' });
});
afterAll(async () => {
  await store.close();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the Web-standard hub core', () => {
  it('createHub refuses to start without a store', async () => {
    await expect(createHub({ publicUrl: 'https://a.example', getUser: async () => null } as unknown as HubOptions)).rejects.toThrow(/store is required/);
  });

  it('createHub starts no timers (FaaS instances must not keep background work)', async () => {
    vi.useFakeTimers();
    const hub = await createHub({ publicUrl: 'https://a.example', getUser: async () => null, store });
    expect(vi.getTimerCount()).toBe(0);
    await hub.close();
  });

  it('hub.fetch serves the public install script without any Node handler', async () => {
    const hub: Hub = await createHub({ publicUrl: 'https://a.example', getUser: async () => null, store });
    try {
      const res = await hub.fetch(new Request('https://a.example/api/uncage/install.sh'));
      expect(res.status).toBe(200);
      // `^0.3` once the packages are versioned 0.3.0 (release prep); the range follows HUB_VERSION.
      expect(await res.text()).toContain(`@uncage/cli@${defaultCliRange(HUB_VERSION)}`);
      expect((await hub.fetch(new Request('https://a.example/elsewhere'))).status).toBe(404);
    } finally {
      await hub.close();
    }
  });

  it('hub.close never closes the store it was given', async () => {
    const hub = await createHub({ publicUrl: 'https://a.example', getUser: async () => null, store });
    await hub.close();
    expect(await store.getMachine('mch_none')).toBeNull();
  });

  it.skipIf(!built)(`the root bundle contains no Node built-ins${needsBuild}`, () => {
    const r = spawnSync(process.execPath, ['scripts/check-web-entry.mjs'], { cwd: pkgDir, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0); // Review Focus #5
  });

  it('check-web-entry fails on Node built-ins and Node globals, allowing only typeof checks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uncage-cwe-'));
    try {
      const run = (name: string, code: string) => {
        writeFileSync(join(dir, name), code);
        return spawnSync(process.execPath, ['scripts/check-web-entry.mjs', join(dir, name)], { cwd: pkgDir, encoding: 'utf8' });
      };
      const fs = run('fs.mjs', "import { readFileSync } from 'node:fs';\nexport const f = readFileSync;\n");
      expect(fs.status).toBe(1);
      expect(fs.stderr).toContain('Node built-in: node:fs');
      const globals = run(
        'globals.mjs',
        'export const a = new Buffer(1);\nexport const b = (x) => x instanceof Buffer;\nexport const c = process?.env;\nexport const d = process["env"];\nexport const e = globalThis.process;\n',
      );
      expect(globals.status).toBe(1);
      for (const g of ['Buffer(1)', 'process?.env', 'process["env"]']) expect(globals.stderr).toContain(g);
      const clean = run('clean.mjs', 'export const ok = typeof process !== "undefined";\nexport const s = "another process. Buffer.from(x)";\n');
      expect(clean.status, clean.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('web helpers', () => {
  it('base64 round-trips and matches Buffer (standard and url alphabets)', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 255, 256 * 1024 + 1]) {
      const b = new Uint8Array(n).map((_, i) => (i * 37 + n) & 0xff);
      const s = toBase64(b);
      expect(s).toBe(Buffer.from(b).toString('base64'));
      expect(fromBase64(s)).toEqual(b);
      expect(fromBase64(Buffer.from(b).toString('base64url'))).toEqual(b);
    }
  });

  it('sha256Hex, randomToken, randomHex, randomInt, utf8Length', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomHex(12)).toMatch(/^[0-9a-f]{24}$/);
    for (let i = 0; i < 200; i++) expect(randomInt(31)).toBeLessThan(31);
    for (const s of ['', 'abc', 'é', '日本語', '😀', '\ud800x']) expect(utf8Length(s)).toBe(Buffer.byteLength(s, 'utf8'));
  });

  it('routed ids carry their node', () => {
    const node = newNodeId();
    expect(node).toMatch(/^node_[0-9a-f]{16}$/);
    for (const p of ['cmd', 'pull', 'upl'] as const) expect(routeOf(routedId(p, node))).toBe(node);
    expect(routeOf('cmd_abc')).toBeNull();
    expect(routeOf(`res_${node}_${'0'.repeat(24)}`)).toBeNull();
  });

  it('workspace paths normalize like posix.normalize and never leave the workspace', () => {
    expect(normalizeWorkspacePath('./a//b/')).toBe('a/b');
    expect(normalizeWorkspacePath('a\\b\\..\\c')).toBe('a/c');
    expect(normalizeWorkspacePath('a/./b/../c')).toBe('a/c');
    for (const bad of ['', '.', '..', '../a', 'a/../..', 'a/../../b', '/etc/passwd', '\\x', './']) {
      expect(() => normalizeWorkspacePath(bad), bad).toThrow(/not a path inside the session workspace/);
    }
  });
});
