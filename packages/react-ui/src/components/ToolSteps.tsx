import { useApprovals, type ToolView } from '@uncage/react';
import { Check, ChevronRight, Minus, X } from 'lucide-react';
import { useEffect, useId, useState, type JSX } from 'react';
import { cx, useNow, useUi } from '../context.js';
import type { Strings } from '../i18n.js';

type Mark = 'running' | 'waiting' | 'completed' | 'failed' | 'declined';

const markLabel = (t: Strings, m: Mark) =>
  m === 'running'
    ? t.stepRunning
    : m === 'waiting'
      ? t.stepWaiting
      : m === 'failed'
        ? t.stepFailed
        : m === 'declined'
          ? t.stepDeclined
          : t.stepDone;

function StatusMark({ mark, label }: { mark: Mark; label: string }): JSX.Element {
  return (
    <span className="uc-mark" data-mark={mark} role="img" aria-label={label}>
      {mark === 'running' || mark === 'waiting' ? (
        <span className="uc-mark-dot" />
      ) : mark === 'failed' ? (
        <X strokeWidth={2.5} aria-hidden />
      ) : mark === 'declined' ? (
        <Minus strokeWidth={2.5} aria-hidden />
      ) : (
        <Check strokeWidth={2.5} aria-hidden />
      )}
    </span>
  );
}

/**
 * The work between answers, unboxed: a quiet header "N steps · 12s ›" and a thin left thread of
 * single-line steps. Open while the run is going, collapsed once it is done (the user can toggle).
 */
export function ToolSteps({ tools, running }: { tools: ToolView[]; running: boolean }): JSX.Element | null {
  const { t } = useUi();
  const { pending } = useApprovals();
  const listId = useId();
  const [override, setOverride] = useState<boolean | null>(null);
  useEffect(() => setOverride(null), [running]);
  const open = override ?? running;
  const now = useNow(running);

  const waitingTools = new Set(pending.map((a) => a.toolId).filter((id) => id !== undefined));
  const markOf = (tool: ToolView): Mark =>
    tool.status === 'running' ? (waitingTools.has(tool.id) ? 'waiting' : 'running') : tool.status;
  const marks = tools.map(markOf);
  const head: Mark = marks.includes('waiting')
    ? 'waiting'
    : running || marks.includes('running')
      ? 'running'
      : marks.includes('failed')
        ? 'failed'
        : marks.length > 0 && marks.every((m) => m === 'declined')
          ? 'declined'
          : 'completed';

  if (tools.length === 0) return null;
  const start = Math.min(...tools.map((x) => Date.parse(x.startedAt)));
  const end = running
    ? now
    : Math.max(...tools.map((x) => Date.parse(x.startedAt) + (x.durationMs ?? 0)));

  return (
    <div className="uc-steps" data-state={head}>
      <button
        type="button"
        className="uc-steps-toggle"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOverride(!open)}
      >
        <StatusMark mark={head} label={markLabel(t, head)} />
        <span className="uc-steps-meta">{t.steps(tools.length, t.elapsed(end - start))}</span>
        <ChevronRight aria-hidden className={cx('uc-chevron', open && 'uc-chevron-open')} />
      </button>
      {open && (
        <ul id={listId} className="uc-thread">
          {tools.map((tool, i) => {
            const mark = marks[i]!;
            return (
              <li key={tool.id} className="uc-step" data-status={mark}>
                <StatusMark mark={mark} label={markLabel(t, mark)} />
                <span className="uc-step-title" title={tool.error ?? tool.title}>
                  {tool.title}
                </span>
                <span className="uc-step-status">
                  {mark === 'completed'
                    ? tool.durationMs !== undefined && tool.durationMs >= 1000
                      ? t.elapsed(tool.durationMs)
                      : ''
                    : markLabel(t, mark)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
