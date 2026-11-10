import { createAgent, createAgentLogger, DEFAULT_ACP_RUNTIMES, loadAgentConfig, resolveCommand, type AgentLogger, type ResolvedCommand } from '@uncage/agent';
import type { RuntimeAdapter } from '@uncage/protocol';
import { acpAdapter, refreshRegistryIfStale, type AcpAdapterOptions } from '@uncage/runtime-acp';
import { claudeAdapter } from '@uncage/runtime-claude';
import { codexAdapter } from '@uncage/runtime-codex';
import { acpCacheDir, setupAcp, withIcon, type NativeIcons } from './acp.js';

export const AGENT_HELP = `uncage agent - the Connected Mode agent

Usage:
  uncage agent [--log-file <path>]   Connect to every website in ~/.uncage/agent.yaml and serve them
                                     (foreground; --log-file appends the logs to a file instead of stderr).
  uncage agent install               Install and start the background agent for this user, pinned to the
                                     Node running this command (launchd on macOS, a systemd user service on
                                     Linux, a scheduled task on Windows) and the uncage:// link handler
                                     ("uncage connect"). Run it again after changing Node.
  uncage agent uninstall             Stop and remove the background agent and the uncage:// link handler.
                                     Config and data stay. Run it before "npm uninstall -g @uncage/cli",
                                     or uncage:// links keep pointing at the removed CLI.
  uncage agent status [--json]       Is it installed and running, and which Node does it use.

"uncage setup <url>" installs the background agent; run "uncage agent" by hand for debugging
(stop the service first: uncage agent uninstall). Env: UNCAGE_LOG_LEVEL,
UNCAGE_ACP_REGISTRY_REFRESH=0 (no daily ACP registry download).`;

/** The runtimes' executables, resolved without a shell (on Windows an npm `.cmd` shim → node + JS). */
export interface AgentExecutables {
  claude?: ResolvedCommand | null;
  codex?: ResolvedCommand | null;
}

/** Resolves `claude` and `codex` on PATH (`resolveCommand`). */
export async function resolveAgentExecutables(o: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}): Promise<AgentExecutables> {
  // A `.cmd` that cannot be started safely (no absolute cmd.exe) counts as not found: the default applies.
  const find = (name: string) => resolveCommand(name, [], o).catch(() => null);
  const [claude, codex] = await Promise.all([find('claude'), find('codex')]);
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

/**
 * Fresh adapters per website (each website gets its own core instance): Claude Code, Codex and
 * the ACP agents. Bypass follows localPolicy. `exes`: resolved claude / codex executables.
 */
export const agentAdapters =
  (allowBypass: boolean, acp: AcpAdapterOptions[] = [], exes: AgentExecutables = {}, icons: NativeIcons = {}) =>
  (): RuntimeAdapter[] => {
    const claude = claudeExecutable(exes.claude);
    const codex = codexExecutable(exes.codex);
    return [
      withIcon(claudeAdapter({ allowBypass, ...(claude ? { executable: claude } : {}) }), icons.claude),
      withIcon(codexAdapter({ allowBypass, ...(codex ? { executable: codex } : {}) }), icons.codex),
      ...acp.map((o) => acpAdapter({ ...o, allowBypass })),
    ];
  };

export interface RunAgentOptions {
  home: string;
  logger?: AgentLogger;
  /** Appends the logs to this file instead of stderr (`uncage agent --log-file`). */
  logFile?: string;
  /** Resolved claude / codex executables. Defaults to `resolveAgentExecutables()` on Windows. */
  exes?: AgentExecutables;
  /** For the daily ACP registry refresh (in the background); null disables it. Defaults to fetch. */
  fetch?: typeof fetch | null;
  /** PATH for ACP agent detection and UNCAGE_ACP_REGISTRY_REFRESH. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export async function runAgent(o: RunAgentOptions): Promise<{ close(): Promise<void>; sites: number }> {
  const config = await loadAgentConfig(o.home);
  const logger = o.logger ?? createAgentLogger(undefined, o.logFile);
  const env = o.env ?? process.env;
  const active = config.sites.filter((s) => !s.revokedAt);
  const { allowBypass } = config.localPolicy;
  if (allowBypass) logger.warn({}, 'localPolicy.allowBypass is on: websites may use bypassPermissions');
  if (o.fetch !== null && env.UNCAGE_ACP_REGISTRY_REFRESH !== '0') {
    // At most once a day; used from the next start on. Offline → the cached or bundled registry.
    void refreshRegistryIfStale({ cacheDir: acpCacheDir(o.home), fetch: o.fetch ?? fetch, timeoutMs: 10_000 }).then((r) => {
      if (r === 'refreshed') logger.info({}, 'ACP registry refreshed');
    });
  }
  const acp = await setupAcp({ acp: config.runtimes?.acp ?? DEFAULT_ACP_RUNTIMES, allowBypass, home: o.home, env });
  if (acp.adapters.length > 0) logger.info({ runtimes: acp.adapters.map((a) => a.id) }, 'ACP runtimes');
  // On POSIX the bare names work (execve searches PATH); Windows needs the resolved .exe / node + JS.
  const exes = o.exes ?? (process.platform === 'win32' ? await resolveAgentExecutables({ env }) : {});
  const agent = await createAgent({ config, adapters: agentAdapters(allowBypass, acp.adapters, exes, acp.nativeIcons), home: o.home, logger });
  return { close: () => agent.close(), sites: active.length };
}
