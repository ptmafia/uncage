/**
 * Site tool calls with store-backed state (spec §5.9 item 5):
 *
 * - **Exactly-once on a connection drop.** A call is claimed in the store (`claimToolCall`) under
 *   the machine's call id before its handler runs, and its `tool_result` is stored when it ends. A
 *   resent call (HTTP retry, WebSocket resend after reconnecting) gets the stored result (`done`),
 *   or nothing while it still runs elsewhere (`running`: the result follows). A dropped connection
 *   does not abort the handler.
 * - **At-most-once on an instance kill.** The claim carries a lease (`toolTimeoutMs +
 *   leaseGraceMs`); a running call whose lease ran out belonged to an instance that died. It is
 *   finished as `interrupted` with `TOOL_INTERRUPTED_MESSAGE` — by the next resend (`stale`) or by
 *   the maintenance sweep (`interruptStale`, which delivers the error to the machine) — and never
 *   run again.
 * - **Run end anywhere** aborts the handler: the call listens on its session's cluster channel for
 *   its run's end event, whichever instance ingested it.
 */
import { UncageError } from '@uncage/core/errors';
import { MAX_FRAME_BYTES, type AgentFrame, type ToolCallResult, type ToolSpec, type UncageEvent } from '@uncage/protocol';
import type { ClusterAdapter } from './cluster/cluster.js';
import { DEFAULT_PULL_MAX_BYTES, DEFAULT_READ_MAX_BYTES, filePull } from './files.js';
import { sessionChannel, type HubLogger, type MachineHub } from './machines.js';
import type { HubStore, MachineRecord, ToolCallRecord, ToolCallStatus, ToolResultFrame } from './store/store.js';
import type { ToolContext, ToolExecutor } from './tools.js';
import { randomHex, unrefTimer, utf8Length } from './web.js';

/** The error a call gets when the instance running its handler died (`details.reason: 'interrupted'`). */
export const TOOL_INTERRUPTED_MESSAGE = (tool: string): string => `Site tool "${tool}" timed out on the website. Please try again.`;

/** Run-end event types: a call of a run that ended is abandoned. */
export const RUN_END = new Set(['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted']);
/** A `tool_result` must fit one frame with room for the envelope. */
const TOOL_RESULT_BUDGET = MAX_FRAME_BYTES - 16 * 1024;
/** Tool arguments larger than this are not stored in the audit table. */
const MAX_AUDIT_ARGS_BYTES = 16 * 1024;
/** Stale calls finished per maintenance run. */
const STALE_BATCH = 200;

/**
 * `./a//b/` → `a/b`: the machine's file paths are workspace-relative with single forward slashes.
 * Paths that leave the workspace are refused here (the machine refuses them too).
 */
export function normalizeWorkspacePath(p: string): string {
  const refuse = () => new UncageError('invalid_request', { message: `"${p}" is not a path inside the session workspace.` });
  const s = p.replace(/\\/g, '/');
  if (s.startsWith('/')) throw refuse();
  // Resolve `.` and `..` segment by segment (like `posix.normalize`); climbing above the root is refused.
  const out: string[] = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) throw refuse();
      out.pop();
    } else out.push(seg);
  }
  if (out.length === 0) throw refuse();
  return out.join('/');
}

const interruptedFrame = (rec: Pick<ToolCallRecord, 'callId' | 'tool'>): ToolResultFrame => ({
  t: 'tool_result',
  id: rec.callId,
  ok: false,
  error: new UncageError('tool_failed', { message: TOOL_INTERRUPTED_MESSAGE(rec.tool), details: { reason: 'interrupted' } }).toBody(),
});

export interface ToolCallsDeps {
  store: HubStore;
  machines: MachineHub;
  cluster: ClusterAdapter;
  executor: ToolExecutor;
  tools: Map<string, ToolSpec>;
  toolTimeoutMs: number;
  /** The claim's lease outlives the handler's timeout by this much (`HubInternals.toolLeaseGraceMs`). */
  leaseGraceMs: number;
  /** How long a call for a run whose startRun result is still in flight waits for it. */
  runIndexWaitMs: number;
  /** Handlers one machine may have running on this instance; a new call over it fails with `too_many_concurrent`. */
  maxConcurrentToolCalls: number;
  logger: HubLogger;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A finished call's stored result; one pruned by retention (or never stored) is rebuilt generically. */
const finishedResult = (rec: ToolCallRecord): ToolResultFrame =>
  rec.result ?? {
    t: 'tool_result',
    id: rec.callId,
    ok: false,
    error: new UncageError('tool_failed', { message: rec.errorMessage ?? `Site tool "${rec.tool}" already finished (${rec.status}).` }).toBody(),
  };

export function toolCalls(d: ToolCallsDeps): {
  /** Claims, executes (once), stores and delivers the result. Resolves the tool_result to reply on the calling link, or null (running elsewhere: agent retries). */
  handle(machine: MachineRecord, call: Extract<AgentFrame, { t: 'tool_call' }>): Promise<ToolResultFrame | null>;
  /** Maintenance task: running calls past their lease are finished as interrupted and the error delivered. */
  interruptStale(): Promise<number>;
  /** A run of `machineId` ended (events ingested on this instance): abandons its calls running here. */
  runEnded(machineId: string, runId: string): void;
  /**
   * The hub is closing: lets running handlers finish for up to `drainMs`, then aborts the rest; they
   * are finished as interrupted (at-most-once, like an instance stop).
   */
  close(drainMs: number): Promise<void>;
} {
  const { store, machines, logger } = d;
  /** Calls executing on this instance (local fast path of run end; the channel covers the rest). */
  const active = new Set<{ machineId: string; runId: string; abort(): void; done: Promise<void> }>();
  /** Handlers running on this instance per machine (the concurrency cap). */
  const running = new Map<string, number>();
  const stopping = new AbortController();

  /** Finishes a stale call as interrupted; resolves its frame if this caller won the compare-and-set. */
  async function interrupt(rec: ToolCallRecord): Promise<ToolResultFrame | null> {
    const frame = interruptedFrame(rec);
    const won = await store.finishToolCall(rec.id, {
      status: 'interrupted',
      errorCode: 'tool_failed',
      errorMessage: TOOL_INTERRUPTED_MESSAGE(rec.tool),
      finishedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - Date.parse(rec.startedAt)),
      result: frame,
    });
    return won ? frame : null;
  }

  async function handle(machine: MachineRecord, call: Extract<AgentFrame, { t: 'tool_call' }>): Promise<ToolResultFrame | null> {
    const fail = (e: UncageError): ToolResultFrame => ({ t: 'tool_result', id: call.id, ok: false, error: e.toBody() });
    // A resend of a call that already finished gets its stored result first, whatever changed since
    // (the cap, the session, the run): the machine's own call id, so nothing else is checked.
    const existing = await store.getToolCall(machine.id, call.id);
    if (existing && existing.status !== 'running') return finishedResult(existing);

    const rec = await store.getSession(call.sessionId);
    // The session must be this machine's, and its owner the machine's user (ctx.user).
    if (!rec || rec.machineId !== machine.id || rec.userId !== machine.userId) {
      return fail(new UncageError('not_found', { message: `Session ${call.sessionId} not found.` }));
    }
    // Only runs started through this hub, and only the tools their manifest offered. The startRun
    // result (which binds the run id) may still be in flight: wait for it briefly.
    let runTools = await store.getRunTools(call.runId);
    for (const until = Date.now() + d.runIndexWaitMs; !runTools && Date.now() < until && !stopping.signal.aborted; ) {
      await sleep(50);
      runTools = await store.getRunTools(call.runId);
    }
    if (!runTools || runTools.sessionId !== rec.id) {
      return fail(new UncageError('not_found', { message: `Run ${call.runId} not found.`, details: { reason: 'run_not_indexed' } }));
    }
    if (!d.tools.has(call.tool) || !runTools.tools.includes(call.tool)) {
      return fail(new UncageError('tool_failed', { message: `Site tool "${call.tool}" is not available in this run.`, details: { reason: 'not_in_manifest' } }));
    }
    // The cap only refuses calls that would start a handler (a known call is answered or interrupted
    // without one). Not stored: the call never ran.
    const machineId = machine.id;
    const n = running.get(machineId) ?? 0;
    if (!existing && n >= d.maxConcurrentToolCalls) {
      return fail(new UncageError('tool_failed', { message: `Too many site tool calls at once (at most ${d.maxConcurrentToolCalls}).`, details: { reason: 'too_many_concurrent' } }));
    }
    running.set(machineId, n + 1);
    try {
      return await claimAndRun(machine, call, rec.id, rec.userId);
    } finally {
      const left = (running.get(machineId) ?? 1) - 1;
      if (left > 0) running.set(machineId, left);
      else running.delete(machineId);
    }
  }

  async function claimAndRun(machine: MachineRecord, call: Extract<AgentFrame, { t: 'tool_call' }>, sessionId: string, userId: string): Promise<ToolResultFrame | null> {
    const fail = (e: UncageError): ToolResultFrame => ({ t: 'tool_result', id: call.id, ok: false, error: e.toBody() });
    const ac = new AbortController();
    let why: 'timeout' | 'cancelled' | 'shutdown' | undefined;
    const abort = (reason: 'timeout' | 'cancelled' | 'shutdown') => {
      why ??= reason;
      ac.abort();
    };
    // Listen for run end (published on the session channel by whichever instance ingested it)
    // before claiming, so a run that ends while the call is being claimed is not missed.
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = await d.cluster.subscribe(sessionChannel(sessionId), (raw) => {
        try {
          const { events } = JSON.parse(raw) as { events?: UncageEvent[] };
          if (events?.some((e) => RUN_END.has(e.type) && e.runId === call.runId)) abort('cancelled');
        } catch {
          // not an events message
        }
      });
    } catch (err) {
      logger.error({ err, sessionId }, 'session channel subscribe failed; run end on other instances will not abort this tool call');
    }
    let settle!: () => void;
    const entry = { machineId: machine.id, runId: call.runId, abort: () => abort('cancelled'), done: new Promise<void>((r) => (settle = r)) };
    active.add(entry);
    try {
      return await claimed();
    } finally {
      active.delete(entry);
      settle();
      unsubscribe?.();
    }

    async function claimed(): Promise<ToolResultFrame | null> {
      // Claim the call: the store decides whether it runs here, ran already, or runs elsewhere.
      const auditId = `tcl_${randomHex(12)}`;
      const startedAt = Date.now();
      const leaseEnd = startedAt + d.toolTimeoutMs + d.leaseGraceMs;
      const argsJson = JSON.stringify(call.args ?? null);
      const record: ToolCallRecord = {
        id: auditId,
        callId: call.id,
        sessionId,
        runId: call.runId,
        userId,
        machineId: machine.id,
        tool: call.tool,
        args: utf8Length(argsJson) <= MAX_AUDIT_ARGS_BYTES ? (call.args ?? null) : null,
        status: 'running',
        startedAt: new Date(startedAt).toISOString(),
      };
      const claim = () => store.claimToolCall(record, { leaseUntil: new Date(leaseEnd).toISOString(), now: new Date().toISOString() });
      let c = await claim();
      if (c.kind === 'stale') {
        // Its instance died mid-handler: fail it (at-most-once), never run it again.
        const frame = await interrupt(c.record);
        if (frame) return frame;
        c = await claim(); // someone else finished it meanwhile: answer with that
      }
      if (c.kind === 'done') return c.record.result;
      if (c.kind !== 'new') return null; // running elsewhere: its result follows

      /** The stored outcome of this call (after a lost compare-and-set), retried like the write. */
      const storedOutcome = async (): Promise<ToolResultFrame | null> => {
        for (let delay = 50; ; delay = Math.min(delay * 2, 1_000)) {
          try {
            const now = await store.getToolCall(machine.id, call.id);
            return now && now.status !== 'running' ? finishedResult(now) : null;
          } catch (e) {
            logger.error({ err: e, tool: call.tool }, 'tool-call outcome could not be read');
            if (Date.now() + delay >= leaseEnd) return null;
            await sleep(delay);
          }
        }
      };
      /**
       * A result is sent only once it is stored: the stored row is the call's one outcome. A failed
       * write is retried with backoff until the lease ends; a lost compare-and-set (the call was
       * interrupted meanwhile) answers with the stored outcome. If the write never succeeds,
       * nothing is sent — the row stays running, and once its lease ends a resend or the sweep
       * finishes it as interrupted, the only result the machine ever sees.
       */
      const finish = async (status: ToolCallStatus, result: ToolResultFrame, err?: { code?: string; message?: string }): Promise<ToolResultFrame | null> => {
        for (let delay = 50; ; delay = Math.min(delay * 2, 1_000)) {
          try {
            const ok = await store.finishToolCall(auditId, {
              status,
              ...(err?.code ? { errorCode: err.code } : {}),
              ...(err?.message ? { errorMessage: err.message.slice(0, 2000) } : {}),
              finishedAt: new Date().toISOString(),
              durationMs: Date.now() - startedAt,
              result,
            });
            // Lost (also: an earlier attempt committed but its reply was lost): the stored row decides.
            return ok ? result : await storedOutcome();
          } catch (e) {
            logger.error({ err: e, tool: call.tool }, 'tool-call result could not be stored; retrying');
            if (Date.now() + delay >= leaseEnd) return null;
            await sleep(delay);
          }
        }
      };

      const onStop = () => abort('shutdown');
      stopping.signal.addEventListener('abort', onStop, { once: true });
      if (stopping.signal.aborted) abort('shutdown');
      const timer = setTimeout(() => abort('timeout'), d.toolTimeoutMs);
      unrefTimer(timer);
      const files: ToolContext['files'] = {
        pull: (raw, opts) =>
          filePull(async () => {
            const path = normalizeWorkspacePath(raw);
            const max = opts?.maxBytes ?? DEFAULT_PULL_MAX_BYTES;
            if (!Number.isInteger(max) || max < 1) throw new UncageError('invalid_request', { message: 'maxBytes must be a positive integer.' });
            return machines.pull(machine.id, sessionId, path, Math.min(max, DEFAULT_PULL_MAX_BYTES), ac.signal);
          }),
        read: async (raw) => {
          const path = normalizeWorkspacePath(raw);
          let r;
          try {
            r = await machines.pull(machine.id, sessionId, path, DEFAULT_READ_MAX_BYTES, ac.signal);
          } catch (err) {
            if (err instanceof UncageError && err.code === 'not_found') {
              throw new UncageError('not_found', { message: `"${path}" does not exist in the session workspace.` });
            }
            throw err;
          }
          const f = r.files.length === 1 && r.files[0]!.path === path ? r.files[0]! : undefined;
          if (!f) throw new UncageError('invalid_request', { message: `"${path}" is a directory, not a file.`, details: { reason: 'is_directory' } });
          return f.data;
        },
      };
      const abandoned = new Promise<never>((_, reject) => {
        if (ac.signal.aborted) reject(new UncageError('tool_failed'));
        else ac.signal.addEventListener('abort', () => reject(new UncageError('tool_failed')), { once: true });
      });
      abandoned.catch(() => undefined);
      try {
        const result: ToolCallResult = await Promise.race([
          d.executor.execute(
            { user: { id: userId }, machineId: machine.id, sessionId, runId: call.runId, tool: call.tool, args: call.args, callId: call.id },
            { signal: ac.signal, files },
          ),
          abandoned,
        ]);
        const frame: ToolResultFrame = { t: 'tool_result', id: call.id, ok: true, result };
        const bytes = utf8Length(JSON.stringify(frame));
        if (bytes > TOOL_RESULT_BUDGET) {
          const e = new UncageError('tool_failed', { message: `The result of site tool "${call.tool}" is too large (${bytes} bytes, max ${TOOL_RESULT_BUDGET}).` });
          return await finish('error', fail(e), e);
        }
        return await finish(result.isError ? 'error' : 'ok', frame);
      } catch (err) {
        if (why === 'cancelled') {
          // The run ended: the machine no longer waits for it. Stored so a resend gets an answer.
          await finish('cancelled', fail(new UncageError('tool_failed', { message: `Site tool "${call.tool}" was cancelled.` })));
          return null;
        }
        if (why === 'shutdown') {
          return finish('interrupted', interruptedFrame({ callId: call.id, tool: call.tool }), { code: 'tool_failed', message: TOOL_INTERRUPTED_MESSAGE(call.tool) });
        }
        if (why === 'timeout') {
          const e = new UncageError('tool_failed', { message: `Site tool "${call.tool}" did not finish within ${Math.round(d.toolTimeoutMs / 1000)} s.` });
          return await finish('timeout', fail(e), e);
        }
        const e = err instanceof UncageError ? err : new UncageError('tool_failed', { message: err instanceof Error ? err.message : String(err) });
        return await finish(e.code === 'invalid_request' ? 'invalid' : 'error', fail(e), e);
      } finally {
        clearTimeout(timer);
        stopping.signal.removeEventListener('abort', onStop);
        ac.abort();
      }
    }
  }

  async function interruptStale(): Promise<number> {
    const stale = await store.listStaleToolCalls(new Date().toISOString(), STALE_BATCH);
    let n = 0;
    for (const rec of stale) {
      const frame = await interrupt(rec);
      if (!frame) continue; // finished meanwhile
      n++;
      await machines.deliver(rec.machineId, frame).catch((err: unknown) => {
        if (!(err instanceof UncageError && err.code === 'machine_offline')) logger.error({ err, machineId: rec.machineId }, 'interrupted tool result delivery failed');
      });
    }
    return n;
  }

  return {
    handle,
    interruptStale,
    runEnded(machineId, runId) {
      for (const call of active) if (call.machineId === machineId && call.runId === runId) call.abort();
    },
    async close(drainMs) {
      const all = Promise.all([...active].map((c) => c.done));
      if (active.size > 0 && drainMs > 0) {
        let t: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([all, new Promise<void>((r) => (t = setTimeout(r, drainMs)))]);
        clearTimeout(t);
      }
      stopping.abort();
      // Aborted handlers store their interrupted outcome (bounded by the store's own timeouts).
      await Promise.race([all, sleep(1_000)]);
    },
  };
}
