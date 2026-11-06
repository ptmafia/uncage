import type { UncageEvent } from '@uncage/protocol';
import type { SessionHandle } from './sessions.js';

/** Reads the session's event stream (replay + live) until `until` matches; returns everything seen. */
export async function eventsUntil(
  session: SessionHandle,
  until: (e: UncageEvent) => boolean,
  opts: { after?: number; timeoutMs?: number } = {},
): Promise<UncageEvent[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 3000);
  const seen: UncageEvent[] = [];
  try {
    for await (const e of session.events({ after: opts.after ?? 0, signal: ac.signal })) {
      seen.push(e);
      if (until(e)) return seen;
    }
  } finally {
    clearTimeout(timer);
  }
  throw new Error(`timed out; saw: ${seen.map((e) => e.type).join(', ')}`);
}

export const isTerminal = (e: UncageEvent): boolean =>
  e.type === 'run.completed' || e.type === 'run.failed' || e.type === 'run.cancelled' || e.type === 'run.interrupted';
