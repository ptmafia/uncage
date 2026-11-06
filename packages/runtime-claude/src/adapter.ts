import { query as sdkQuery, type CanUseTool, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type {
  AdapterRunContext,
  AdapterRunInput,
  ApprovalOutcome,
  NativeApprovalInput,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeEvent,
} from '@uncage/protocol';
import { CANCELLED_MESSAGE, DENIED_MESSAGE, EXPIRED_MESSAGE, categorize, createMapper } from './map.js';
import { probeClaude, type ExecFile } from './probe.js';

export interface ClaudeAdapterOptions {
  /** Injectable for tests. */
  query?: typeof sdkQuery;
  /** Defaults to ['project']. */
  settingSources?: Array<'user' | 'project' | 'local'>;
  model?: string;
  /** Path to the Claude Code executable (`pathToClaudeCodeExecutable`); also used by probe(). */
  executable?: string;
  /** Probe injection. */
  execFile?: ExecFile;
}

const CAPABILITIES: RuntimeCapabilities = {
  streaming: true,
  approval: { once: true, session: false, types: ['shell', 'file', 'network', 'mcp', 'other'] },
  nativeResume: true,
  diffEvents: false,
  mcp: true,
  skills: 'supported',
};

/** After an interrupt, give Claude Code this long to wind down before killing it. */
const KILL_GRACE_MS = 3_000;
/** After a terminal event, Claude Code should exit by itself; kill it if it lingers this long. */
const LINGER_KILL_MS = 10_000;
const TERMINAL = new Set<RuntimeEvent['type']>(['run.completed', 'run.failed', 'run.interrupted']);
const ABORTED = Symbol('aborted');

/** Resolves with the promise's value, or ABORTED as soon as the signal fires. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.resolve(ABORTED);
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function toPermission(outcome: ApprovalOutcome, input: Record<string, unknown>): PermissionResult {
  switch (outcome.decision) {
    case 'allow':
      return { behavior: 'allow', updatedInput: input };
    case 'deny':
      return { behavior: 'deny', message: outcome.reason ?? DENIED_MESSAGE };
    case 'expired':
      return { behavior: 'deny', message: EXPIRED_MESSAGE };
    case 'cancelled':
      return { behavior: 'deny', message: CANCELLED_MESSAGE, interrupt: true };
  }
}

const defined = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const strOrUndef = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export function claudeAdapter(o: ClaudeAdapterOptions = {}): RuntimeAdapter {
  const queryFn = o.query ?? sdkQuery;
  const settingSources = o.settingSources ?? ['project'];

  async function* run(input: AdapterRunInput, ctx: AdapterRunContext): AsyncGenerator<RuntimeEvent> {
    const interrupted: RuntimeEvent = { type: 'run.interrupted', reason: 'aborted' };
    if (ctx.signal.aborted) return yield interrupted;

    const abortController = new AbortController();
    const denials = new Map<string, string>();
    const map = createMapper(denials);

    const canUseTool: CanUseTool = async (toolName, toolInput, opts) => {
      const request: NativeApprovalInput = defined({
        toolId: opts.toolUseID,
        category: categorize(toolName),
        title: opts.title ?? toolName,
        description: opts.description ?? opts.decisionReason,
        target: defined({
          command: strOrUndef(toolInput.command),
          path: strOrUndef(toolInput.file_path) ?? opts.blockedPath,
          cwd: input.cwd,
        }),
      });
      // Never leave Claude Code blocked on an approval once the run (or the SDK's own request) is aborted.
      const outcome = await untilAborted(ctx.requestApproval(request), AbortSignal.any([ctx.signal, opts.signal]));
      const result = toPermission(outcome === ABORTED ? { decision: 'cancelled' } : outcome, toolInput);
      if (result.behavior === 'deny') denials.set(opts.toolUseID, result.message);
      return result;
    };

    const q = queryFn({
      prompt: input.prompt,
      options: defined({
        cwd: input.cwd,
        resume: input.nativeSessionRef,
        permissionMode: 'default' as const,
        includePartialMessages: true,
        settingSources,
        abortController,
        canUseTool,
        model: o.model,
        pathToClaudeCodeExecutable: o.executable,
      }),
    });

    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      void Promise.resolve()
        .then(() => q.interrupt())
        .catch(() => undefined);
      setTimeout(() => abortController.abort(), KILL_GRACE_MS).unref();
    };
    ctx.signal.addEventListener('abort', stop, { once: true });

    let ended = false; // the run reached a terminal state on its own
    try {
      for (;;) {
        const next = await untilAborted(q.next(), ctx.signal);
        if (next === ABORTED) return yield interrupted;
        if (next.done) break;
        for (const event of map(next.value)) {
          if (TERMINAL.has(event.type)) {
            ended = true;
            // Let Claude Code finish writing the session and exit by itself, but never leak the process.
            const kill = setTimeout(() => abortController.abort(), LINGER_KILL_MS);
            kill.unref();
            void (async () => {
              while (!(await q.next()).done);
            })()
              .catch(() => undefined)
              .finally(() => clearTimeout(kill));
            return yield event;
          }
          yield event;
        }
      }
      ended = true;
      yield { type: 'run.interrupted', reason: 'Claude Code exited before the run finished.' };
    } catch (err) {
      ended = true;
      // The iterator failed; make sure no CLI process outlives it.
      abortController.abort();
      if (ctx.signal.aborted) return yield interrupted;
      yield { type: 'run.interrupted', reason: err instanceof Error ? err.message : String(err) };
    } finally {
      ctx.signal.removeEventListener('abort', stop);
      // Aborted, or the consumer stopped iterating early: shut Claude Code down.
      if (!ended) stop();
    }
  }

  return {
    id: 'claude',
    displayName: 'Claude Code',
    probe: () => probeClaude(o.executable, o.execFile),
    capabilities: () => CAPABILITIES,
    run,
  };
}
