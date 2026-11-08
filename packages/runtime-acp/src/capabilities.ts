import type { InitializeResponse } from '@agentclientprotocol/sdk';
import { ATTACHMENT_LIMITS, type ApprovalCategory, type RuntimeCapabilities } from '@uncage/protocol';

/** Every category: an ACP agent may ask permission for any kind of tool. */
const ALL_CATEGORIES: ApprovalCategory[] = ['shell', 'file', 'network', 'mcp', 'other'];

/**
 * Before the agent's `initialize` result is known. ACP has no scoped approvals Uncage can honour
 * (`allow_always` may persist outside the session), so `approval.session` is always false.
 */
export const DEFAULT_ACP_CAPABILITIES: RuntimeCapabilities = {
  streaming: true,
  approval: { once: true, session: false, types: ALL_CATEGORIES },
  nativeResume: false,
  diffEvents: false,
  mcp: false,
  skills: 'unknown',
  siteTools: false,
  models: [{ id: 'default', label: 'Default' }],
  efforts: [],
  permissionModes: ['default'],
  attachments: { images: false, files: true, maxBytes: ATTACHMENT_LIMITS.maxBytes },
};

/** Capabilities from the agent's `initialize` response. */
export function mapCapabilities(
  init: InitializeResponse,
  o: { allowBypass: boolean; mcp: 'auto' | 'http' | 'stdio' | 'off' },
): RuntimeCapabilities {
  const caps = init.agentCapabilities ?? {};
  return {
    ...DEFAULT_ACP_CAPABILITIES,
    approval: { ...DEFAULT_ACP_CAPABILITIES.approval, types: [...ALL_CATEGORIES] },
    nativeResume: caps.loadSession === true || Boolean(caps.sessionCapabilities?.resume),
    // Every ACP agent must accept stdio MCP servers.
    mcp: o.mcp !== 'off',
    permissionModes: o.allowBypass ? ['default', 'bypassPermissions'] : ['default'],
    attachments: { ...DEFAULT_ACP_CAPABILITIES.attachments, images: caps.promptCapabilities?.image === true },
  };
}
