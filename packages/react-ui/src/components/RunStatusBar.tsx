import { useApprovals, useRun } from '@uncage/react';
import type { JSX } from 'react';
import { useNow, useUi } from '../context.js';

/**
 * One quiet line above the composer about the latest run: "Running · 12s · 1 waiting for you"
 * while active, honest copy once it ends. Renders nothing before the first run.
 */
export function RunStatusBar(): JSX.Element | null {
  const { t } = useUi();
  const { run, isActive } = useRun();
  const { pending } = useApprovals();
  const now = useNow(isActive);
  if (!run) return null;

  const start = Date.parse(run.startedAt ?? run.createdAt);
  const end = run.endedAt ? Date.parse(run.endedAt) : now;
  const elapsed = t.elapsed(end - start);
  const waiting = pending.filter((a) => a.runId === run.id).length;

  let tone: 'active' | 'muted' | 'warn' | 'err' = 'muted';
  let label: string;
  switch (run.state) {
    case 'queued':
      tone = 'active';
      label = t.queued;
      break;
    case 'running':
    case 'waiting_approval':
      tone = 'active';
      label = t.running;
      break;
    case 'completed':
      label = t.runDone(elapsed);
      break;
    case 'cancelled':
      label = t.runCancelled;
      break;
    case 'interrupted':
      tone = 'warn';
      label = t.runInterrupted;
      break;
    case 'failed':
      tone = 'err';
      label = t.runFailed(run.error?.message ?? '');
      break;
  }

  // Polite live region; the ticking seconds are aria-hidden so they are not announced every second.
  return (
    <div className="uc-runstatus" data-state={run.state} data-tone={tone} role="status" aria-live="polite">
      {tone === 'active' && <span className="uc-runstatus-dot" data-waiting={waiting > 0 || undefined} aria-hidden />}
      <span className="uc-runstatus-text">
        {label}
        {tone === 'active' && <span aria-hidden>{` · ${elapsed}`}</span>}
        {tone === 'active' && waiting > 0 && <span className="uc-runstatus-waiting">{` · ${t.waitingForYou(waiting)}`}</span>}
      </span>
    </div>
  );
}
