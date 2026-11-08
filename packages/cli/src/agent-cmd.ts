import { createAgent, createAgentLogger, loadAgentConfig, type AgentLogger } from '@uncage/agent';
import type { RuntimeAdapter } from '@uncage/protocol';
import { claudeAdapter } from '@uncage/runtime-claude';
import { codexAdapter } from '@uncage/runtime-codex';

export const AGENT_HELP = `uncage agent - run the Connected Mode agent in the foreground

Usage:
  uncage agent             Connect to every website in ~/.uncage/agent.yaml and serve them.
  uncage agent uninstall   Stop and remove the background agent (launchd). Config and data stay.

"uncage setup <url>" installs this as a background service; run it by hand for debugging
(stop the service first: uncage agent uninstall). Env: UNCAGE_LOG_LEVEL.`;

/** Fresh adapters per website (each website gets its own core instance). Bypass follows localPolicy. */
export const agentAdapters =
  (allowBypass: boolean) =>
  (): RuntimeAdapter[] => [claudeAdapter({ allowBypass }), codexAdapter({ allowBypass })];

export async function runAgent(o: { home: string; logger?: AgentLogger }): Promise<{ close(): Promise<void>; sites: number }> {
  const config = await loadAgentConfig(o.home);
  const logger = o.logger ?? createAgentLogger();
  const active = config.sites.filter((s) => !s.revokedAt);
  if (config.localPolicy.allowBypass) logger.warn({}, 'localPolicy.allowBypass is on: websites may use bypassPermissions');
  const agent = await createAgent({ config, adapters: agentAdapters(config.localPolicy.allowBypass), home: o.home, logger });
  return { close: () => agent.close(), sites: active.length };
}
