import { createAgent, createAgentLogger, DEFAULT_ACP_RUNTIMES, loadAgentConfig, type AgentLogger } from '@uncage/agent';
import type { RuntimeAdapter } from '@uncage/protocol';
import { acpAdapter, refreshRegistryIfStale, type AcpAdapterOptions } from '@uncage/runtime-acp';
import { claudeAdapter } from '@uncage/runtime-claude';
import { codexAdapter } from '@uncage/runtime-codex';
import { acpCacheDir, setupAcp, withIcon, type NativeIcons } from './acp.js';

export const AGENT_HELP = `uncage agent - run the Connected Mode agent in the foreground

Usage:
  uncage agent             Connect to every website in ~/.uncage/agent.yaml and serve them.
  uncage agent uninstall   Stop and remove the background agent (launchd). Config and data stay.

"uncage setup <url>" installs this as a background service; run it by hand for debugging
(stop the service first: uncage agent uninstall). Env: UNCAGE_LOG_LEVEL,
UNCAGE_ACP_REGISTRY_REFRESH=0 (no daily ACP registry download).`;

/**
 * Fresh adapters per website (each website gets its own core instance): Claude Code, Codex and
 * the ACP agents. Bypass follows localPolicy.
 */
export const agentAdapters =
  (allowBypass: boolean, acp: AcpAdapterOptions[] = [], icons: NativeIcons = {}) =>
  (): RuntimeAdapter[] => [
    withIcon(claudeAdapter({ allowBypass }), icons.claude),
    withIcon(codexAdapter({ allowBypass }), icons.codex),
    ...acp.map((o) => acpAdapter({ ...o, allowBypass })),
  ];

export interface RunAgentOptions {
  home: string;
  logger?: AgentLogger;
  /** For the daily ACP registry refresh (in the background); null disables it. Defaults to fetch. */
  fetch?: typeof fetch | null;
  /** PATH for ACP agent detection and UNCAGE_ACP_REGISTRY_REFRESH. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export async function runAgent(o: RunAgentOptions): Promise<{ close(): Promise<void>; sites: number }> {
  const config = await loadAgentConfig(o.home);
  const logger = o.logger ?? createAgentLogger();
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
  const agent = await createAgent({ config, adapters: agentAdapters(allowBypass, acp.adapters, acp.nativeIcons), home: o.home, logger });
  return { close: () => agent.close(), sites: active.length };
}
