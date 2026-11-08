import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ACP_RUNTIMES, loadAgentConfig, updateAgentSites } from '@uncage/agent';
import type { RuntimeAdapter, RuntimeCapabilities, RuntimeProbe } from '@uncage/protocol';
import { acpAdapter } from '@uncage/runtime-acp';
import { fakeAcpPath } from '@uncage/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { projectAcpCommands, setupAcp } from './acp.js';
import { agentAdapters } from './agent-cmd.js';
import { runRuntimes, toggleRuntime } from './runtimes-cmd.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tmp(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const caps = (over: Partial<RuntimeCapabilities> = {}): RuntimeCapabilities => ({
  streaming: true,
  approval: { once: true, session: false, types: ['shell'] },
  nativeResume: true,
  diffEvents: false,
  mcp: true,
  skills: 'supported',
  siteTools: true,
  models: [],
  efforts: [],
  permissionModes: ['default'],
  attachments: { images: false, files: false, maxBytes: 0 },
  ...over,
});
function stub(id: string, displayName: string, probe: RuntimeProbe, c: RuntimeCapabilities, disposed: string[]): RuntimeAdapter {
  return {
    id,
    displayName,
    probe: async () => probe,
    capabilities: () => c,
    run: async function* () {},
    dispose: async () => {
      disposed.push(id);
    },
  };
}

describe('uncage runtimes', () => {
  it('uncage runtimes prints id, name, status, version, site tools and resume for every runtime; --json is parseable', async () => {
    const disposed: string[] = [];
    const real = acpAdapter({ id: 'acp-fake', displayName: 'Fake ACP', command: [process.execPath, fakeAcpPath], mcp: 'off' });
    const adapters = [
      stub('claude', 'Claude Code', { status: 'available', version: '2.1.0' }, caps(), disposed),
      stub('acp-gemini', 'Gemini CLI (ACP)', { status: 'not_installed', hint: 'npm i -g @google/gemini-cli' }, caps({ nativeResume: false }), disposed),
      real,
    ];
    const lines: string[] = [];
    expect(await runRuntimes({ adapters, json: false, out: (s) => lines.push(s) })).toBe(0);
    const text = lines.join('\n');
    expect(text).toMatch(/ID\s+NAME\s+STATUS\s+VERSION\s+SITE TOOLS\s+RESUME/);
    expect(text).toMatch(/claude\s+Claude Code\s+available\s+2\.1\.0\s+yes\s+yes/);
    expect(text).toMatch(/acp-gemini\s+Gemini CLI \(ACP\)\s+not installed\s+-\s+yes\s+no/);
    // The fake agent advertises loadSession, learnt from the handshake; mcp: 'off' → no site tools.
    expect(text).toMatch(/acp-fake\s+Fake ACP\s+available\s+1\.0\.0\s+no\s+yes/);
    expect(text).toContain('npm i -g @google/gemini-cli');
    // Every adapter is disposed: no agent process outlives the command.
    expect(disposed.sort()).toEqual(['acp-gemini', 'claude']);

    const json: string[] = [];
    const real2 = acpAdapter({ id: 'acp-fake', displayName: 'Fake ACP', command: [process.execPath, fakeAcpPath] });
    await runRuntimes({
      adapters: [stub('claude', 'Claude Code', { status: 'available' }, caps(), disposed), real2],
      json: true,
      out: (s) => json.push(s),
      catalog: [{ registryId: 'fakenpx', runtimeId: 'acp-fakenpx', name: 'Fake Npx', version: '1', distribution: 'npx', status: 'available', hint: 'uncage runtimes enable fakenpx' }],
    });
    const parsed = JSON.parse(json.join('\n')) as { runtimes: Array<Record<string, unknown>>; registry: Array<Record<string, unknown>> };
    expect(parsed.runtimes).toEqual([
      { id: 'claude', displayName: 'Claude Code', status: 'available', siteTools: true, resume: true },
      { id: 'acp-fake', displayName: 'Fake ACP', status: 'available', version: '1.0.0', siteTools: true, resume: true },
    ]);
    expect(parsed.registry[0]).toMatchObject({ registryId: 'fakenpx', status: 'available' });
  });

  it('lists registry agents that are not enabled, with how to enable them', async () => {
    const lines: string[] = [];
    await runRuntimes({
      adapters: [],
      json: false,
      out: (s) => lines.push(s),
      catalog: [
        { registryId: 'fakenpx', runtimeId: 'acp-fakenpx', name: 'Fake Npx', version: '1', distribution: 'npx', status: 'available', hint: 'uncage runtimes enable fakenpx' },
        { registryId: 'fakebin', runtimeId: 'acp-fakebin', name: 'Fake Bin', version: '1', distribution: 'binary', status: 'enabled', via: 'detected' },
        { registryId: 'other', runtimeId: 'acp-other', name: 'Other', version: '1', distribution: 'binary', status: 'not_installed' },
      ],
    });
    const text = lines.join('\n');
    expect(text).toMatch(/fakenpx\s+Fake Npx\s+available \(npx\)/);
    expect(text).toContain('uncage runtimes enable <id>');
    expect(text).not.toMatch(/^\s+fakebin/m);
    expect(text).toMatch(/1 more .*not installed/);
  });

  it('terminal output is sanitized: control characters never reach the table', async () => {
    const lines: string[] = [];
    await runRuntimes({
      adapters: [stub('acp-x', 'Evil\u001b[2J', { status: 'error', message: 'boom\u001b]8;;http://x\u0007' }, caps(), [])],
      json: false,
      out: (l) => lines.push(l),
      catalog: [{ registryId: 'y', runtimeId: 'acp-y', name: 'Y\u001b[31m', version: '1', distribution: 'npx', status: 'available', message: 'm\u009b1m' }],
    });
    expect(lines.join('\n')).not.toMatch(/\p{Cc}(?<!\n)/u);
  });

  it('enable/disable write runtimes.acp in agent.yaml (registry, preset and runtime ids); unknown ids are refused', async () => {
    const home = await tmp('uncage-rt-home-');
    await updateAgentSites(home, () => []);
    const none = async () => null;
    const events: string[] = [];
    const yaml = join(home, '.uncage', 'agent.yaml');
    await toggleRuntime({
      home,
      id: 'gemini',
      enable: true,
      which: none,
      // The consent text is printed before anything is written.
      out: (s) => events.push(`${s} [written: ${String(readFileSync(yaml, 'utf8').includes('gemini'))}]`),
    });
    expect(events[0]).toBe(
      'Uncage will download and run @google/gemini-cli from npm now and whenever the agent starts. Undo: uncage runtimes disable gemini. [written: false]',
    );
    expect(events[1]).toMatch(/^ {2}Command: npx @google\/gemini-cli --acp/);
    expect((await loadAgentConfig(home)).runtimes?.acp).toMatchObject({
      enable: ['gemini'],
      consented: { gemini: { runner: 'npx', package: '@google/gemini-cli', args: ['--acp'], env: {} } },
      disable: [],
    });
    await toggleRuntime({ home, id: 'acp-gemini', enable: false, which: none, out: () => undefined });
    expect((await loadAgentConfig(home)).runtimes?.acp).toMatchObject({ enable: [], consented: {}, disable: ['gemini'] });
    await toggleRuntime({ home, id: 'acp-claude', enable: true, which: none, out: () => undefined });
    expect((await loadAgentConfig(home)).runtimes?.acp).toMatchObject({ enable: ['claude-acp'], consented: { 'claude-acp': { runner: 'npx', package: '@agentclientprotocol/claude-agent-acp', args: [] } } });
    await expect(toggleRuntime({ home, id: 'no-such-agent', enable: true, which: none, out: () => undefined })).rejects.toThrow(/Unknown ACP agent/);
    expect((await loadAgentConfig(home)).runtimes?.acp.disable).toEqual(['gemini']);
    // Installed locally: no download is mentioned; the consent is for that command, args and env.
    const out: string[] = [];
    await toggleRuntime({ home, id: 'goose', enable: true, which: async (c) => (c === 'goose' ? '/usr/local/bin/goose' : null), out: (s) => out.push(s) });
    expect(out[0]).toBe('Uncage will run /usr/local/bin/goose acp whenever the agent starts. Undo: uncage runtimes disable goose.');
    expect((await loadAgentConfig(home)).runtimes?.acp.consented.goose).toEqual({ runner: 'local', cmd: 'goose', args: ['acp'], env: {} });
  });

  it('projectAcpCommands lists the commands uncage.config.yaml makes Uncage run', () => {
    const acp = {
      ...DEFAULT_ACP_RUNTIMES,
      agents: [
        { id: 'mine', command: ['node', 'agent.js'], mcp: 'auto' as const, enabled: true },
        { id: 'off', command: ['x'], mcp: 'auto' as const, enabled: false },
        { id: 'gem', preset: 'gemini' as const, mcp: 'auto' as const, enabled: true },
      ],
    };
    expect(projectAcpCommands(acp)).toEqual(['acp-mine runs: node agent.js']);
  });

  it('setupAcp: fake binary on PATH is detected and registered with icons; npx entries are never run; agentAdapters builds them', async () => {
    const home = await tmp('uncage-rt-home-');
    const bin = join(home, 'bin');
    await mkdir(bin);
    const log = join(home, 'npx.log');
    // `goose` is a binary agent in the bundled registry snapshot.
    await writeFile(join(bin, 'goose'), `#!/bin/sh\nexec "${process.execPath}" "${fakeAcpPath}" "$@"\n`);
    await writeFile(join(bin, 'npx'), `#!/bin/sh\necho "$*" >> "${log}"\nexit 1\n`);
    await chmod(join(bin, 'goose'), 0o755);
    await chmod(join(bin, 'npx'), 0o755);
    const acp = await setupAcp({ acp: DEFAULT_ACP_RUNTIMES, allowBypass: false, home, env: { PATH: bin } });
    expect(acp.adapters.map((a) => a.id)).toEqual(['acp-goose']);
    expect(acp.adapters[0]!.icon?.light).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(acp.catalog.find((c) => c.registryId === 'gemini')?.status).toBe('available');
    expect(acp.nativeIcons.claude?.light).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(acp.nativeIcons.codex?.light).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(await readFile(log, 'utf8').catch(() => '')).toBe('');

    const built = agentAdapters(false, acp.adapters, acp.nativeIcons)();
    expect(built.map((a) => a.id)).toEqual(['claude', 'codex', 'acp-goose']);
    expect(built[0]!.icon).toEqual(acp.nativeIcons.claude);
    expect(built[2]!.icon).toEqual(acp.adapters[0]!.icon);
    // The cache lives under the (temp) home.
    expect(JSON.parse(await readFile(join(home, '.uncage', 'acp', 'detect.json'), 'utf8'))).toBeTypeOf('object');
  });
});
