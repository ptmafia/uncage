import { randomUUID } from 'node:crypto';
import {
  methods,
  RequestError,
  type ClientContext,
  type InitializeResponse,
  type McpServer,
  type NewSessionResponse,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionModeState,
  type SessionUpdate,
} from '@agentclientprotocol/sdk';
import {
  ERROR_CATALOG,
  type AdapterRunContext,
  type AdapterRunInput,
  type ApprovalOutcome,
  type ErrorCode,
  type NativeApprovalInput,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type RuntimeIcon,
  type RuntimeProbe,
} from '@uncage/protocol';
import { materializeSkills, type MaterializedSkill } from '@uncage/protocol/node';
import { NO_ALLOW_ONCE_WARNING, permissionDecision, toPermissionResponse } from './approvals.js';
import { defaultCapabilities, mapCapabilities } from './capabilities.js';
import { createAcpMapper } from './map.js';
import { AcpProtocolError, startAcpProcess, stopAcpProcess, type AcpProcess } from './process.js';
import { toPromptBlocks } from './prompt.js';
import { siteMcpDeclaration, startSiteMcpServer, type SiteMcpServer } from './site-mcp.js';
import { ACP_SKILLS_ROOT, skillsPreamble } from './skills.js';

export interface AcpAdapterOptions {
  /** Runtime id, `acp-<name>` (/^acp-[a-z][a-z0-9-]{0,31}$/). */
  id: string;
  displayName: string;
  /** Official icon (data URIs), e.g. from the ACP registry. */
  icon?: RuntimeIcon;
  /** The agent's argv; `command[0]` is resolved on PATH (or absolute). */
  command: string[];
  /** Merged over process.env. */
  env?: Record<string, string>;
  /** Offer (and accept) the `bypassPermissions` mode. Defaults to false. */
  allowBypass?: boolean;
  /**
   * How site tools reach the agent: `auto` declares the run's loopback MCP server as `http` when the
   * agent supports it, else through the stdio bridge; `off` disables site tools. Defaults to 'auto'.
   */
  mcp?: 'auto' | 'http' | 'stdio' | 'off';
  /** Shown when the command is not installed. */
  installHint?: string;
  installUrl?: string;
  /** Spawn + `initialize` timeout. Defaults to 15 s. */
  initTimeoutMs?: number;
  /** Timeout for session requests (not `session/prompt`). Defaults to 30 s. */
  requestTimeoutMs?: number;
  /** Timeout for `session/load`, which replays the whole history first. Defaults to 5 min. */
  loadTimeoutMs?: number;
  /** After `session/cancel`, kill the agent if the prompt has not resolved within this many ms. Defaults to 10 s. */
  cancelGraceMs?: number;
  /** `dispose()` waits this long for the agent to exit, then force-kills it and resolves. Defaults to 5 s. */
  disposeTimeoutMs?: number;
}

const ID_PATTERN = /^acp-[a-z][a-z0-9-]{0,31}$/;
const AUTH_REQUIRED = -32000;
const NOT_FOUND = -32002;

const DISCONNECTED: RuntimeEvent = { type: 'run.interrupted', reason: 'runtime_disconnected' };
const ABORTED_EVENT: RuntimeEvent = { type: 'run.interrupted', reason: 'aborted' };
const ABORTED = Symbol('aborted');

/** How much a permission mode allows without asking; an unknown agent mode counts as looser than any. */
const MODE_LOOSENESS: Record<string, number> = { default: 0, acceptEdits: 1, bypassPermissions: 2 };
const looseness = (mode: string): number => MODE_LOOSENESS[mode] ?? Number.POSITIVE_INFINITY;
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

/**
 * A `session/new` nobody waits for any more (timed out or aborted): if it still resolves, close
 * the session when the agent supports `session/close`; otherwise it is simply forgotten.
 */
function closeOrphan(agent: ClientContext, request: Promise<NewSessionResponse>, canClose: boolean): void {
  request
    .then((r) => (canClose ? agent.request(methods.agent.session.close, { sessionId: r.sessionId }) : undefined))
    .catch(() => undefined);
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
  const loadTimeoutMs = o.loadTimeoutMs ?? 300_000;
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

  const capabilities = (): RuntimeCapabilities => (init ? mapCapabilities(init, { allowBypass, mcp }) : defaultCapabilities({ allowBypass, mcp }));

  function authHint(): string {
    const names = (init?.authMethods ?? []).map((m) => m.name).filter(Boolean);
    return names.length
      ? `Sign in to ${o.displayName} (${names.join(' or ')}) in a terminal, then retry.`
      : `Sign in to ${o.displayName} in a terminal, then retry.`;
  }

  async function* run(input: AdapterRunInput, ctx: AdapterRunContext): AsyncGenerator<RuntimeEvent> {
    if (ctx.signal.aborted) return yield ABORTED_EVENT;
    const { permissionMode } = input.settings;
    if (permissionMode === 'bypassPermissions' && !allowBypass) return yield failed('policy_denied', 'bypassPermissions is not allowed on this server.');
    if (permissionMode !== 'default' && permissionMode !== 'acceptEdits' && permissionMode !== 'bypassPermissions') {
      return yield failed('invalid_request', `${o.displayName} does not support the ${permissionMode} permission mode.`);
    }
    const tools = mcp === 'off' ? [] : (input.tools ?? []);
    const siteToolNames: ReadonlySet<string> = new Set(tools.map((t) => t.name));
    // Skills are written on every run (the files must exist on resumed turns too); the preamble
    // that points at them goes into the first prompt of a new ACP session only.
    const skills = input.skills ?? [];
    let writtenSkills: MaterializedSkill[];
    try {
      writtenSkills = await materializeSkills(input.cwd, skills, ACP_SKILLS_ROOT);
    } catch (err) {
      return yield failed('invalid_request', `Could not write site skills: ${errorMessage(err)}`);
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
    let site: SiteMcpServer | undefined;
    let warnedNoAllowOnce = false;
    /** Answers of permission requests waiting for the user; answered `cancelled` on abort. */
    const pendingAnswers = new Set<(r: Promise<RequestPermissionResponse>) => void>();

    /**
     * `session/cancel` once, while the prompt is running; kills an agent that ignores it. Decided
     * now, sent after `before` (the answers to pending permissions go out first).
     */
    const cancelPrompt = (before: Promise<void> = Promise.resolve()): void => {
      if (!conn || conn.closed || sessionId === undefined || !prompt || promptSettled || cancelSent) return;
      cancelSent = true;
      const c = conn;
      const sid = sessionId;
      void before.then(() => c.proc.conn.agent.notify(methods.agent.session.cancel, { sessionId: sid })).catch(() => undefined);
      const timer = setTimeout(() => {
        if (!promptSettled && !c.closed) c.proc.kill();
      }, cancelGraceMs);
      timer.unref();
      void prompt.finally(() => clearTimeout(timer)).catch(() => undefined);
    };
    /** Answers every permission request still waiting (asked or queued) with `cancelled`. */
    const answerPending = (): void => {
      for (const respond of pendingAnswers) respond(Promise.resolve(CANCELLED));
      pendingAnswers.clear();
      for (const item of queue.drain()) {
        if (item.kind === 'permission') item.respond(Promise.resolve(CANCELLED));
        else queue.push(item);
      }
    };
    /** Pending permissions are answered `cancelled` first; `session/cancel` follows once those answers are written. */
    const stopTurn = (): void => {
      answerPending();
      cancelPrompt(settle());
    };
    const onAbort = (): void => {
      stopTurn();
      wake();
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    const askApproval = async (request: NativeApprovalInput, req: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> => {
      let outcome: ApprovalOutcome | typeof ABORTED;
      try {
        outcome = await untilAborted(ctx.requestApproval(request), AbortSignal.any([settled, signal]));
      } catch {
        // The approval could not be asked (e.g. the store failed): deny, never a JSON-RPC error.
        outcome = { decision: 'deny' };
      }
      if (outcome === ABORTED) return CANCELLED;
      if (outcome.decision !== 'allow') map.markDeclined(req.toolCall.toolCallId);
      return toPermissionResponse(outcome, req.options);
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
      const mcpServers: McpServer[] = [];
      if (tools.length > 0 && mcp !== 'off') {
        try {
          site = await startSiteMcpServer(tools, { requestApproval: (i) => ctx.requestApproval(i), cwd: input.cwd, signal: settled });
        } catch (err) {
          return yield failed('internal_error', `Could not serve the site tools: ${errorMessage(err)}`);
        }
        mcpServers.push(siteMcpDeclaration(site, agentCaps.mcpCapabilities, mcp));
      }
      const session = { cwd: input.cwd, mcpServers };
      /** The session's modes, to follow the Uncage permission mode with `session/set_mode`. */
      let modes: SessionModeState | null | undefined;
      /** A new ACP session (not resumed): its first prompt carries the skills preamble. */
      let fresh = false;
      const ref = input.nativeSessionRef;
      const canResume = Boolean(agentCaps.sessionCapabilities?.resume);
      const canLoad = agentCaps.loadSession === true;
      const canClose = Boolean(agentCaps.sessionCapabilities?.close);

      try {
        if (ref !== undefined && (canResume || canLoad)) {
          // Updates are routed by sessionId, so one turn per native session at a time. Core already
          // guarantees this (one active run per Uncage session, `session_busy`); this guards misuse.
          if (conn.sinks.has(ref)) return yield failed('session_busy', `A run is already active on ${o.displayName} session ${ref}.`);
          // Register before the request: `session/load` replays history (dropped) before it resolves.
          sink.replaying = !canResume;
          conn.sinks.set(ref, sink);
          sessionId = ref;
          const request = canResume
            ? agent.request(methods.agent.session.resume, { sessionId: ref, ...session })
            : agent.request(methods.agent.session.load, { sessionId: ref, ...session });
          // Replaying a long history can take a while: `session/load` gets its own, longer timeout.
          const timeout = canResume ? requestTimeoutMs : loadTimeoutMs;
          const r = await untilAborted(withTimeout(request, timeout, canResume ? 'session/resume' : 'session/load'), ctx.signal);
          if (r === ABORTED) return yield ABORTED_EVENT;
          modes = r.modes;
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
          let r: NewSessionResponse | typeof ABORTED;
          try {
            r = await untilAborted(withTimeout(request, requestTimeoutMs, 'session/new'), ctx.signal);
          } catch (err) {
            closeOrphan(agent, request, canClose);
            throw err;
          }
          if (r === ABORTED) {
            closeOrphan(agent, request, canClose);
            return yield ABORTED_EVENT;
          }
          sessionId = r.sessionId;
          modes = r.modes;
          fresh = true;
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

      // Follow the Uncage permission mode when the agent has a mode with the same id.
      if (modes && modes.currentModeId !== permissionMode && modes.availableModes.some((m) => m.id === permissionMode)) {
        try {
          const r = await untilAborted(
            withTimeout(agent.request(methods.agent.session.setMode, { sessionId: sid, modeId: permissionMode }), requestTimeoutMs, 'session/set_mode'),
            ctx.signal,
          );
          if (r === ABORTED) return yield ABORTED_EVENT;
        } catch (err) {
          const message = `${o.displayName} did not switch from ${modes.currentModeId} to ${permissionMode}: ${errorMessage(err)}`;
          // The agent would keep a looser mode than the website chose (and might not ask at all): refuse.
          if (looseness(modes.currentModeId) > looseness(permissionMode)) return yield failed('policy_denied', message);
          // Same or stricter: the agent asks at least as often; Uncage applies the mode to what it is asked.
          yield { type: 'warning', code: 'acp_set_mode_failed', message };
        }
      } else if (
        modes &&
        modes.currentModeId !== permissionMode &&
        MODE_LOOSENESS[modes.currentModeId] !== undefined &&
        looseness(modes.currentModeId) > looseness(permissionMode)
      ) {
        // The agent (e.g. a resumed session) sits in a known looser mode and offers no way back to the
        // website's mode: refuse, like a failed set_mode. Unknown agent modes keep the ruling above.
        return yield failed('policy_denied', `${o.displayName} is in ${modes.currentModeId} mode and offers no ${permissionMode} mode to switch to.`);
      }

      let blocks;
      try {
        blocks = await toPromptBlocks(input, { image: agentCaps.promptCapabilities?.image === true });
      } catch (err) {
        return yield failed('internal_error', `Could not read an attachment: ${errorMessage(err)}`);
      }
      const preamble = fresh ? skillsPreamble(skills, writtenSkills) : '';
      if (preamble) blocks.unshift({ type: 'text', text: preamble });
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
          case 'permission': {
            for (const e of map.ensureTool(item.req.toolCall)) yield e;
            const d = permissionDecision(item.req, {
              mode: permissionMode,
              allowBypass,
              siteToolNames,
              cwd: input.cwd,
              known: map.tool(item.req.toolCall.toolCallId),
            });
            if ('ask' in d) {
              const respond = item.respond;
              pendingAnswers.add(respond);
              void askApproval(d.ask, item.req, item.signal).then((r) => {
                // Already answered `cancelled` (abort or end of run): never answer twice.
                if (!pendingAnswers.delete(respond)) return;
                respond(Promise.resolve(r));
              });
            } else if (d.auto === 'allow') {
              item.respond(Promise.resolve(toPermissionResponse('allow', item.req.options)));
            } else {
              item.respond(Promise.resolve(CANCELLED));
              if (!warnedNoAllowOnce) {
                warnedNoAllowOnce = true;
                yield { type: 'warning', code: NO_ALLOW_ONCE_WARNING, message: d.warning };
              }
            }
            continue;
          }
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
      // Aborted, or the consumer stopped early: answer what is pending, then stop the turn so the
      // agent does not keep working.
      stopTurn();
      done.abort();
      if (conn && sessionId !== undefined && conn.sinks.get(sessionId) === sink) conn.sinks.delete(sessionId);
      // The site tools live as long as the run.
      await site?.close();
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
    ...(o.icon ? { icon: o.icon } : {}),
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
      // Bounded: on Windows a grandchild holding the pipes could otherwise keep this waiting forever.
      await stopAcpProcess(conn.proc, o.disposeTimeoutMs ?? 5_000);
    },
  };
}
