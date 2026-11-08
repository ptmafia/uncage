import type { PermissionOption, RequestPermissionRequest, RequestPermissionResponse, ToolKind } from '@agentclientprotocol/sdk';
import type { ApprovalOutcome, NativeApprovalInput, PermissionMode } from '@uncage/protocol';
import { approvalInput, type KnownTool } from './map.js';
import { SITE_MCP_SERVER } from './site-mcp.js';

/** Kinds `acceptEdits` allows without asking. */
const EDIT_KINDS: ReadonlySet<ToolKind> = new Set(['edit', 'delete', 'move']);

export const NO_ALLOW_ONCE_WARNING = 'acp_no_allow_once';

export interface PermissionPolicy {
  /** The session's (website-chosen) permission mode. */
  mode: PermissionMode;
  /** Local policy: this machine allows `bypassPermissions`. */
  allowBypass: boolean;
  /** Names of the run's site tools (served by the `site` MCP server). */
  siteToolNames: ReadonlySet<string>;
  /** For the approval card's target. */
  cwd?: string;
  /** What the mapper already knows about the tool call. */
  known?: KnownTool;
}

export type PermissionDecision = { auto: 'allow' } | { ask: NativeApprovalInput } | { auto: 'cancel'; warning: string };

const SITE_PREFIX = `mcp__${SITE_MCP_SERVER}__`;
/** Kinds a site tool call never has: a request of these kinds always gets a card. */
const NATIVE_KINDS: ReadonlySet<ToolKind> = new Set(['execute', 'edit', 'delete', 'move', 'fetch']);

/**
 * A request for one of the run's site tools (confirmed by the `site` MCP handler, not here): the
 * name or title is exactly `mcp__site__<n>`, or the `name` (never the title) is a bare `<n>` with
 * kind unset or `other`. Never for execute / edit / delete / move / fetch requests, so a native tool
 * that happens to share a site tool's name still asks.
 */
function isSiteToolRequest(call: RequestPermissionRequest['toolCall'], o: PermissionPolicy): boolean {
  const kind = call.kind ?? o.known?.kind;
  if (kind && NATIVE_KINDS.has(kind)) return false;
  const prefixed = (n: string | null | undefined): boolean =>
    typeof n === 'string' && n.startsWith(SITE_PREFIX) && o.siteToolNames.has(n.slice(SITE_PREFIX.length));
  const name = (call as { name?: string | null }).name;
  if ([name, call.title, o.known?.title].some(prefixed)) return true;
  return typeof name === 'string' && o.siteToolNames.has(name) && (!kind || kind === 'other');
}

/**
 * What to do with a `session/request_permission`. Uncage never selects `allow_always`, so a
 * request without an `allow_once` option is answered `cancelled`. Site tools are allowed here:
 * the `site` MCP handler asks for confirmation itself. `bypassPermissions` allows everything only
 * when the local policy allows bypass; `acceptEdits` allows edit / delete / move; everything else asks.
 */
export function permissionDecision(req: RequestPermissionRequest, o: PermissionPolicy): PermissionDecision {
  if (!req.options.some((x) => x.kind === 'allow_once')) {
    return { auto: 'cancel', warning: 'The agent asked for a permission without an "allow once" choice; Uncage declined it.' };
  }
  const call = req.toolCall;
  if (isSiteToolRequest(call, o)) return { auto: 'allow' };
  if (o.mode === 'bypassPermissions' && o.allowBypass) return { auto: 'allow' };
  const kind = call.kind ?? o.known?.kind;
  if (o.mode === 'acceptEdits' && kind && EDIT_KINDS.has(kind)) return { auto: 'allow' };
  return { ask: approvalInput(call, o.known, o.cwd ?? '') };
}

/**
 * The permission answer: allow → the `allow_once` option, deny → `reject_once`, expired or
 * cancelled → `cancelled`. `allow_always` / `reject_always` are never selected (the agent may
 * persist them outside the session); without the matching "once" option the answer is `cancelled`.
 */
export function toPermissionResponse(outcome: ApprovalOutcome | 'allow', options: PermissionOption[]): RequestPermissionResponse {
  const decision = outcome === 'allow' ? 'allow' : outcome.decision;
  const kind = decision === 'allow' ? 'allow_once' : decision === 'deny' ? 'reject_once' : undefined;
  const option = kind && options.find((x) => x.kind === kind);
  return { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } };
}
