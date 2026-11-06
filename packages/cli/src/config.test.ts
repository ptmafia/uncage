import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const tmp = () => mkdtemp(join(tmpdir(), 'uncage-cfg-'));

describe('loadConfig', () => {
  it('defaults with no file', async () => {
    const cwd = await tmp();
    const c = await loadConfig(cwd, {});
    expect(c.server.port).toBe(4783);
    expect(c.server.eventRetentionDays).toBe(7);
    expect(c.security).toEqual({ allowedOrigins: [], approvalTtlMs: 600_000, allowBypass: false });
    expect(c.workspace).toEqual({ allowedRoots: [cwd], default: cwd });
    expect(c.runtimes.claude.enabled).toBe(true);
    expect(c.runtimes.codex.enabled).toBe(true);
  });

  it('reads yaml and merges with defaults', async () => {
    const cwd = await tmp();
    await writeFile(join(cwd, 'uncage.config.yaml'), 'server:\n  port: 5000\nruntimes:\n  codex:\n    enabled: false\n');
    const c = await loadConfig(cwd, {});
    expect(c.server.port).toBe(5000);
    expect(c.server.eventRetentionDays).toBe(7);
    expect(c.runtimes.codex.enabled).toBe(false);
  });

  it('rejects unknown key naming it', async () => {
    const cwd = await tmp();
    await writeFile(join(cwd, 'uncage.config.yaml'), 'security:\n  bypassPermissions: true\n');
    await expect(loadConfig(cwd, {})).rejects.toThrow(/security\.bypassPermissions/);
  });

  it('rejects unknown top-level key', async () => {
    const cwd = await tmp();
    await writeFile(join(cwd, 'uncage.config.yaml'), 'telemetry: true\n');
    await expect(loadConfig(cwd, {})).rejects.toThrow(/telemetry/);
  });

  it('env UNCAGE_PORT overrides', async () => {
    const cwd = await tmp();
    await writeFile(join(cwd, 'uncage.config.yaml'), 'server:\n  port: 5000\n');
    expect((await loadConfig(cwd, { UNCAGE_PORT: '6001' })).server.port).toBe(6001);
  });

  it('security.allowBypass default false', async () => {
    expect((await loadConfig(await tmp(), {})).security.allowBypass).toBe(false);
  });

  it('reads security.allowBypass from yaml', async () => {
    const cwd = await tmp();
    await writeFile(join(cwd, 'uncage.config.yaml'), 'security:\n  allowBypass: true\n');
    expect((await loadConfig(cwd, {})).security.allowBypass).toBe(true);
    await writeFile(join(cwd, 'uncage.config.yaml'), 'security:\n  allowBypass: "yes"\n');
    await expect(loadConfig(cwd, {})).rejects.toThrow(/security\.allowBypass/);
  });

  it('UNCAGE_ALLOW_BYPASS=1 → true', async () => {
    const cwd = await tmp();
    expect((await loadConfig(cwd, { UNCAGE_ALLOW_BYPASS: '1' })).security.allowBypass).toBe(true);
    await writeFile(join(cwd, 'uncage.config.yaml'), 'security:\n  allowBypass: false\n');
    expect((await loadConfig(cwd, { UNCAGE_ALLOW_BYPASS: '1' })).security.allowBypass).toBe(true);
    for (const v of ['', '0', 'true', 'no']) {
      expect((await loadConfig(cwd, { UNCAGE_ALLOW_BYPASS: v })).security.allowBypass, v).toBe(false);
    }
  });

  it('rejects an invalid UNCAGE_PORT', async () => {
    await expect(loadConfig(await tmp(), { UNCAGE_PORT: 'abc' })).rejects.toThrow(/UNCAGE_PORT/);
  });
});
