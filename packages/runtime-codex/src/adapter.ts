import { spawn } from 'node:child_process';
import {
  ERROR_CATALOG,
  type AdapterRunContext,
  type AdapterRunInput,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeEvent,
} from '@uncage/protocol';
import { ATTACHMENT_LIMITS, type ModelOption } from '@uncage/protocol';
import { JsonRpcError, JsonRpcPeer } from './jsonrpc.js';
import { createMapper, toDecision } from './map.js';
import { probeCodex, type ExecFile } from './probe.js';
import {
  APPROVAL_POLICY,
  BYPASS_APPROVAL_POLICY,
  CLIENT_REQUEST,
  EFFORTS,
  MODEL_LIST_LIMIT,
  MODEL_LIST_MAX_PAGES,
  INITIALIZED,
  NOTIFY,
  type ModelListParams,
  type ModelListResult,
  type SandboxPolicy,
  REQUEST,
  SANDBOX,
  type AccountReadParams,
  type AccountReadResult,
  type ApprovalResult,
  type InitializeParams,
  type ThreadResult,
  type ThreadResumeParams,
  type ThreadStartParams,
  type TurnInterruptParams,
  type TurnStartParams,
  type TurnStartResult,
} from './protocol.js';

export interface CodexAdapterOptions {
  /** App-server command line. Defaults to ['codex', 'app-server']; probe() runs `<command[0]> --version`. */
  command?: string[];
  /** Environment for the app-server process. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Probe injection. */
  execFile?: ExecFile;
  /** Timeout for each JSON-RPC request to the app-server. Defaults to 30 s. */
  requestTimeoutMs?: number;
  /** Offer (and accept) the `bypassPermissions` mode. Defaults to false. */
  allowBypass?: boolean;
}

const DEFAULT_MODELS: ModelOption[] = [{ id: 'default', label: 'Default' }];

const CLIENT_INFO: InitializeParams['clientInfo'] = { name: 'uncage', title: 'Uncage', version: '0.0.0' };
const DISCONNECTED: RuntimeEvent = { type: 'run.interrupted', reason: 'runtime_disconnected' };
const ABORTED_EVENT: RuntimeEvent = { type: 'run.interrupted', reason: 'aborted' };
const ABORTED = Symbol('aborted');
const APPROVAL_METHODS = new Set<string>(Object.values(REQUEST));

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

type Incoming =
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'request'; method: string; params: unknown; respond(r: Promise<ApprovalResult>): void }
  | { kind: 'exit' }
  | { kind: 'wake' };

/** What a run registers on the connection to receive its thread's traffic, in wire order. */
interface ThreadSink {
  push(item: Incoming): void;
}

interface Connection {
  peer: JsonRpcPeer;
  sinks: Map<string, ThreadSink>;
}

/** The answer to a server request no run will handle: `cancel` for approvals, method-not-found otherwise. */
function unanswered(method: string): Promise<ApprovalResult> {
  if (APPROVAL_METHODS.has(method)) return Promise.resolve({ decision: 'cancel' });
  return Promise.reject(new JsonRpcError(method, -32601, `Unsupported request: ${method}`));
}

/** A tiny single-consumer async queue. */
function createQueue<T>() {
  const items: T[] = [];
  let wake: (() => void) | undefined;
  return {
    push(item: T): void {
      items.push(item);
      wake?.();
      wake = undefined;
    },
    drain(): T[] {
      return items.splice(0);
    },
    async next(): Promise<T> {
      while (items.length === 0) await new Promise<void>((r) => (wake = r));
      return items.shift()!;
    },
  };
}

const threadIdOf = (params: unknown): string | undefined => {
  const id = (params as { threadId?: unknown } | null | undefined)?.threadId;
  return typeof id === 'string' ? id : undefined;
};

const turnIdOf = (method: string, params: unknown): string | undefined => {
  const p = params as { turnId?: unknown; turn?: { id?: unknown } } | null | undefined;
  const id = method === NOTIFY.turnCompleted ? p?.turn?.id : p?.turnId;
  return typeof id === 'string' ? id : undefined;
};

function failed(code: 'runtime_unavailable' | 'internal_error' | 'policy_denied' | 'invalid_request', message: string): RuntimeEvent {
  const entry = ERROR_CATALOG[code];
  return { type: 'run.failed', error: { code, message, hint: entry.hint, retryable: entry.retryable } };
}

export function codexAdapter(o: CodexAdapterOptions = {}): RuntimeAdapter {
  const [executable = 'codex', ...args] = o.command ?? ['codex', 'app-server'];
  const requestTimeoutMs = o.requestTimeoutMs ?? 30_000;
  const allowBypass = o.allowBypass === true;
  let models: ModelOption[] = DEFAULT_MODELS;
  /** True once `models` came from a successful `model/list`. */
  let modelsAuthoritative = false;
  let current: Promise<Connection> | undefined;

  /** One app-server per adapter, started lazily and shared by every session; respawned after it exits. */
  function connect(): Promise<Connection> {
    if (current) return current;
    const attempt = (async (): Promise<Connection> => {
      const proc = spawn(executable, args, { env: o.env ?? process.env, stdio: 'pipe' });
      let spawnError: Error | undefined;
      proc.on('error', (err) => (spawnError ??= err));
      const peer = new JsonRpcPeer(proc, { requestTimeoutMs });
      const conn: Connection = { peer, sinks: new Map() };
      peer.onNotification((method, params) => {
        const id = threadIdOf(params);
        if (id !== undefined) conn.sinks.get(id)?.push({ kind: 'notification', method, params });
      });
      peer.onRequest((method, params) => {
        const sink = conn.sinks.get(threadIdOf(params) ?? '');
        // Queued with the notifications so the request is mapped after the item/started that precedes it.
        if (sink) return new Promise((respond) => sink.push({ kind: 'request', method, params, respond }));
        // Nobody is waiting on this thread any more (the run ended): never leave Codex blocked.
        return unanswered(method);
      });
      peer.onExit(() => {
        if (current === attempt) current = undefined;
        for (const sink of conn.sinks.values()) sink.push({ kind: 'exit' });
      });
      try {
        await peer.request(CLIENT_REQUEST.initialize, { clientInfo: CLIENT_INFO } satisfies InitializeParams);
        peer.notify(INITIALIZED, {});
      } catch (err) {
        await peer.close();
        throw spawnError ?? err;
      }
      return conn;
    })();
    current = attempt;
    attempt.catch(() => {
      if (current === attempt) current = undefined;
    });
    return attempt;
  }

  async function* run(input: AdapterRunInput, ctx: AdapterRunContext): AsyncGenerator<RuntimeEvent> {
    if (ctx.signal.aborted) return yield ABORTED_EVENT;
    const map = createMapper();
    const queue = createQueue<Incoming>();
    const wake = (): void => queue.push({ kind: 'wake' });
    ctx.signal.addEventListener('abort', wake, { once: true });
    // Fires on abort and whenever the run ends, so no approval keeps Codex blocked.
    const done = new AbortController();
    const settled = AbortSignal.any([ctx.signal, done.signal]);

    let conn: Connection | undefined;
    let threadId: string | undefined;
    let turnStart: Promise<TurnStartResult> | undefined;
    let turnId: string | undefined;
    let ended = false; // reached a terminal state that needs no turn/interrupt

    const sink: ThreadSink = { push: (item) => queue.push(item) };

    /** Asks the user without blocking the event loop; the answer is sent when it arrives. */
    const askApproval = async (method: string, params: unknown): Promise<ApprovalResult> => {
      const request = map.approval(method, params);
      if (!request) throw new JsonRpcError(method, -32601, `Unsupported request: ${method}`);
      const outcome = await untilAborted(ctx.requestApproval(request), settled);
      return { decision: outcome === ABORTED ? 'cancel' : toDecision(outcome) };
    };

    /** Maps a failed request to the run's terminal event. */
    const requestFailed = (err: unknown): RuntimeEvent => {
      if (conn?.peer.closed) return DISCONNECTED;
      return failed('internal_error', err instanceof Error ? err.message : String(err));
    };

    try {
      try {
        const c = await untilAborted(connect(), ctx.signal);
        if (c === ABORTED) return yield ABORTED_EVENT;
        conn = c;
      } catch (err) {
        ended = true;
        const notFound = (err as NodeJS.ErrnoException).code === 'ENOENT';
        return yield failed(
          'runtime_unavailable',
          notFound ? `Codex CLI was not found (${executable}).` : `Codex app-server failed to start: ${(err as Error).message}`,
        );
      }

      const { settings } = input;
      const bypass = settings.permissionMode === 'bypassPermissions';
      if (bypass && !allowBypass) {
        ended = true;
        return yield failed('policy_denied', 'bypassPermissions is not allowed on this server.');
      }
      if (settings.permissionMode !== 'default' && !bypass) {
        ended = true;
        return yield failed('invalid_request', `Codex does not support the ${settings.permissionMode} permission mode.`);
      }
      const policy = { cwd: input.cwd, approvalPolicy: APPROVAL_POLICY, sandbox: SANDBOX } as const;
      const thread = input.nativeSessionRef
        ? conn.peer.request<ThreadResult>(CLIENT_REQUEST.threadResume, {
            threadId: input.nativeSessionRef,
            ...policy,
          } satisfies ThreadResumeParams)
        : conn.peer.request<ThreadResult>(CLIENT_REQUEST.threadStart, policy satisfies ThreadStartParams);
      let threadResult: ThreadResult | typeof ABORTED;
      try {
        threadResult = await untilAborted(thread, ctx.signal);
      } catch (err) {
        ended = true;
        return yield requestFailed(err);
      }
      if (threadResult === ABORTED) return yield ABORTED_EVENT;
      threadId = threadResult.thread.id;
      conn.sinks.set(threadId, sink);
      yield { type: 'native.session', ref: threadId };

      const images = input.attachments.filter((a) => a.kind === 'image');
      const files = input.attachments.filter((a) => a.kind !== 'image');
      const listing = files.length
        ? `\n\nAttached files (read them with your tools):\n${files.map((f) => `- ${f.absPath}`).join('\n')}`
        : '';
      const sandboxPolicy: SandboxPolicy = bypass
        ? { type: 'dangerFullAccess' }
        : { type: 'workspaceWrite', writableRoots: [input.cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
      turnStart = conn.peer.request<TurnStartResult>(CLIENT_REQUEST.turnStart, {
        threadId,
        input: [...images.map((a) => ({ type: 'localImage' as const, path: a.absPath })), { type: 'text', text: input.prompt + listing }],
        ...(settings.model && settings.model !== 'default' ? { model: settings.model } : {}),
        ...(settings.effort ? { effort: settings.effort } : {}),
        approvalPolicy: bypass ? BYPASS_APPROVAL_POLICY : APPROVAL_POLICY,
        sandboxPolicy,
      } satisfies TurnStartParams);
      let started: TurnStartResult | typeof ABORTED;
      try {
        started = await untilAborted(turnStart, ctx.signal);
      } catch (err) {
        ended = true;
        return yield requestFailed(err);
      }
      if (started === ABORTED) return yield ABORTED_EVENT;
      turnId = started.turn.id;

      for (;;) {
        if (ctx.signal.aborted) return yield ABORTED_EVENT;
        const item = await queue.next();
        if (ctx.signal.aborted) return yield ABORTED_EVENT;
        if (item.kind === 'wake') continue;
        if (item.kind === 'request') {
          item.respond(askApproval(item.method, item.params));
          continue;
        }
        if (item.kind === 'exit') {
          ended = true;
          for (const e of map.flush()) yield e;
          return yield DISCONNECTED;
        }
        // Late traffic from an earlier turn on this thread is not ours.
        const itemTurn = turnIdOf(item.method, item.params);
        if (itemTurn !== undefined && itemTurn !== turnId) continue;
        for (const event of map.notification(item.method, item.params)) {
          if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.interrupted') {
            ended = true;
            return yield event;
          }
          yield event;
        }
      }
    } finally {
      ctx.signal.removeEventListener('abort', wake);
      done.abort();
      // Requests that arrived but were never handled must still be answered.
      for (const item of queue.drain()) if (item.kind === 'request') item.respond(unanswered(item.method));
      if (conn && threadId !== undefined) {
        if (conn.sinks.get(threadId) === sink) conn.sinks.delete(threadId);
        // Aborted, or the consumer stopped early: stop the turn so Codex does not keep working.
        if (!ended && turnStart && !conn.peer.closed) {
          const { peer } = conn;
          const tid = threadId;
          void turnStart
            .then((r) => peer.request(CLIENT_REQUEST.turnInterrupt, { threadId: tid, turnId: r.turn.id } satisfies TurnInterruptParams))
            .catch(() => undefined);
        }
      }
    }
  }

  const capabilities = (): RuntimeCapabilities => ({
    streaming: true,
    approval: { once: true, session: false, types: ['shell', 'file'] },
    nativeResume: true,
    diffEvents: false,
    mcp: true,
    skills: 'unknown',
    siteTools: false,
    models,
    ...(modelsAuthoritative ? { modelsAuthoritative: true } : {}),
    efforts: [...EFFORTS],
    permissionModes: allowBypass ? ['default', 'bypassPermissions'] : ['default'],
    attachments: { images: true, files: true, maxBytes: ATTACHMENT_LIMITS.maxBytes },
  });

  return {
    id: 'codex',
    displayName: 'Codex',
    capabilities,
    /** `model/list` (first page, hidden models excluded); keeps the previous list on any failure. */
    async refreshCapabilities() {
      try {
        const conn = await connect();
        const data: ModelListResult['data'] = [];
        let cursor: string | null = null;
        for (let page = 0; page < MODEL_LIST_MAX_PAGES; page++) {
          const params: ModelListParams = { limit: MODEL_LIST_LIMIT, ...(cursor ? { cursor } : {}) };
          const res: ModelListResult = await conn.peer.request<ModelListResult>(CLIENT_REQUEST.modelList, params);
          data.push(...res.data);
          cursor = res.nextCursor;
          if (!cursor) break;
        }
        const listed = data
          .filter((m) => !m.hidden)
          .map((m) => ({ id: m.model, label: m.displayName || m.model, ...(m.description ? { description: m.description } : {}) }));
        if (listed.length > 0) {
          models = [...DEFAULT_MODELS, ...listed.filter((m) => m.id !== 'default')];
          modelsAuthoritative = true;
        }
      } catch {
        // Keep what we had.
      }
      return capabilities();
    },
    probe: () =>
      probeCodex(executable, o.execFile, async (params) => {
        const conn = await connect();
        return conn.peer.request<AccountReadResult>(CLIENT_REQUEST.accountRead, params satisfies AccountReadParams);
      }),
    run,
    async dispose() {
      const c = current;
      current = undefined;
      if (!c) return;
      const conn = await c.catch(() => undefined);
      await conn?.peer.close();
    },
  };
}
