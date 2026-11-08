import type { AcpAdapterOptions } from './adapter.js';
import { registryIcon, type AcpRegistry } from './registry.js';

export interface AcpPreset {
  id: 'claude' | 'gemini' | 'opencode';
  displayName: string;
  command: string[];
  installHint: string;
  installUrl: string;
  /** Run end to end against the real agent (A4); otherwise protocol-compatible but unverified. */
  verifiedLive: boolean;
  /** The agent's entry in the official ACP registry (icon, version). */
  registryId: string;
}

/**
 * Well-known ACP agents. Commands match the ACP registry's distributions (`gemini --acp`,
 * `opencode acp`, the `claude-agent-acp` bin of `@agentclientprotocol/claude-agent-acp`).
 */
export const ACP_PRESETS: readonly AcpPreset[] = [
  {
    id: 'claude',
    displayName: 'Claude Code (ACP)',
    command: ['claude-agent-acp'],
    installHint: 'npm i -g @agentclientprotocol/claude-agent-acp',
    installUrl: 'https://github.com/agentclientprotocol/claude-agent-acp',
    verifiedLive: false,
    registryId: 'claude-acp',
  },
  {
    id: 'gemini',
    displayName: 'Gemini CLI (ACP)',
    command: ['gemini', '--acp'],
    installHint: 'npm i -g @google/gemini-cli',
    installUrl: 'https://github.com/google-gemini/gemini-cli',
    verifiedLive: false,
    registryId: 'gemini',
  },
  {
    id: 'opencode',
    displayName: 'OpenCode (ACP)',
    command: ['opencode', 'acp'],
    installHint: 'npm i -g opencode-ai',
    installUrl: 'https://opencode.ai',
    verifiedLive: false,
    registryId: 'opencode',
  },
];

export interface AcpAgentEntry {
  id: string;
  preset?: AcpPreset['id'];
  displayName?: string;
  command?: string[];
  env?: Record<string, string>;
  mcp: 'auto' | 'http' | 'stdio' | 'off';
  enabled: boolean;
}

/** Structural copy of `AcpRuntimesConfig` (runtime-acp does not depend on @uncage/agent). */
export interface AcpAgentsConfig {
  presets: 'auto' | 'off';
  agents: AcpAgentEntry[];
  /** Detect agents from the ACP registry (default true). */
  autoDetect?: boolean;
  /** Registry ids the user consented to run although they are not detected (e.g. npx/uvx). */
  enable?: string[];
  /** Per registry id, exactly what `enable` consented to run (runner, package or command, args, env). */
  consented?: Record<string, { runner: 'local' | 'npx' | 'uvx'; package?: string; cmd?: string; args: string[]; env: Record<string, string> }>;
  /** Registry, preset or runtime ids never registered. */
  disable?: string[];
}

/** `acp-gemini`, `gemini` → `gemini`. */
export const acpName = (id: string): string => id.replace(/^acp-/, '');

/** Whether `name` (a registry id, preset id or runtime id suffix) is on the disable list. */
export function isDisabled(cfg: Pick<AcpAgentsConfig, 'disable'>, ...names: string[]): boolean {
  const off = new Set((cfg.disable ?? []).map(acpName));
  return names.some((n) => off.has(acpName(n)));
}

/** The registry icon for a preset or an entry whose id names a registry agent. */
function iconFor(registry: AcpRegistry | undefined, ...ids: string[]): Pick<AcpAdapterOptions, 'icon'> {
  for (const id of ids) {
    const agent = registry?.agents.find((a) => a.id === id);
    const icon = agent ? registryIcon(agent) : undefined;
    if (icon) return { icon };
  }
  return {};
}

/**
 * Explicit entries always (the enabled ones; preset fields filled in, entry fields win; id →
 * `acp-<id>`); with `presets: 'auto'`, each preset not already listed whose `command[0]` resolves
 * on PATH. Entries and presets on the disable list are left out.
 */
export async function resolveAcpAgents(
  cfg: AcpAgentsConfig,
  o: { allowBypass: boolean; which(cmd: string): Promise<string | null>; registry?: AcpRegistry },
): Promise<AcpAdapterOptions[]> {
  const out: AcpAdapterOptions[] = [];
  for (const e of cfg.agents) {
    if (!e.enabled || isDisabled(cfg, e.id)) continue;
    const preset = ACP_PRESETS.find((p) => p.id === e.preset);
    const command = e.command ?? preset?.command;
    if (!command || command.length === 0) continue;
    out.push({
      id: `acp-${e.id}`,
      displayName: e.displayName ?? preset?.displayName ?? e.id,
      command: [...command],
      ...(e.env ? { env: { ...e.env } } : {}),
      mcp: e.mcp,
      allowBypass: o.allowBypass,
      ...(preset ? { installHint: preset.installHint, installUrl: preset.installUrl } : {}),
      ...iconFor(o.registry, ...(preset ? [preset.registryId] : []), e.id),
    });
  }
  if (cfg.presets === 'auto') {
    const listed = new Set(cfg.agents.map((e) => e.id));
    for (const p of ACP_PRESETS) {
      if (listed.has(p.id) || isDisabled(cfg, p.id, p.registryId)) continue;
      if (!(await o.which(p.command[0]!))) continue;
      out.push({
        id: `acp-${p.id}`,
        displayName: p.displayName,
        command: [...p.command],
        mcp: 'auto',
        allowBypass: o.allowBypass,
        installHint: p.installHint,
        installUrl: p.installUrl,
        ...iconFor(o.registry, p.registryId),
      });
    }
  }
  return out;
}
