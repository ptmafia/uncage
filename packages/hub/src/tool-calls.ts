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
  logger: HubLogger;
  /** The hub is closing: running handlers are aborted and their calls finished as interrupted. */
  shutdown?: AbortSignal;
}

export function toolCalls(d: ToolCallsDeps): {
  /** Claims, executes (once), stores and delivers the result. Resolves the tool_result to reply on the calling link, or null (running elsewhere: agent retries). */
  handle(machine: MachineRecord, call: Extract<AgentFrame, { t: 'tool_call' }>): Promise<ToolResultFrame | null>;
  /** Maintenance task: running calls past their lease are finished as interrupted and the error delivered. */
  interruptStale(): Promise<number>;
  /** A run of `machineId` ended (events ingested on this instance): abandons its calls running here. */
  runEnded(machineId: string, runId: string): void;
} {
  const { store, machines, logger } = d;
  /** Calls executing on this instance (local fast path of run end; the channel covers the rest). */
  const active = new Set<{ machineId: string; runId: string; abort(): void }>();

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
    const rec = await store.getSession(call.sessionId);
    // The session must be this machine's, and its owner the machine's user (ctx.user).
    if (!rec || rec.machineId !== machine.id || rec.userId !== machine.userId) {
      return fail(new UncageError('not_found', { message: `Session ${call.sessionId} not found.` }));
    }
    // Only runs started through this hub, and only the tools their manifest offered. The startRun
    // result (which binds the run id) may still be in flight: wait for it briefly.
    let runTools = await store.getRunTools(call.runId);
    for (const until = Date.now() + d.runIndexWaitMs; !runTools && Date.now() < until && !d.shutdown?.aborted; ) {
      await new Promise((r) => setTimeout(r, 50));
      runTools = await store.getRunTools(call.runId);
    }
    if (!runTools || runTools.sessionId !== rec.id) {
      return fail(new UncageError('not_found', { message: `Run ${call.runId} not found.`, details: { reason: 'run_not_indexed' } }));
    }
    if (!d.tools.has(call.tool) || !runTools.tools.includes(call.tool)) {
      return fail(new UncageError('tool_failed', { message: `Site tool "${call.tool}" is not available in this run.`, details: { reason: 'not_in_manifest' } }));
    }

    // Claim the call: the store decides whether it runs here, ran already, or runs elsewhere.
    const auditId = `tcl_${randomHex(12)}`;
    const startedAt = Date.now();
    const argsJson = JSON.stringify(call.args ?? null);
    const record: ToolCallRecord = {
      id: auditId,
      callId: call.id,
      sessionId: rec.id,
      runId: call.runId,
      userId: rec.userId,
      machineId: machine.id,
      tool: call.tool,
      args: utf8Length(argsJson) <= MAX_AUDIT_ARGS_BYTES ? (call.args ?? null) : null,
      status: 'running',
      startedAt: new Date(startedAt).toISOString(),
    };
    const claimed = async () =>
      store.claimToolCall(record, { leaseUntil: new Date(Date.now() + d.toolTimeoutMs + d.leaseGraceMs).toISOString(), now: new Date().toISOString() });
    let claim = await claimed();
    if (claim.kind === 'stale') {
      // Its instance died mid-handler: fail it (at-most-once), never run it again.
      const frame = await interrupt(claim.record);
      if (frame) return frame;
      claim = await claimed(); // someone else finished it meanwhile: answer with that
    }
    if (claim.kind === 'done') return claim.record.result;
    if (claim.kind !== 'new') return null; // running elsewhere: its result follows

    const ac = new AbortController();
    let why: 'timeout' | 'cancelled' | 'shutdown' | undefined;
    const abort = (reason: 'timeout' | 'cancelled' | 'shutdown') => {
      why ??= reason;
      ac.abort();
    };
    const entry = { machineId: machine.id, runId: call.runId, abort: () => abort('cancelled') };
    active.add(entry);
    const onShutdown = () => abort('shutdown');
    d.shutdown?.addEventListener('abort', onShutdown, { once: true });
    if (d.shutdown?.aborted) abort('shutdown');
    const timer = setTimeout(() => abort('timeout'), d.toolTimeoutMs);
    unrefTimer(timer);
    // Run end on any instance: its events are published on the session channel after ingestion.
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = await d.cluster.subscribe(sessionChannel(rec.id), (raw) => {
        try {
          const { events } = JSON.parse(raw) as { events?: UncageEvent[] };
          if (events?.some((e) => RUN_END.has(e.type) && e.runId === call.runId)) abort('cancelled');
        } catch {
          // not an events message
        }
      });
    } catch (err) {
      logger.error({ err, sessionId: rec.id }, 'session channel subscribe failed; run end on other instances will not abort this tool call');
    }

    /** Stores the outcome; if the call was meanwhile interrupted (lease over), answers with that instead. */
    const finish = async (status: ToolCallStatus, result: ToolResultFrame, err?: { code?: string; message?: string }): Promise<ToolResultFrame> => {
      try {
        const ok = await store.finishToolCall(auditId, {
          status,
          ...(err?.code ? { errorCode: err.code } : {}),
          ...(err?.message ? { errorMessage: err.message.slice(0, 2000) } : {}),
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          result,
        });
        if (ok) return result;
        const now = await claimed();
        return now.kind === 'done' ? now.record.result : result;
      } catch (e) {
        logger.error({ err: e, tool: call.tool }, 'tool-call result could not be stored');
        return result;
      }
    };

    const files: ToolContext['files'] = {
      pull: (raw, opts) =>
        filePull(async () => {
          const path = normalizeWorkspacePath(raw);
          const max = opts?.maxBytes ?? DEFAULT_PULL_MAX_BYTES;
          if (!Number.isInteger(max) || max < 1) throw new UncageError('invalid_request', { message: 'maxBytes must be a positive integer.' });
          return machines.pull(machine.id, rec.id, path, Math.min(max, DEFAULT_PULL_MAX_BYTES), ac.signal);
        }),
      read: async (raw) => {
        const path = normalizeWorkspacePath(raw);
        let r;
        try {
          r = await machines.pull(machine.id, rec.id, path, DEFAULT_READ_MAX_BYTES, ac.signal);
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
    const abandoned = new Promise<never>((_, reject) =>
      ac.signal.addEventListener('abort', () => reject(new UncageError('tool_failed')), { once: true }),
    );
    abandoned.catch(() => undefined);
    try {
      const result: ToolCallResult = await Promise.race([
        d.executor.execute(
          { user: { id: rec.userId }, machineId: machine.id, sessionId: rec.id, runId: call.runId, tool: call.tool, args: call.args, callId: call.id },
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
        const frame = interruptedFrame({ callId: call.id, tool: call.tool });
        return finish('interrupted', frame, { code: 'tool_failed', message: TOOL_INTERRUPTED_MESSAGE(call.tool) });
      }
      if (why === 'timeout') {
        const e = new UncageError('tool_failed', { message: `Site tool "${call.tool}" did not finish within ${Math.round(d.toolTimeoutMs / 1000)} s.` });
        return await finish('timeout', fail(e), e);
      }
      const e = err instanceof UncageError ? err : new UncageError('tool_failed', { message: err instanceof Error ? err.message : String(err) });
      return await finish(e.code === 'invalid_request' ? 'invalid' : 'error', fail(e), e);
    } finally {
      clearTimeout(timer);
      active.delete(entry);
      d.shutdown?.removeEventListener('abort', onShutdown);
      unsubscribe?.();
      ac.abort();
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
  };
}
