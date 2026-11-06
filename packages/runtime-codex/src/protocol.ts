/**
 * Codex App Server wire protocol (the subset Uncage uses).
 *
 * Transport: JSONL over the child's stdio. JSON-RPC 2.0 shapes, but the `"jsonrpc": "2.0"` field is
 * neither sent nor expected. Requests `{id, method, params}`, responses `{id, result}` / `{id, error}`,
 * notifications `{method, params}`. Request ids are strings or integers.
 *
 * Sources (read 2026-11-06; source only, nothing executed):
 *  [S] Official generated schema, openai/codex main:
 *      https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol/schema/typescript (+ /v2)
 *      https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/rpc.rs
 *        ("We do not do true JSON-RPC 2.0, as we neither send nor expect the "jsonrpc": "2.0" field.")
 *  [L] lezi-fun/codex-webui: https://github.com/lezi-fun/codex-webui
 *        public/codex-surfaces.js (approval decisions), public/app.js (notification handling),
 *        server.ts (`account/read {refreshToken}`)
 *  [R] seo-rii/codex-webui: https://github.com/seo-rii/codex-webui
 *        backend/src/runtime_request_support.rs (approval result `{"decision": "accept"}`),
 *        src/lib/chat-state.ts (`params.item`, `params.itemId`, `params.delta`)
 *
 * Everything below is confirmed by [S], and the approval envelope, the delta fields and the item
 * wrapper are additionally confirmed by both [L] and [R]. None of it has been checked against a
 * running `codex` binary: Uncage v0 is verified only against the fake in @uncage/testkit, which must
 * speak exactly these shapes.
 */

/** Uncage's defaults for new and resumed threads. Never 'never' / 'danger-full-access'. */
export const APPROVAL_POLICY = 'on-request';
export const SANDBOX = 'workspace-write';

// ---- Handshake ----------------------------------------------------------------------------------
/** [S] InitializeParams. `capabilities` is `Option<…>` and may be omitted. */
export interface InitializeParams {
  clientInfo: { name: string; title: string | null; version: string };
}
/** Sent as a notification right after the `initialize` response. */
export const INITIALIZED = 'initialized';

// ---- Account ------------------------------------------------------------------------------------
/** [S] GetAccountParams, [L] server.ts. */
export interface AccountReadParams {
  refreshToken: boolean;
}
/** [S] GetAccountResponse. `type` is 'apiKey' | 'chatgpt' | 'amazonBedrock' | 'gcp'. */
export interface AccountReadResult {
  account: null | { type: string };
  requiresOpenaiAuth: boolean;
}

// ---- Threads and turns --------------------------------------------------------------------------
/** [S] ThreadStartParams (subset). */
export interface ThreadStartParams {
  cwd: string;
  approvalPolicy: typeof APPROVAL_POLICY;
  sandbox: typeof SANDBOX;
}
/** [S] ThreadResumeParams (subset). The overrides re-apply Uncage's policy to a thread created elsewhere. */
export interface ThreadResumeParams extends Partial<ThreadStartParams> {
  threadId: string;
}
/** [S] ThreadStartResponse / ThreadResumeResponse (subset). */
export interface ThreadResult {
  thread: { id: string };
}

/** [S] UserInput text variant; `text_elements` is `#[serde(default)]` so it is omitted. */
export interface TextInput {
  type: 'text';
  text: string;
}
/** [S] TurnStartParams (subset). */
export interface TurnStartParams {
  threadId: string;
  input: TextInput[];
}
/** [S] TurnStatus. */
export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';
/** [S] TurnError (subset). `codexErrorInfo` is a string or an object variant. */
export interface TurnError {
  message: string;
  codexErrorInfo?: unknown;
}
/** [S] Turn (subset). */
export interface Turn {
  id: string;
  status: TurnStatus;
  error?: TurnError | null;
}
/** [S] TurnStartResponse. */
export interface TurnStartResult {
  turn: Turn;
}
/** [S] TurnInterruptParams. The response is `{}`. */
export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

// ---- Items --------------------------------------------------------------------------------------
/** [S] CommandExecutionStatus / PatchApplyStatus / McpToolCallStatus (mcp has no 'declined'). */
export type ItemStatus = 'inProgress' | 'completed' | 'failed' | 'declined';

/** [S] ThreadItem (subset; tagged by `type`, flat on the wire). Other item types are ignored. */
export type ThreadItem =
  | { type: 'agentMessage'; id: string; text: string }
  | {
      type: 'commandExecution';
      id: string;
      command: string;
      cwd: string;
      status: ItemStatus;
      aggregatedOutput: string | null;
      exitCode: number | null;
      durationMs: number | null;
    }
  | { type: 'fileChange'; id: string; changes: Array<{ path: string; kind: unknown; diff: string }>; status: ItemStatus }
  | {
      type: 'mcpToolCall';
      id: string;
      server: string;
      tool: string;
      status: ItemStatus;
      arguments: unknown;
      result: { content: unknown[] } | null;
      error: { message: string } | null;
      durationMs: number | null;
    }
  | { type: string; id: string };

// ---- Server → client notifications ------------------------------------------------------------
// Every notification Uncage routes carries `threadId`; it is the routing key.
export const NOTIFY = {
  /** [S] ItemStartedNotification `{item, threadId, turnId, startedAtMs}` ([L], [R] read `params.item`). */
  itemStarted: 'item/started',
  /** [S] ItemCompletedNotification `{item, threadId, turnId, completedAtMs}`. */
  itemCompleted: 'item/completed',
  /** [S] AgentMessageDeltaNotification `{threadId, turnId, itemId, delta}` ([L], [R] agree). */
  agentMessageDelta: 'item/agentMessage/delta',
  /** [S] CommandExecutionOutputDeltaNotification `{threadId, turnId, itemId, delta}`. */
  commandOutputDelta: 'item/commandExecution/outputDelta',
  /** [S] TurnCompletedNotification `{threadId, turn}`. */
  turnCompleted: 'turn/completed',
} as const;

export interface ItemNotification {
  threadId: string;
  turnId: string;
  item: ThreadItem;
}
export interface DeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}
export interface TurnCompletedNotification {
  threadId: string;
  turn: Turn;
}

// ---- Server → client requests (approvals) -------------------------------------------------------
export const REQUEST = {
  /** [S] CommandExecutionRequestApprovalParams (subset). */
  commandApproval: 'item/commandExecution/requestApproval',
  /** [S] FileChangeRequestApprovalParams (subset). */
  fileChangeApproval: 'item/fileChange/requestApproval',
} as const;

export interface CommandApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  command?: string | null;
  cwd?: string | null;
  reason?: string | null;
}
export interface FileChangeApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
}

/**
 * [S] CommandExecutionApprovalDecision / FileChangeApprovalDecision (subset; Uncage never sends
 * 'acceptForSession' or the policy-amendment variants). The JSON-RPC result is `{decision}`:
 * [S] *RequestApprovalResponse, [R] returns `{"decision": "accept"}`, [L] sends `decision: "accept" | "decline"`.
 */
export type ApprovalDecision = 'accept' | 'decline' | 'cancel';
export interface ApprovalResult {
  decision: ApprovalDecision;
}
