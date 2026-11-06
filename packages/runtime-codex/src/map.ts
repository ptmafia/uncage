import {
  ERROR_CATALOG,
  type ApprovalCategory,
  type ApprovalOutcome,
  type ErrorCode,
  type NativeApprovalInput,
  type RuntimeEvent,
} from '@uncage/protocol';
import {
  NOTIFY,
  REQUEST,
  type ApprovalDecision,
  type CommandApprovalParams,
  type DeltaNotification,
  type FileChangeApprovalParams,
  type ItemNotification,
  type ThreadItem,
  type TurnCompletedNotification,
} from './protocol.js';

export const DECLINED_MESSAGE = 'The user declined this action.';

/** allow → accept, deny/expired → decline, cancelled → cancel. */
export function toDecision(outcome: ApprovalOutcome): ApprovalDecision {
  switch (outcome.decision) {
    case 'allow':
      return 'accept';
    case 'deny':
    case 'expired':
      return 'decline';
    case 'cancelled':
      return 'cancel';
  }
}

type Item<T extends string> = Extract<ThreadItem, { type: T }>;
type Tool = { name: string; title: string; category: ApprovalCategory; input?: unknown };

const nonEmpty = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

function describeTool(item: ThreadItem): Tool | undefined {
  switch (item.type) {
    case 'commandExecution': {
      const i = item as Item<'commandExecution'>;
      return {
        name: 'commandExecution',
        title: i.command.slice(0, 80) || 'Run command',
        category: 'shell',
        input: { command: i.command, cwd: i.cwd },
      };
    }
    case 'fileChange': {
      const i = item as Item<'fileChange'>;
      const paths = (i.changes ?? []).map((c) => c.path);
      return { name: 'fileChange', title: paths[0] ?? 'Edit files', category: 'file', input: { paths } };
    }
    case 'mcpToolCall': {
      const i = item as Item<'mcpToolCall'>;
      return { name: `${i.server}/${i.tool}`, title: `${i.server}: ${i.tool}`, category: 'mcp', input: i.arguments };
    }
    default:
      return undefined;
  }
}

function mcpOutput(i: Item<'mcpToolCall'>): string | undefined {
  const content = i.result?.content ?? [];
  const text = content
    .flatMap((b) => {
      const block = b as { type?: unknown; text?: unknown };
      return block.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
    })
    .join('\n');
  return nonEmpty(text);
}

function toolFinished(item: ThreadItem): RuntimeEvent | undefined {
  const status = (item as { status?: unknown }).status;
  const toolId = item.id;
  if (status === 'declined') return { type: 'tool.failed', toolId, error: DECLINED_MESSAGE, declined: true };
  if (item.type === 'commandExecution') {
    const i = item as Item<'commandExecution'>;
    const output = nonEmpty(i.aggregatedOutput);
    if (status === 'failed') {
      return { type: 'tool.failed', toolId, error: output ?? `Command failed (exit code ${i.exitCode ?? 'unknown'}).` };
    }
    return {
      type: 'tool.completed',
      toolId,
      ...(output !== undefined ? { output } : {}),
      ...(i.durationMs != null ? { durationMs: i.durationMs } : {}),
    };
  }
  if (item.type === 'mcpToolCall') {
    const i = item as Item<'mcpToolCall'>;
    if (status === 'failed') return { type: 'tool.failed', toolId, error: i.error?.message ?? 'MCP tool call failed.' };
    const output = mcpOutput(i);
    return {
      type: 'tool.completed',
      toolId,
      ...(output !== undefined ? { output } : {}),
      ...(i.durationMs != null ? { durationMs: i.durationMs } : {}),
    };
  }
  if (status === 'failed') return { type: 'tool.failed', toolId, error: 'Applying the file change failed.' };
  return { type: 'tool.completed', toolId };
}

function runFailed(code: ErrorCode, message: string | undefined): RuntimeEvent {
  const entry = ERROR_CATALOG[code];
  return {
    type: 'run.failed',
    error: {
      code,
      message: message || entry.message,
      hint: code === 'auth_required' ? 'Run `codex login`' : entry.hint,
      retryable: entry.retryable,
    },
  };
}

export interface CodexMapper {
  /** Maps one routed server notification to runtime events. */
  notification(method: string, params: unknown): RuntimeEvent[];
  /** Builds the approval request for a server → client approval request; undefined for unknown methods. */
  approval(method: string, params: unknown): NativeApprovalInput | undefined;
  /** Completes any message still open (e.g. before a terminal event the adapter makes up). */
  flush(): RuntimeEvent[];
}

/** Stateful notification → RuntimeEvent mapper for one run. */
export function createMapper(): CodexMapper {
  const messages = new Map<string, { text: string; started: boolean }>();
  const tools = new Map<string, Tool>();
  const toolStarted = new Set<string>();

  const completeMessage = (id: string, finalText?: string): RuntimeEvent[] => {
    const m = messages.get(id);
    messages.delete(id);
    const out: RuntimeEvent[] = [];
    let text = m?.text ?? '';
    // The completed item is authoritative: stream whatever the deltas missed.
    if (finalText !== undefined && finalText.length > text.length && finalText.startsWith(text)) {
      const rest = finalText.slice(text.length);
      if (!m?.started) out.push({ type: 'message.started', messageId: id });
      out.push({ type: 'message.delta', messageId: id, text: rest });
      text = finalText;
      return [...out, { type: 'message.completed', messageId: id, text }];
    }
    return m?.started ? [{ type: 'message.completed', messageId: id, text }] : [];
  };

  const flush = (): RuntimeEvent[] => [...messages.keys()].flatMap((id) => completeMessage(id));

  const startTool = (item: ThreadItem): RuntimeEvent[] => {
    const tool = describeTool(item);
    if (!tool || toolStarted.has(item.id)) return [];
    tools.set(item.id, tool);
    toolStarted.add(item.id);
    return [{ type: 'tool.started', toolId: item.id, ...tool }];
  };

  const notification = (method: string, params: unknown): RuntimeEvent[] => {
    switch (method) {
      case NOTIFY.itemStarted: {
        const { item } = params as ItemNotification;
        if (item.type === 'agentMessage') {
          // Codex streams one message at a time; a new one means the previous never completed.
          const flushed = flush();
          messages.set(item.id, { text: '', started: false });
          return flushed;
        }
        return startTool(item);
      }
      case NOTIFY.agentMessageDelta: {
        const { itemId, delta } = params as DeltaNotification;
        if (typeof delta !== 'string' || delta === '') return [];
        let m = messages.get(itemId);
        const out: RuntimeEvent[] = [];
        if (!m) {
          out.push(...flush());
          m = { text: '', started: false };
          messages.set(itemId, m);
        }
        // message.started waits for the first text so empty messages emit nothing.
        if (!m.started) out.push({ type: 'message.started', messageId: itemId });
        m.started = true;
        m.text += delta;
        return [...out, { type: 'message.delta', messageId: itemId, text: delta }];
      }
      case NOTIFY.commandOutputDelta: {
        const { itemId, delta } = params as DeltaNotification;
        return typeof delta === 'string' && delta !== '' ? [{ type: 'tool.updated', toolId: itemId, output: delta }] : [];
      }
      case NOTIFY.itemCompleted: {
        const { item } = params as ItemNotification;
        if (item.type === 'agentMessage') return completeMessage(item.id, (item as Item<'agentMessage'>).text);
        if (!describeTool(item)) return [];
        const finished = toolFinished(item);
        return [...startTool(item), ...(finished ? [finished] : [])];
      }
      case NOTIFY.turnCompleted: {
        const { turn } = params as TurnCompletedNotification;
        const out = flush();
        if (turn.status === 'completed') return [...out, { type: 'run.completed' }];
        if (turn.status === 'interrupted') {
          return [...out, { type: 'run.interrupted', reason: turn.error?.message || 'interrupted' }];
        }
        const code: ErrorCode = turn.error?.codexErrorInfo === 'unauthorized' ? 'auth_required' : 'internal_error';
        return [...out, runFailed(code, turn.error?.message)];
      }
      default:
        return [];
    }
  };

  const approval = (method: string, params: unknown): NativeApprovalInput | undefined => {
    if (method === REQUEST.commandApproval) {
      const p = params as CommandApprovalParams;
      const command = nonEmpty(p.command);
      const cwd = nonEmpty(p.cwd);
      const reason = nonEmpty(p.reason);
      return {
        toolId: p.itemId,
        category: 'shell',
        title: command?.slice(0, 80) ?? tools.get(p.itemId)?.title ?? 'Run command',
        ...(reason ? { description: reason } : {}),
        target: { ...(command ? { command } : {}), ...(cwd ? { cwd } : {}) },
      };
    }
    if (method === REQUEST.fileChangeApproval) {
      const p = params as FileChangeApprovalParams;
      const tool = tools.get(p.itemId);
      const path = (tool?.input as { paths?: string[] } | undefined)?.paths?.[0];
      const reason = nonEmpty(p.reason);
      return {
        toolId: p.itemId,
        category: 'file',
        title: path ?? 'Edit files',
        ...(reason ? { description: reason } : {}),
        target: path ? { path } : {},
      };
    }
    return undefined;
  };

  return { notification, approval, flush };
}
