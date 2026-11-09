import type { UncageEvent } from '@uncage/protocol';
import type { HubLogger } from './machines.js';
import type { HubStore, MachineRecord, SessionRecord } from './store/store.js';

/** Something on a user's computer needs them (an approval) or finished: what `onAttention` gets. */
export type AttentionEvent = {
  kind: 'approval_requested' | 'run_completed' | 'run_failed';
  userId: string;
  sessionId: string;
  sessionTitle?: string;
  machineId: string;
  machineName?: string;
  /** The session's runtime id (`claude`, `codex`, …) when known. */
  runtime?: string;
  approval?: { id: string; title: string; kind: string };
  /** When it happened on the machine (the event's `occurredAt`). */
  at: string;
};

export type WaitUntil = (p: Promise<unknown>) => void;

export type OnAttention = (e: AttentionEvent, ctx: { waitUntil(p: Promise<unknown>): void }) => void | Promise<void>;

/** A claim lasts a day: far beyond any agent resend or backfill window (stale events are skipped anyway). */
export const ATTENTION_DEDUPE_TTL_SEC = 86_400;
/** Events older than this (an agent backfilling after a reconnect) never notify. */
export const ATTENTION_STALE_MS = 10 * 60_000;
/** Per-node dedupe keys kept when the store has no `claimOnce`. */
export const ATTENTION_LRU_MAX = 10_000;

const KIND: Partial<Record<UncageEvent['type'], AttentionEvent['kind']>> = {
  'approval.requested': 'approval_requested',
  'run.completed': 'run_completed',
  'run.failed': 'run_failed',
};

/**
 * Turns ingested events into `onAttention` calls: once per `sessionId:sequence:kind` (through
 * `store.claimOnce`, else a per-node LRU), never for stale events or approvals already answered,
 * never blocking or failing ingest (errors go to the logger), under the request's `waitUntil`.
 */
export function attentionDispatcher(d: {
  store: HubStore;
  onAttention: OnAttention | undefined;
  logger: HubLogger;
  sessionStorage: 'machine' | 'site';
  now?: () => number;
}) {
  const now = d.now ?? Date.now;
  const seen = new Map<string, true>();
  const pending = new Set<Promise<unknown>>();

  async function claim(key: string): Promise<boolean> {
    if (d.store.claimOnce) return d.store.claimOnce(key, { ttlSec: ATTENTION_DEDUPE_TTL_SEC, now: new Date(now()).toISOString() });
    if (seen.has(key)) {
      seen.delete(key);
      seen.set(key, true);
      return false;
    }
    seen.set(key, true);
    if (seen.size > ATTENTION_LRU_MAX) seen.delete(seen.keys().next().value!);
    return true;
  }

  /** Site mode: the approval is still pending in the stored snapshot (read now, so a later answer counts). */
  async function stillPending(sessionId: string, approvalId: string): Promise<boolean> {
    if (d.sessionStorage !== 'site') return true;
    const snap = (await d.store.getSession(sessionId))?.snapshot;
    return !snap || snap.pendingApprovals.some((a) => a.id === approvalId);
  }

  async function deliver(e: AttentionEvent, sequence: number, waitUntil: WaitUntil): Promise<void> {
    if (!(await claim(`${e.sessionId}:${sequence}:${e.kind}`))) return;
    // Checked last, so an answer stored meanwhile (e.g. while the claim was in flight) counts.
    if (e.approval && !(await stillPending(e.sessionId, e.approval.id))) return;
    await d.onAttention!(e, { waitUntil });
  }

  /** Attention events of an accepted batch, in order (not yet deduped). */
  function collect(machine: MachineRecord, rec: SessionRecord, events: UncageEvent[]): Array<{ e: AttentionEvent; sequence: number }> {
    const out: Array<{ e: AttentionEvent; sequence: number }> = [];
    let title = rec.title;
    let runtime = rec.runtime ?? rec.snapshot?.session?.runtimeId;
    /** Approvals answered later in this batch (machine mode has no stored snapshot to ask). */
    const answered = new Set<string>();
    for (const e of events) {
      if ((e.type === 'approval.updated' || e.type === 'approval.resolved') && e.payload.approval.state !== 'pending' && e.payload.approval.state !== 'submitting') {
        answered.add(e.payload.approval.id);
      }
    }
    const cutoff = now() - ATTENTION_STALE_MS;
    for (const e of events) {
      if (e.type === 'session.created' || e.type === 'session.updated') {
        title = e.payload.session.title;
        runtime = e.payload.session.runtimeId;
        continue;
      }
      const kind = KIND[e.type];
      if (!kind) continue;
      const t = Date.parse(e.occurredAt);
      if (!(t >= cutoff)) continue;
      let approval: AttentionEvent['approval'];
      if (e.type === 'approval.requested') {
        const a = e.payload.approval;
        if (answered.has(a.id)) continue;
        approval = { id: a.id, title: a.title, kind: a.category };
        runtime ??= a.runtimeId;
      }
      out.push({
        sequence: e.sequence,
        e: {
          kind,
          userId: rec.userId,
          sessionId: rec.id,
          ...(title ? { sessionTitle: title } : {}),
          machineId: machine.id,
          ...(machine.name ? { machineName: machine.name } : {}),
          ...(runtime ? { runtime } : {}),
          ...(approval ? { approval } : {}),
          at: e.occurredAt,
        },
      });
    }
    return out;
  }

  return {
    /** Called after ingest accepted `events`; returns at once. */
    fire(machine: MachineRecord, rec: SessionRecord, events: UncageEvent[], waitUntil?: WaitUntil): void {
      if (!d.onAttention || events.length === 0) return;
      let items: Array<{ e: AttentionEvent; sequence: number }>;
      try {
        items = collect(machine, rec, events);
      } catch (err) {
        d.logger.error({ err, sessionId: rec.id }, 'onAttention failed');
        return;
      }
      for (const { e, sequence } of items) {
        /** Work the handler hands off: to the platform when there is a request context, else kept here. */
        const handOff: WaitUntil = (p) => {
          const guarded = Promise.resolve(p).catch((err: unknown) => d.logger.error({ err, sessionId: e.sessionId }, 'onAttention waitUntil work failed'));
          if (waitUntil) {
            try {
              waitUntil(guarded);
              return;
            } catch {
              // e.g. an unbound ctx.waitUntil: keep it in-process
            }
          }
          track(guarded);
        };
        const guarded = deliver(e, sequence, handOff).catch((err: unknown) => d.logger.error({ err, sessionId: e.sessionId, kind: e.kind }, 'onAttention failed'));
        track(guarded);
        if (waitUntil) {
          try {
            waitUntil(guarded);
          } catch (err) {
            d.logger.warn({ err }, 'waitUntil threw; onAttention runs without it');
          }
        }
      }
    },
    /** Waits (at most `ms`) for deliveries still running (`hub.close()`). */
    async idle(ms: number): Promise<void> {
      if (pending.size === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled([...pending]), new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
      clearTimeout(timer);
    },
  };

  function track(p: Promise<unknown>): void {
    pending.add(p);
    void p.finally(() => pending.delete(p));
  }
}
