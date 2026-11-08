import {
  newId,
  type AdapterRunContext,
  type AdapterRunInput,
  type ApprovalCategory,
  type ApprovalOutcome,
  type ErrorBody,
  type NativeApprovalInput,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type RuntimeProbe,
  type ToolCallResult,
} from '@uncage/protocol';
import { ATTACHMENT_LIMITS } from '@uncage/protocol';

export type FakeStep =
  | { text: string; chunks?: number; delayMs?: number }
  | {
      tool: {
        name: string;
        title: string;
        category?: ApprovalCategory;
        output?: string;
        fail?: string;
        durationMs?: number;
      };
    }
  | { approval: NativeApprovalInput; onDeny?: 'continue' | 'fail' }
  | { waitMs: number }
  /**
   * Calls the run's site tool `name` (`input.tools`) and replies with its result as text: text parts
   * joined by newlines, json parts JSON-encoded. Errors (unknown tool, thrown or `isError`) are
   * reported as `tool error: <message>` text; the run continues. `args` may be a function of the
   * earlier `callTool` replies in this run (e.g. pass an id returned by a previous tool).
   */
  | { callTool: { name: string; args: unknown | ((previous: string[]) => unknown) } }
  /** Replies with what the run received: `describeRunInput(input)`. */
  | { echo: true }
  | { crash: string }
  | { fail: ErrorBody };

export interface FakeAdapterOptions {
  id?: string;
  displayName?: string;
  probe?: RuntimeProbe;
  capabilities?: Partial<RuntimeCapabilities>;
  script: FakeStep[] | ((input: AdapterRunInput) => FakeStep[]);
}

const DEFAULT_CAPABILITIES: RuntimeCapabilities = {
  streaming: true,
  approval: { once: true, session: false, types: ['shell', 'file', 'network', 'mcp', 'other'] },
  nativeResume: false,
  diffEvents: false,
  mcp: false,
  skills: 'unknown',
  siteTools: true,
  models: [],
  efforts: [],
  permissionModes: ['default'],
  attachments: { images: false, files: false, maxBytes: ATTACHMENT_LIMITS.maxBytes },
};

/**
 * What a run received, for specs to assert that settings and attachments reach the runtime:
 * `settings: model=<id|-> effort=<level|-> mode=<permissionMode>; attachments: <names|->`.
 */
export function describeRunInput(input: AdapterRunInput): string {
  const { model, effort, permissionMode } = input.settings;
  const names = input.attachments.map((a) => a.name).join(',');
  return `settings: model=${model ?? '-'} effort=${effort ?? '-'} mode=${permissionMode}; attachments: ${names || '-'}`;
}

const resultText = (r: ToolCallResult): string => {
  const text = r.content.map((c) => (c.type === 'text' ? c.text : JSON.stringify(c.json))).join('\n');
  return r.isError ? `tool error: ${text}` : text;
};

async function callSiteTool(input: AdapterRunInput, name: string, args: unknown): Promise<string> {
  const tool = input.tools?.find((t) => t.name === name);
  if (!tool) return `tool error: unknown tool ${name}`;
  try {
    return resultText(await tool.call(args));
  } catch (e) {
    return `tool error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Resolves true after `ms`, or false as soon as the signal aborts. */
const sleep = (ms: number, signal: AbortSignal): Promise<boolean> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

/** Awaits the approval, but gives up (null) when the signal aborts. */
const awaitApproval = (
  ctx: AdapterRunContext,
  input: NativeApprovalInput,
): Promise<ApprovalOutcome | null> =>
  new Promise((resolve, reject) => {
    if (ctx.signal.aborted) return resolve(null);
    const onAbort = (): void => resolve(null);
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    ctx.requestApproval(input).then(
      (outcome) => {
        ctx.signal.removeEventListener('abort', onAbort);
        resolve(outcome);
      },
      (err: unknown) => {
        ctx.signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });

export function createFakeAdapter(
  opts: FakeAdapterOptions,
): RuntimeAdapter & { calls: AdapterRunInput[] } {
  const calls: AdapterRunInput[] = [];
  const capabilities: RuntimeCapabilities = { ...DEFAULT_CAPABILITIES, ...opts.capabilities };
  const probe: RuntimeProbe = opts.probe ?? { status: 'available', version: 'fake-1.0.0' };

  async function* run(input: AdapterRunInput, ctx: AdapterRunContext): AsyncGenerator<RuntimeEvent> {
    calls.push(input);
    const steps = typeof opts.script === 'function' ? opts.script(input) : opts.script;
    const interrupted = (): RuntimeEvent => ({ type: 'run.interrupted', reason: 'aborted' });

    const toolReplies: string[] = [];
    const toolStep = async (c: { name: string; args: unknown }): Promise<{ text: string }> => {
      const args = typeof c.args === 'function' ? (c.args as (previous: string[]) => unknown)([...toolReplies]) : c.args;
      const text = await callSiteTool(input, c.name, args);
      toolReplies.push(text);
      return { text };
    };

    for (const scripted of steps) {
      if (ctx.signal.aborted) return yield interrupted();
      const step: FakeStep =
        'echo' in scripted
          ? { text: describeRunInput(input) }
          : 'callTool' in scripted
            ? await toolStep(scripted.callTool)
            : scripted;
      if (ctx.signal.aborted) return yield interrupted();

      if ('text' in step) {
        const messageId = newId('msg');
        const n = Math.max(1, step.chunks ?? 1);
        const size = Math.ceil(step.text.length / n);
        yield { type: 'message.started', messageId };
        for (let i = 0; i < step.text.length; i += size) {
          if (step.delayMs && !(await sleep(step.delayMs, ctx.signal))) return yield interrupted();
          if (ctx.signal.aborted) return yield interrupted();
          yield { type: 'message.delta', messageId, text: step.text.slice(i, i + size) };
        }
        yield { type: 'message.completed', messageId, text: step.text };
      } else if ('tool' in step) {
        const t = step.tool;
        const toolId = newId('tool');
        yield { type: 'tool.started', toolId, name: t.name, title: t.title, category: t.category ?? 'other' };
        if (t.durationMs && !(await sleep(t.durationMs, ctx.signal))) return yield interrupted();
        if (t.fail !== undefined) yield { type: 'tool.failed', toolId, error: t.fail };
        else yield { type: 'tool.completed', toolId, output: t.output, durationMs: t.durationMs };
      } else if ('approval' in step) {
        const toolId = step.approval.toolId ?? newId('tool');
        yield {
          type: 'tool.started',
          toolId,
          name: step.approval.category,
          title: step.approval.title,
          category: step.approval.category,
        };
        const outcome = await awaitApproval(ctx, { ...step.approval, toolId });
        if (outcome === null) return yield interrupted();
        if (outcome.decision === 'allow') {
          yield { type: 'tool.completed', toolId, output: 'approved' };
        } else {
          yield { type: 'tool.failed', toolId, error: 'Declined by user', declined: true };
          if (step.onDeny === 'fail') {
            return yield {
              type: 'run.failed',
              error: { code: 'policy_denied', message: 'Approval was denied', retryable: false },
            };
          }
        }
      } else if ('waitMs' in step) {
        if (!(await sleep(step.waitMs, ctx.signal))) return yield interrupted();
      } else if ('crash' in step) {
        // Adapters translate runtime crashes into run.interrupted.
        return yield { type: 'run.interrupted', reason: step.crash };
      } else {
        return yield { type: 'run.failed', error: step.fail };
      }
    }
    if (ctx.signal.aborted) return yield interrupted();
    yield { type: 'run.completed' };
  }

  return {
    id: opts.id ?? 'fake',
    displayName: opts.displayName ?? 'Fake Runtime',
    calls,
    probe: () => Promise.resolve(probe),
    capabilities: () => capabilities,
    run,
  };
}
