import { query as sdkQuery, type CanUseTool, type PermissionResult, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  AdapterRunContext,
  AdapterRunInput,
  ApprovalOutcome,
  ModelOption,
  NativeApprovalInput,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeEvent,
} from '@uncage/protocol';
import { CLAUDE_FALLBACK_MODELS, claudeCapabilities, toModelOptions } from './capabilities.js';
import { buildPrompt } from './input.js';
import { CANCELLED_MESSAGE, DENIED_MESSAGE, EXPIRED_MESSAGE, categorize, createMapper, isResumeFailure, runFailed } from './map.js';
import { probeClaude, type ExecFile } from './probe.js';

export interface ClaudeAdapterOptions {
  /** Injectable for tests. */
  query?: typeof sdkQuery;
  /** Defaults to ['project']. */
  settingSources?: Array<'user' | 'project' | 'local'>;
  /** Used when a session has no model setting. */
  model?: string;
  /** Server policy `security.allowBypass`: offer and accept `bypassPermissions`. Default false. */
  allowBypass?: boolean;
  /** Path to the Claude Code executable (`pathToClaudeCodeExecutable`); also used by probe(). */
  executable?: string;
  /** Probe injection. */
  execFile?: ExecFile;
}

/** How long a `supportedModels()` answer is reused. */
const MODELS_TTL_MS = 10 * 60_000;
/** After a failed model-list probe, don't probe again for this long. */
const MODELS_RETRY_MS = 60_000;
/** Give up on a model-list probe after this long (keeps the previous list). */
const MODELS_TIMEOUT_MS = 15_000;
/** How long the model-list probe waits for its interrupt before killing Claude Code. */
const PROBE_INTERRUPT_MS = 2_000;

/** After an interrupt, give Claude Code this long to wind down before killing it. */
const KILL_GRACE_MS = 3_000;
/** After a terminal event, Claude Code should exit by itself; kill it if it lingers this long. */
const LINGER_KILL_MS = 10_000;
const TERMINAL = new Set<RuntimeEvent['type']>(['run.completed', 'run.failed', 'run.interrupted', 'native.session_lost']);
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

/** Rejects after `ms` (the timer never keeps the process alive). */
function timeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref();
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** Streaming input that never yields: the CLI starts and answers control requests, but no turn is sent. */
function silentInput(): AsyncIterable<SDKUserMessage> {
  return { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<SDKUserMessage>>(() => undefined) }) };
}

export function claudeAdapter(o: ClaudeAdapterOptions = {}): RuntimeAdapter {
  const queryFn = o.query ?? sdkQuery;
  const settingSources = o.settingSources ?? ['project'];
  const allowBypass = o.allowBypass === true;
  let models: ModelOption[] = CLAUDE_FALLBACK_MODELS;
  /** True once `models` came from a successful `supportedModels()`. */
  let modelsAuthoritative = false;
  /** When the model list may be probed again (cache expiry, or back-off after a failure). */
  let modelsStaleAt = -Infinity;
  let modelsInflight: Promise<void> | undefined;

  const capabilities = (): RuntimeCapabilities => claudeCapabilities({ models, allowBypass, modelsAuthoritative });

  /** Reads `supportedModels()` from a short-lived Claude Code process; keeps the current list on any error. */
  async function loadModels(): Promise<void> {
    const abortController = new AbortController();
    let q: ReturnType<typeof sdkQuery> | undefined;
    try {
      q = queryFn({
        prompt: silentInput(),
        // No setting sources: a probe must not run project hooks or load project settings.
        options: defined({ abortController, settingSources: [], pathToClaudeCodeExecutable: o.executable }),
      });
      const list = toModelOptions(await timeout(q.supportedModels(), MODELS_TIMEOUT_MS, 'supportedModels() timed out'));
      models = list;
      modelsAuthoritative = true;
      modelsStaleAt = Date.now() + MODELS_TTL_MS;
    } catch {
      // Keep the current (fallback) list and back off before probing again.
      modelsStaleAt = Date.now() + MODELS_RETRY_MS;
    } finally {
      if (q) {
        const probe = q;
        await timeout(Promise.resolve().then(() => probe.interrupt()), PROBE_INTERRUPT_MS, 'interrupt timed out').catch(() => undefined);
        abortController.abort();
        // Drain so the aborted iterator's rejection is observed.
        void (async () => {
          while (!(await probe.next()).done);
        })().catch(() => undefined);
      }
    }
  }

  async function refreshCapabilities(): Promise<RuntimeCapabilities> {
    if (Date.now() >= modelsStaleAt) {
      modelsInflight ??= loadModels().finally(() => {
        modelsInflight = undefined;
      });
      await modelsInflight;
    }
    return capabilities();
  }

  async function* run(input: AdapterRunInput, ctx: AdapterRunContext): AsyncGenerator<RuntimeEvent> {
    const interrupted: RuntimeEvent = { type: 'run.interrupted', reason: 'aborted' };
    if (ctx.signal.aborted) return yield interrupted;
    const { settings } = input;
    // Core enforces the policy; refuse here too so a bypass can never reach Claude Code unless allowed.
    if (settings.permissionMode === 'bypassPermissions' && !allowBypass) {
      return yield runFailed('policy_denied', 'bypassPermissions is not allowed on this server.');
    }
    let prompt: string | AsyncIterable<SDKUserMessage>;
    try {
      prompt = await buildPrompt(input.prompt, input.attachments);
    } catch (err) {
      return yield runFailed('invalid_request', `Could not read an attachment: ${err instanceof Error ? err.message : String(err)}`);
    }

    const abortController = new AbortController();
    const denials = new Map<string, string>();
    const mapMessage = createMapper(denials);
    // A failed `resume` (Claude Code no longer has the conversation) is not an ordinary failure:
    // the session can never continue, so report it as lost.
    const resuming = input.nativeSessionRef !== undefined;
    const lost = (message: string): RuntimeEvent | undefined =>
      resuming && isResumeFailure(message) ? { type: 'native.session_lost', message } : undefined;
    const map = (m: Parameters<typeof mapMessage>[0]): RuntimeEvent[] =>
      mapMessage(m).map((e) => (e.type === 'run.failed' ? (lost(e.error.message) ?? e) : e));

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
      prompt,
      options: defined({
        cwd: input.cwd,
        resume: input.nativeSessionRef,
        permissionMode: settings.permissionMode,
        allowDangerouslySkipPermissions: settings.permissionMode === 'bypassPermissions' ? true : undefined,
        includePartialMessages: true,
        settingSources,
        abortController,
        // Registered in every mode: whatever the mode leaves to the user still goes through Uncage.
        canUseTool,
        // 'default' means the CLI's own choice.
        model: settings.model === 'default' ? undefined : (settings.model ?? o.model),
        effort: settings.effort,
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
      const reason = err instanceof Error ? err.message : String(err);
      yield lost(reason) ?? { type: 'run.interrupted', reason };
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
    capabilities,
    refreshCapabilities,
    run,
  };
}
