import { useRunningSessions } from '@uncage/react';
import type { JSX } from 'react';
import { useUi } from '../context.js';
import { Popover } from './composer/Popover.js';

/**
 * "N running" pill above the composer: active runs across every session on this server (hidden
 * at 0). Opens a list of those sessions; choosing one opens it.
 */
export function RunningChip({ onSelect }: { onSelect(sessionId: string): void }): JSX.Element | null {
  const { t } = useUi();
  const { runs, count } = useRunningSessions();
  if (count === 0) return null;
  const label = t.runningCount(count);
  // One entry per session (a session has at most one active run, but be safe).
  const sessions = [...new Map(runs.map((r) => [r.sessionId, r])).values()];
  return (
    <Popover
      label={t.runningSessions}
      triggerLabel={label}
      triggerClassName="uc-running-chip"
      trigger={
        <>
          <span className="uc-running-dot" aria-hidden />
          <span>{label}</span>
        </>
      }
      itemRole="menuitem"
      items={sessions.map((r) => ({
        id: r.sessionId,
        label: r.sessionTitle,
        description: r.state === 'waiting_approval' ? t.waitingState : t.running,
      }))}
      onSelect={onSelect}
    />
  );
}
