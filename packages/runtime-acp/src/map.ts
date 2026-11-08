import type {
  ContentBlock,
  PermissionOption,
  PlanEntry,
  RequestPermissionOutcome,
  SessionUpdate,
  StopReason,
  ToolCallContent,
  ToolCallUpdate,
  ToolKind,
} from '@agentclientprotocol/sdk';
import type { ApprovalCategory, ApprovalOutcome, ApprovalTarget, NativeApprovalInput, RuntimeEvent } from '@uncage/protocol';

/** execute → shell, read|edit|delete|move|search → file, fetch → network, else other. */
export function toolCategory(kind: ToolKind | null | undefined): ApprovalCategory {
  switch (kind) {
    case 'execute':
      return 'shell';
    case 'read':
    case 'edit':
    case 'delete':
    case 'move':
    case 'search':
      return 'file';
    case 'fetch':
      return 'network';
    default:
      return 'other';
  }
}

/** What the mapper remembers about a tool call (approvals use it when the request omits fields). */
export interface KnownTool {
  title: string;
  kind?: ToolKind | null;
  input?: unknown;
}

export interface AcpMapper {
  update(u: SessionUpdate): RuntimeEvent[];
  /** Closes the open message and plan step, then maps the stop reason to the terminal event(s). */
  finish(stop: StopReason): RuntimeEvent[];
  /** Closes the open message and plan step (e.g. before a disconnect). */
  flush(): RuntimeEvent[];
  /** The user declined this tool: its failure is reported as `declined`. */
  markDeclined(toolCallId: string): void;
  tool(toolCallId: string): KnownTool | undefined;
  /** Starts a tool first seen in a permission request. */
  ensureTool(call: ToolCallUpdate): RuntimeEvent[];
}

const STOP_WARNINGS: Partial<Record<StopReason, string>> = {
  max_tokens: 'The agent stopped because it reached its token limit.',
  max_turn_requests: 'The agent stopped because it reached its limit of model requests for one turn.',
  refusal: 'The agent refused to continue.',
};

function blockText(b: ContentBlock): string | undefined {
  if (b.type === 'text') return b.text;
  if (b.type === 'resource_link') return b.uri;
  if (b.type === 'resource') return 'text' in b.resource ? b.resource.text : b.resource.uri;
  return undefined;
}

const lines = (s: string): string[] => {
  const out = s.split('\n');
  if (out.at(-1) === '') out.pop();
  return out;
};

/** Text of the content blocks; diffs as the path and a -/+ summary; terminals are ignored. */
export function toolOutput(content: ToolCallContent[] | null | undefined): string | undefined {
  if (!content) return undefined;
  const parts = content.flatMap((c): string[] => {
    if (c.type === 'content') {
      const t = blockText(c.content);
      return t === undefined ? [] : [t];
    }
    if (c.type === 'diff') {
      const removed = c.oldText ? lines(c.oldText).map((l) => `-${l}`) : [];
      const added = lines(c.newText).map((l) => `+${l}`);
      return [[c.path, ...removed, ...added].join('\n')];
    }
    return [];
  });
  return parts.length ? parts.join('\n') : undefined;
}

const checklist = (entries: PlanEntry[]): string => entries.map((e) => `- [${e.status === 'completed' ? 'x' : ' '}] ${e.content}`).join('\n');

interface ToolState extends KnownTool {
  done: boolean;
  output?: string;
}

/**
 * ACP `session/update` → Uncage runtime events, for one turn. Thoughts, user chunks, usage, commands,
 * notices, compaction and mode/config updates are dropped; a `plan` is one synthetic `plan` step,
 * open while plan updates follow each other and closed by the next message, tool call or the end of
 * the turn (a later plan opens a new step).
 */
export function createAcpMapper(newId: () => string): AcpMapper {
  let message: { id: string; native?: string; text: string } | undefined;
  const usedMessageIds = new Set<string>();
  const tools = new Map<string, ToolState>();
  const declined = new Set<string>();
  let plan: { id: string; open: boolean; output: string } | undefined;

  const closeMessage = (): RuntimeEvent[] => {
    if (!message) return [];
    const done: RuntimeEvent = { type: 'message.completed', messageId: message.id, text: message.text };
    message = undefined;
    return [done];
  };

  const closePlan = (): RuntimeEvent[] => {
    if (!plan?.open) return [];
    plan.open = false;
    return [{ type: 'tool.completed', toolId: plan.id, output: plan.output }];
  };

  const close = (): RuntimeEvent[] => [...closeMessage(), ...closePlan()];

  function startTool(u: ToolCallUpdate): RuntimeEvent[] {
    const state: ToolState = { title: u.title ?? 'Tool', kind: u.kind, input: u.rawInput, done: false };
    tools.set(u.toolCallId, state);
    return [
      {
        type: 'tool.started',
        toolId: u.toolCallId,
        name: u.name ?? u.kind ?? 'tool',
        title: state.title,
        category: toolCategory(u.kind),
        ...(u.rawInput !== undefined ? { input: u.rawInput } : {}),
      },
    ];
  }

  function updateTool(u: ToolCallUpdate): RuntimeEvent[] {
    const state = tools.get(u.toolCallId);
    if (!state || state.done) return [];
    if (u.title) state.title = u.title;
    if (u.kind) state.kind = u.kind;
    if (u.rawInput !== undefined) state.input = u.rawInput;
    const output = toolOutput(u.content);
    if (output !== undefined) state.output = output;
    if (u.status === 'completed') {
      state.done = true;
      return [{ type: 'tool.completed', toolId: u.toolCallId, ...(state.output !== undefined ? { output: state.output } : {}) }];
    }
    if (u.status === 'failed') {
      state.done = true;
      const isDeclined = declined.has(u.toolCallId);
      return [
        {
          type: 'tool.failed',
          toolId: u.toolCallId,
          error: state.output ?? (isDeclined ? 'Declined' : 'Tool failed'),
          ...(isDeclined ? { declined: true } : {}),
        },
      ];
    }
    return output !== undefined ? [{ type: 'tool.updated', toolId: u.toolCallId, output }] : [];
  }

  /** A tool call or update: starts the tool when unknown, then applies the rest as an update. */
  function toolEvent(u: ToolCallUpdate): RuntimeEvent[] {
    const events = close();
    if (!tools.has(u.toolCallId)) events.push(...startTool(u));
    events.push(...updateTool(u));
    return events;
  }

  return {
    update(u) {
      switch (u.sessionUpdate) {
        case 'agent_message_chunk': {
          if (u.content.type !== 'text') return [];
          const events = closePlan();
          const native = u.messageId ?? undefined;
          if (message && native !== undefined && message.native !== native) events.push(...closeMessage());
          if (!message) {
            const id = native !== undefined && !usedMessageIds.has(native) ? native : newId();
            usedMessageIds.add(id);
            message = { id, native, text: '' };
            events.push({ type: 'message.started', messageId: id });
          }
          message.text += u.content.text;
          events.push({ type: 'message.delta', messageId: message.id, text: u.content.text });
          return events;
        }
        case 'tool_call':
        case 'tool_call_update':
          return toolEvent(u);
        case 'plan': {
          const output = checklist(u.entries);
          if (!plan?.open) {
            // A plan revised after its step closed starts a new step: a step never completes twice.
            plan = { id: `plan_${newId()}`, open: true, output };
            return [...closeMessage(), { type: 'tool.started', toolId: plan.id, name: 'plan', title: 'Plan', category: 'other' }];
          }
          plan.output = output;
          return [...closeMessage(), { type: 'tool.updated', toolId: plan.id, output }];
        }
        default:
          return [];
      }
    },
    finish(stop) {
      const events = close();
      if (stop === 'cancelled') return [...events, { type: 'run.interrupted', reason: 'aborted' }];
      const warning = STOP_WARNINGS[stop];
      if (warning) events.push({ type: 'warning', code: `acp_${stop}`, message: warning });
      return [...events, { type: 'run.completed' }];
    },
    flush: close,
    markDeclined(id) {
      declined.add(id);
    },
    tool(id) {
      const t = tools.get(id);
      return t && { title: t.title, kind: t.kind, input: t.input };
    },
    ensureTool(call) {
      if (tools.has(call.toolCallId)) return [];
      return [...close(), ...startTool(call)];
    },
  };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

function targetOf(category: ApprovalCategory, call: ToolCallUpdate, input: unknown, cwd: string): ApprovalTarget {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const target: ApprovalTarget = {};
  const command = Array.isArray(raw.command) ? raw.command.filter((x) => typeof x === 'string').join(' ') : str(raw.command);
  if (command) {
    target.command = command;
    target.cwd = str(raw.cwd) ?? cwd;
  }
  const path = call.locations?.[0]?.path ?? str(raw.path) ?? str(raw.file_path) ?? str(raw.filePath);
  if (path && category !== 'shell') target.path = path;
  const url = str(raw.url);
  if (url) {
    try {
      target.host = new URL(url).host;
    } catch {
      // Not a URL: no host.
    }
  }
  return target;
}

/** The approval card for a `session/request_permission` tool call (allow once / deny only). */
export function approvalInput(call: ToolCallUpdate, known: KnownTool | undefined, cwd: string): NativeApprovalInput {
  const kind = call.kind ?? known?.kind;
  const category = toolCategory(kind);
  const input = call.rawInput !== undefined ? call.rawInput : known?.input;
  return {
    toolId: call.toolCallId,
    category,
    title: call.title ?? known?.title ?? 'Tool',
    availableDecisions: ['allow_once', 'deny'],
    target: targetOf(category, call, input, cwd),
  };
}

/**
 * The permission answer for an approval outcome. `allow_always` / `reject_always` are never
 * selected: the agent may persist them outside the session. Without a matching "once" option the
 * request is answered `cancelled`.
 */
export function chooseOption(options: PermissionOption[], outcome: ApprovalOutcome): RequestPermissionOutcome {
  if (outcome.decision === 'cancelled') return { outcome: 'cancelled' };
  const kind = outcome.decision === 'allow' ? 'allow_once' : 'reject_once';
  const option = options.find((o) => o.kind === kind);
  return option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' };
}
