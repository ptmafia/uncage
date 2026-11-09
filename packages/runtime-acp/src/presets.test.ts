import { fakeAcpPath } from '@uncage/testkit';
import { describe, expect, it } from 'vitest';
import { ACP_PRESETS, resolveAcpAgents, type AcpAgentsConfig } from './presets.js';
import { bundledRegistry } from './registry.js';

const none = async (): Promise<string | null> => null;

describe('ACP presets', () => {
  it('claude, gemini and opencode, with the commands the ACP registry documents', () => {
    expect(ACP_PRESETS.map((p) => [p.id, p.displayName, p.command, p.installHint])).toEqual([
      ['claude', 'Claude Code (ACP)', ['claude-agent-acp'], 'npm i -g @agentclientprotocol/claude-agent-acp'],
      ['gemini', 'Gemini CLI (ACP)', ['gemini', '--acp'], 'npm i -g @google/gemini-cli'],
      ['opencode', 'OpenCode (ACP)', ['opencode', 'acp'], 'npm i -g opencode-ai'],
    ]);
    for (const p of ACP_PRESETS) expect(p.installUrl).toMatch(/^https:\/\//);
  });

  it('only the Claude Code preset is verified live (connected-acp-live); the others are protocol-compatible', () => {
    expect(ACP_PRESETS.filter((p) => p.verifiedLive).map((p) => p.id)).toEqual(['claude']);
  });
});

describe('resolveAcpAgents', () => {
  it('resolveAcpAgents: explicit entries always, auto presets only when on PATH, entry fields override the preset', async () => {
    const r = await resolveAcpAgents(
      { presets: 'auto', agents: [{ id: 'mine', command: ['node', fakeAcpPath], mcp: 'auto', enabled: true }] },
      { allowBypass: false, which: async (c) => (c === 'gemini' ? '/usr/local/bin/gemini' : null) },
    );
    expect(r.map((a) => a.id)).toEqual(['acp-mine', 'acp-gemini']);
    expect(r[0]).toMatchObject({ displayName: 'mine', command: ['node', fakeAcpPath], mcp: 'auto', allowBypass: false });
    expect(r[1]).toMatchObject({ displayName: 'Gemini CLI (ACP)', command: ['gemini', '--acp'], installHint: 'npm i -g @google/gemini-cli' });

    const over = await resolveAcpAgents(
      {
        presets: 'auto',
        agents: [{ id: 'gemini', preset: 'gemini', displayName: 'My Gemini', command: ['/opt/gemini', '--acp'], env: { A: '1' }, mcp: 'stdio', enabled: true }],
      },
      { allowBypass: true, which: async () => '/usr/bin/x' },
    );
    // The listed preset is not added a second time; the other presets are on PATH.
    expect(over.map((a) => a.id)).toEqual(['acp-gemini', 'acp-claude', 'acp-opencode']);
    expect(over[0]).toMatchObject({ displayName: 'My Gemini', command: ['/opt/gemini', '--acp'], env: { A: '1' }, mcp: 'stdio', allowBypass: true });
    expect(over[0]!.installHint).toBe('npm i -g @google/gemini-cli');
  });

  it('presets off, disabled entries, the disable list and a preset entry without a command', async () => {
    const cfg: AcpAgentsConfig = {
      presets: 'off',
      agents: [
        { id: 'off', command: ['x'], mcp: 'auto', enabled: false },
        { id: 'claude', preset: 'claude', mcp: 'auto', enabled: true },
        { id: 'gone', command: ['y'], mcp: 'auto', enabled: true },
      ],
      disable: ['acp-gone'],
    };
    const r = await resolveAcpAgents(cfg, { allowBypass: false, which: async () => '/bin/x' });
    expect(r.map((a) => [a.id, a.command])).toEqual([['acp-claude', ['claude-agent-acp']]]);
    expect(await resolveAcpAgents({ presets: 'auto', agents: [], disable: ['gemini'] }, { allowBypass: false, which: async (c) => (c === 'gemini' ? '/g' : null) })).toEqual([]);
    expect(await resolveAcpAgents({ presets: 'auto', agents: [] }, { allowBypass: false, which: none })).toEqual([]);
  });

  it('takes official icons from the registry for presets and matching entries', async () => {
    const registry = bundledRegistry();
    const r = await resolveAcpAgents({ presets: 'auto', agents: [] }, { allowBypass: false, which: async (c) => (c === 'gemini' ? '/g' : null), registry });
    expect(r[0]!.icon?.light).toMatch(/^data:image\/svg\+xml;base64,/);
  });
});
