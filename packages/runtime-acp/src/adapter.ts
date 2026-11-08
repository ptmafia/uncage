import { randomUUID } from 'node:crypto';
import {
  methods,
  RequestError,
  type InitializeResponse,
  type NewSessionResponse,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionUpdate,
} from '@agentclientprotocol/sdk';
import {
  ERROR_CATALOG,
  type AdapterRunContext,
  type AdapterRunInput,
  type ErrorCode,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type RuntimeProbe,
} from '@uncage/protocol';
import { DEFAULT_ACP_CAPABILITIES, mapCapabilities } from './capabilities.js';
import { approvalInput, chooseOption, createAcpMapper } from './map.js';
import { AcpProtocolError, startAcpProcess, type AcpProcess } from './process.js';
import { toPromptBlocks } from './prompt.js';

export interface AcpAdapterOptions {
  /** Runtime id, `acp-<name>` (/^acp-[a-z][a-z0-9-]{0,31}$/). */
  id: string;
  displayName: string;
  /** The agent's argv; `command[0]` is resolved on PATH (or absolute). */
  command: string[];
  /** Merged over process.env. */
  env?: Record<string, string>;
  /** Offer (and accept) the `bypassPermissions` mode. Defaults to false. */
  allowBypass?: boolean;
  /** How site tools reach the agent (Task A2). Defaults to 'auto'. */
  mcp?: 'auto' | 'http' | 'stdio' | 'off';
  /** Shown when the command is not installed. */
  installHint?: string;
  installUrl?: string;
  /** Spawn + `initialize` timeout. Defaults to 15 s. */
  initTimeoutMs?: number;
  /** Timeout for session requests (not `session/prompt`). Defaults to 30 s. */
  requestTimeoutMs?: number;
  /** After `session/cancel`, kill the agent if the prompt has not resolved within this many ms. Defaults to 10 s. */
  cancelGraceMs?: number;
}

const ID_PATTERN = /^acp-[a-z][a-z0-9-]{0,31}$/;
const AUTH_REQUIRED = -32000;
const NOT_FOUND = -32002;

const DISCONNECTED: RuntimeEvent = { type: 'run.interrupted', reason: 'runtime_disconnected' };
const ABORTED_EVENT: RuntimeEvent = { type: 'run.interrupted', reason: 'aborted' };
const ABORTED = Symbol('aborted');
const CANCELLED: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };

/** Lets every message already read from the agent reach its handler (SDK dispatch is microtask-based). */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

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

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function failed(code: ErrorCode, message: string, hint?: string): RuntimeEvent {
  const entry = ERROR_CATALOG[code];
  return { type: 'run.failed', error: { code, message, hint: hint ?? entry.hint, retryable: entry.retryable } };
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const rpcCode = (err: unknown): number | undefined => (err instanceof RequestError ? err.code : undefined);

type Incoming =
  | { kind: 'update'; update: SessionUpdate }
  | { kind: 'permission'; req: RequestPermissionRequest; signal: AbortSignal; respond(r: Promise<RequestPermissionResponse>): void }
  | { kind: 'stop'; response: PromptResponse }
  | { kind: 'error'; err: unknown }
  | { kind: 'exit' }
  | { kind: 'wake' };

/** What a run registers on the connection to receive its session's traffic, in wire order. */
interface SessionSink {
  push(item: Incoming): void;
  /** `session/load` is replaying history: drop updates and refuse permissions. */
  replaying: boolean;
}

interface Connection {
  proc: AcpProcess;
  sinks: Map<string, SessionSink>;
  closed: boolean;
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

/** A runtime for any agent that speaks the Agent Client Protocol (stable v1) over stdio. */
export function acpAdapter(o: AcpAdapterOptions): RuntimeAdapter {
  if (!ID_PATTERN.test(o.id)) throw new Error(`Invalid ACP runtime id "${o.id}": expected acp-<name> matching ${String(ID_PATTERN)}.`);
  if (o.command.length === 0 || !o.command[0]) throw new Error(`ACP runtime ${o.id}: command must not be empty.`);
  const executable = o.command[0];
  const allowBypass = o.allowBypass === true;
  const mcp = o.mcp ?? 'auto';
  const initTimeoutMs = o.initTimeoutMs ?? 15_000;
  const requestTimeoutMs = o.requestTimeoutMs ?? 30_000;
  const cancelGraceMs = o.cancelGraceMs ?? 10_000;
  let init: InitializeResponse | undefined;
  let current: Promise<Connection> | undefined;

  const notFoundMessage = `${o.displayName} was not found (${executable}).`;

  /** One agent process per adapter, started lazily and shared by every session; respawned after it exits. */
  function connect(): Promise<Connection> {
    if (current) return current;
    const sinks = new Map<string, SessionSink>();
    const attempt = startAcpProcess({
      command: o.command,
      env: { ...process.env, ...o.env },
      initTimeoutMs,
      handlers: {
        onUpdate(n) {
          const sink = sinks.get(n.sessionId);
          if (sink && !sink.replaying) sink.push({ kind: 'update', update: n.update });
        },
        onPermission(req, signal) {
          const sink = sinks.get(req.sessionId);
          // Nobody is running this session (or it is replaying): never leave the agent blocked.
          if (!sink || sink.replaying) return Promise.resolve(CANCELLED);
          return new Promise((respond) => sink.push({ kind: 'permission', req, signal, respond }));
        },
      },
    }).then((proc) => {
      init = proc.init;
      const conn: Connection = { proc, sinks, closed: false };
      /** The process exited or its stdio closed: either way it is gone for us. */
      const gone = (): void => {
        if (conn.closed) return;
        conn.closed = true;
        if (current === attempt) current = undefined;
        proc.kill();
        // After the messages already read have reached their sinks.
        void settle().then(() => {
          for (const sink of sinks.values()) sink.push({ kind: 'exit' });
        });
      };
      void proc.exited.then(gone);
      if (proc.conn.signal.aborted) gone();
      else proc.conn.signal.addEventListener('abort', gone, { once: true });
      return conn;
    });
    current = attempt;
    attempt.catch(() => {
      if (current === attempt) current = undefined;
    });
    return attempt;
  }

  const capabilities = (): RuntimeCapabilities =>
    init ? mapCapabilities(init, { allowBypass, mcp }) : { ...DEFAULT_ACP_CAPABILITIES, permissionModes: allowBypass ? ['default', 'bypassPermissions'] : ['default'] };

  function authHint(): string {
    const names = (init?.authMethods ?? []).map((m) => m.name).filter(Boolean);
    return names.length
      ? `Sign in to ${o.displayName} (${names.join(' or ')}) in a terminal, then retry.`
      : `Sign in to ${o.displayName} in a terminal, then retry.`;
  }

  async function* run(input: AdapterRunInput, ctx: AdapterRunContext): AsyncGenerator<RuntimeEvent> {
    if (ctx.signal.aborted) return yield ABORTED_EVENT;
    const { permissionMode } = input.settings;
    const bypass = permissionMode === 'bypassPermissions';
    if (bypass && !allowBypass) return yield failed('policy_denied', 'bypassPermissions is not allowed on this server.');
    if (permissionMode !== 'default' && !bypass) {
      return yield failed('invalid_request', `${o.displayName} does not support the ${permissionMode} permission mode.`);
    }

    const map = createAcpMapper(() => randomUUID());
    const queue = createQueue<Incoming>();
    const sink: SessionSink = { push: (item) => queue.push(item), replaying: false };
    const wake = (): void => queue.push({ kind: 'wake' });
    // Fires on abort and whenever the run ends, so no permission request keeps the agent blocked.
    const done = new AbortController();
    const settled = AbortSignal.any([ctx.signal, done.signal]);

    let conn: Connection | undefined;
    let sessionId: string | undefined;
    let prompt: Promise<unknown> | undefined;
    let promptSettled = false;
    let cancelSent = false;

    /** `session/cancel` once, while the prompt is running; kills an agent that ignores it. */
    const cancelPrompt = (): void => {
      if (!conn || conn.closed || sessionId === undefined || !prompt || promptSettled || cancelSent) return;
      cancelSent = true;
      const c = conn;
      void c.proc.conn.agent.notify(methods.agent.session.cancel, { sessionId }).catch(() => undefined);
      const timer = setTimeout(() => {
        if (!promptSettled && !c.closed) c.proc.kill();
      }, cancelGraceMs);
      timer.unref();
      void prompt.finally(() => clearTimeout(timer)).catch(() => undefined);
    };
    // Registered before any approval waits on the signal, so `session/cancel` goes out before the
    // pending permission requests are answered `cancelled`.
    const onAbort = (): void => {
      cancelPrompt();
      wake();
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    const askApproval = async (req: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> => {
      if (bypass) return { outcome: chooseOption(req.options, { decision: 'allow' }) };
      const request = approvalInput(req.toolCall, map.tool(req.toolCall.toolCallId), input.cwd);
      const outcome = await untilAborted(ctx.requestApproval(request), AbortSignal.any([settled, signal]));
      if (outcome === ABORTED) return CANCELLED;
      const chosen = chooseOption(req.options, outcome);
      if (outcome.decision !== 'allow') map.markDeclined(req.toolCall.toolCallId);
      return { outcome: chosen };
    };

    /** The terminal event for a failed request. */
    const requestFailed = (err: unknown): RuntimeEvent => {
      if (rpcCode(err) === AUTH_REQUIRED) return failed('auth_required', `${o.displayName} requires authentication.`, authHint());
      if (conn?.closed || conn?.proc.conn.signal.aborted) return DISCONNECTED;
      return failed('internal_error', errorMessage(err));
    };

    try {
      try {
        const c = await untilAborted(connect(), ctx.signal);
        if (c === ABORTED) return yield ABORTED_EVENT;
        conn = c;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return yield failed('runtime_unavailable', notFoundMessage, o.installHint);
        }
        return yield failed('runtime_unavailable', `${o.displayName} failed to start: ${errorMessage(err)}`);
      }
      const agent = conn.proc.conn.agent;
      const agentCaps = conn.proc.init.agentCapabilities ?? {};
      const session = { cwd: input.cwd, mcpServers: [] };
      const ref = input.nativeSessionRef;
      const canResume = Boolean(agentCaps.sessionCapabilities?.resume);
      const canLoad = agentCaps.loadSession === true;

      try {
        if (ref !== undefined && (canResume || canLoad)) {
          // Register before the request: `session/load` replays history (dropped) before it resolves.
          sink.replaying = !canResume;
          conn.sinks.set(ref, sink);
          sessionId = ref;
          const request = canResume
            ? agent.request(methods.agent.session.resume, { sessionId: ref, ...session })
            : agent.request(methods.agent.session.load, { sessionId: ref, ...session });
          const r = await untilAborted(withTimeout(request, requestTimeoutMs, canResume ? 'session/resume' : 'session/load'), ctx.signal);
          if (r === ABORTED) return yield ABORTED_EVENT;
          await settle();
          sink.replaying = false;
        } else {
          if (ref !== undefined) {
            yield {
              type: 'warning',
              code: 'acp_resume_unsupported',
              message: `${o.displayName} cannot resume sessions; this message starts a new conversation.`,
            };
          }
          const request: Promise<NewSessionResponse> = agent.request(methods.agent.session.new, session);
          const r = await untilAborted(withTimeout(request, requestTimeoutMs, 'session/new'), ctx.signal);
          if (r === ABORTED) return yield ABORTED_EVENT;
          sessionId = r.sessionId;
          conn.sinks.set(r.sessionId, sink);
        }
      } catch (err) {
        if (ref !== undefined && rpcCode(err) === NOT_FOUND) {
          return yield { type: 'native.session_lost', message: `${o.displayName} no longer has this conversation (${errorMessage(err)}).` };
        }
        return yield requestFailed(err);
      }
      const sid = sessionId;
      yield { type: 'native.session', ref: sid };

      let blocks;
      try {
        blocks = await toPromptBlocks(input, { image: agentCaps.promptCapabilities?.image === true });
      } catch (err) {
        return yield failed('internal_error', `Could not read an attachment: ${errorMessage(err)}`);
      }
      if (ctx.signal.aborted) return yield ABORTED_EVENT;
      if (conn.closed) return yield DISCONNECTED;
      const promptRequest: Promise<PromptResponse> = agent.request(methods.agent.session.prompt, { sessionId: sid, prompt: blocks });
      prompt = promptRequest.then(
        async (response) => {
          promptSettled = true;
          await settle();
          queue.push({ kind: 'stop', response });
        },
        async (err: unknown) => {
          promptSettled = true;
          await settle();
          queue.push({ kind: 'error', err });
        },
      );

      for (;;) {
        if (ctx.signal.aborted) return yield ABORTED_EVENT;
        const item = await queue.next();
        if (ctx.signal.aborted) return yield ABORTED_EVENT;
        switch (item.kind) {
          case 'wake':
            continue;
          case 'permission':
            for (const e of map.ensureTool(item.req.toolCall)) yield e;
            item.respond(askApproval(item.req, item.signal));
            continue;
          case 'update':
            for (const e of map.update(item.update)) yield e;
            continue;
          case 'stop':
            for (const e of map.finish(item.response.stopReason)) yield e;
            return;
          case 'exit':
            for (const e of map.flush()) yield e;
            return yield DISCONNECTED;
          case 'error': {
            const terminal = requestFailed(item.err);
            if (terminal === DISCONNECTED) for (const e of map.flush()) yield e;
            return yield terminal;
          }
        }
      }
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      // Aborted, or the consumer stopped early: stop the turn so the agent does not keep working.
      cancelPrompt();
      done.abort();
      // Permission requests that arrived but were never handled must still be answered.
      for (const item of queue.drain()) if (item.kind === 'permission') item.respond(Promise.resolve(CANCELLED));
      if (conn && sessionId !== undefined && conn.sinks.get(sessionId) === sink) conn.sinks.delete(sessionId);
    }
  }

  async function probe(): Promise<RuntimeProbe> {
    try {
      const conn = await connect();
      const version = conn.proc.init.agentInfo?.version;
      return { status: 'available', ...(version ? { version } : {}) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          status: 'not_installed',
          message: notFoundMessage,
          ...(o.installHint ? { hint: o.installHint } : {}),
          ...(o.installUrl ? { installUrl: o.installUrl } : {}),
        };
      }
      return { status: 'error', message: err instanceof AcpProtocolError ? err.message : `${o.displayName} failed to start: ${errorMessage(err)}` };
    }
  }

  return {
    id: o.id,
    displayName: o.displayName,
    capabilities,
    /** Starts the agent if needed and maps its `initialize` result; keeps the current capabilities on failure. */
    async refreshCapabilities() {
      await connect().catch(() => undefined);
      return capabilities();
    },
    probe,
    run,
    async dispose() {
      const c = current;
      current = undefined;
      if (!c) return;
      const conn = await c.catch(() => undefined);
      if (!conn) return;
      conn.proc.kill();
      await conn.proc.exited;
    },
  };
}
