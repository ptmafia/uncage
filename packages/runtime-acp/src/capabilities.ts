import type { InitializeResponse } from '@agentclientprotocol/sdk';
import { ATTACHMENT_LIMITS, type ApprovalCategory, type PermissionMode, type RuntimeCapabilities } from '@uncage/protocol';

/** Every category: an ACP agent may ask permission for any kind of tool. */
const ALL_CATEGORIES: ApprovalCategory[] = ['shell', 'file', 'network', 'mcp', 'other'];

/** `bypassPermissions` is offered only when the local policy allows it. */
export const permissionModesFor = (allowBypass: boolean): PermissionMode[] =>
  allowBypass ? ['default', 'acceptEdits', 'bypassPermissions'] : ['default', 'acceptEdits'];

/**
 * Before the agent's `initialize` result is known. ACP has no scoped approvals Uncage can honour
 * (`allow_always` may persist outside the session), so `approval.session` is always false.
 */
export const DEFAULT_ACP_CAPABILITIES: RuntimeCapabilities = {
  streaming: true,
  approval: { once: true, session: false, types: ALL_CATEGORIES },
  nativeResume: false,
  diffEvents: false,
  // Every ACP agent must accept stdio MCP servers: site tools are injected through `mcpServers`.
  mcp: true,
  // ACP has no skills: they are given as text in the first prompt of each session.
  skills: 'prompt',
  siteTools: true,
  models: [{ id: 'default', label: 'Default' }],
  efforts: [],
  permissionModes: permissionModesFor(false),
  attachments: { images: false, files: true, maxBytes: ATTACHMENT_LIMITS.maxBytes },
};

/** Capabilities before `initialize`, for the adapter's options. */
export function defaultCapabilities(o: { allowBypass: boolean; mcp: 'auto' | 'http' | 'stdio' | 'off' }): RuntimeCapabilities {
  return {
    ...DEFAULT_ACP_CAPABILITIES,
    mcp: o.mcp !== 'off',
    siteTools: o.mcp !== 'off',
    permissionModes: permissionModesFor(o.allowBypass),
  };
}

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
    mcp: o.mcp !== 'off',
    siteTools: o.mcp !== 'off',
    permissionModes: permissionModesFor(o.allowBypass),
    attachments: { ...DEFAULT_ACP_CAPABILITIES.attachments, images: caps.promptCapabilities?.image === true },
  };
}
