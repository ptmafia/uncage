import { createAgent, createAgentLogger, loadAgentConfig, resolveCommand, type AgentLogger, type ResolvedCommand } from '@uncage/agent';
import type { RuntimeAdapter } from '@uncage/protocol';
import { claudeAdapter } from '@uncage/runtime-claude';
import { codexAdapter } from '@uncage/runtime-codex';

export const AGENT_HELP = `uncage agent - the Connected Mode agent

Usage:
  uncage agent [--log-file <path>]   Connect to every website in ~/.uncage/agent.yaml and serve them
                                     (foreground; --log-file appends the logs to a file instead of stderr).
  uncage agent install               Install and start the background agent for this user, pinned to the
                                     Node running this command (launchd on macOS, a systemd user service on
                                     Linux, a scheduled task on Windows). Run it again after changing Node.
  uncage agent uninstall             Stop and remove the background agent. Config and data stay.
  uncage agent status [--json]       Is it installed and running, and which Node does it use.

"uncage setup <url>" installs the background agent; run "uncage agent" by hand for debugging
(stop the service first: uncage agent uninstall). Env: UNCAGE_LOG_LEVEL.`;

/** The runtimes' executables, resolved without a shell (on Windows an npm `.cmd` shim → node + JS). */
export interface AgentExecutables {
  claude?: ResolvedCommand | null;
  codex?: ResolvedCommand | null;
}

/** Resolves `claude` and `codex` on PATH (`resolveCommand`). */
export async function resolveAgentExecutables(o: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}): Promise<AgentExecutables> {
  const [claude, codex] = await Promise.all([resolveCommand('claude', [], o), resolveCommand('codex', [], o)]);
  return { claude, codex };
}

/**
 * Claude Code's `pathToClaudeCodeExecutable`: the exe itself, or the JS file of an npm JS shim (the
 * SDK runs a `.js` with node). A `cmd.exe` fallback cannot be passed as one path: left to the default.
 */
export function claudeExecutable(r: ResolvedCommand | null | undefined): string | undefined {
  if (!r) return undefined;
  if (r.via === 'direct') return r.file;
  if (r.via === 'node-shim') return r.args[0];
  return undefined;
}

/** The codex adapter's `executable` (a `cmd.exe` fallback cannot take `app-server` appended: left to the default). */
export function codexExecutable(r: ResolvedCommand | null | undefined): { file: string; args: string[] } | undefined {
  return r && r.via !== 'cmd' ? { file: r.file, args: r.args } : undefined;
}

/** Fresh adapters per website (each website gets its own core instance). Bypass follows localPolicy. */
export const agentAdapters =
  (allowBypass: boolean, exes: AgentExecutables = {}) =>
  (): RuntimeAdapter[] => {
    const claude = claudeExecutable(exes.claude);
    const codex = codexExecutable(exes.codex);
    return [claudeAdapter({ allowBypass, ...(claude ? { executable: claude } : {}) }), codexAdapter({ allowBypass, ...(codex ? { executable: codex } : {}) })];
  };

export async function runAgent(o: {
  home: string;
  logger?: AgentLogger;
  logFile?: string;
  exes?: AgentExecutables;
}): Promise<{ close(): Promise<void>; sites: number }> {
  const config = await loadAgentConfig(o.home);
  const logger = o.logger ?? createAgentLogger(undefined, o.logFile);
  const active = config.sites.filter((s) => !s.revokedAt);
  if (config.localPolicy.allowBypass) logger.warn({}, 'localPolicy.allowBypass is on: websites may use bypassPermissions');
  // On POSIX the bare names work (execve searches PATH); Windows needs the resolved .exe / node + JS.
  const exes = o.exes ?? (process.platform === 'win32' ? await resolveAgentExecutables() : {});
  const agent = await createAgent({ config, adapters: agentAdapters(config.localPolicy.allowBypass, exes), home: o.home, logger });
  return { close: () => agent.close(), sites: active.length };
}
