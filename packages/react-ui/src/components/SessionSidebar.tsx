import { useRuntimes, useSessions } from '@uncage/react';
import { SquarePen } from 'lucide-react';
import type { JSX } from 'react';
import { cx, useUi } from '../context.js';
import { pickRuntime } from './RuntimeSelector.js';

export interface SessionSidebarProps {
  /** Highlighted session; defaults to the active session. */
  activeId?: string;
  /** Defaults to opening the session. */
  onSelect?(id: string): void;
  /** Defaults to creating a session with the first available runtime and opening it. */
  onNew?(): void;
}

/** Session list on the warm secondary surface: "New session", then title + relative time rows. */
export function SessionSidebar(props: SessionSidebarProps): JSX.Element {
  const { t } = useUi();
  const { sessions, activeSessionId, select, create, loading } = useSessions();
  const { runtimes } = useRuntimes();
  const activeId = 'activeId' in props ? props.activeId : activeSessionId;
  const onSelect = props.onSelect ?? ((id: string) => void select(id));
  const onNew =
    props.onNew ??
    (() => {
      const runtime = pickRuntime(runtimes);
      if (runtime === undefined) return;
      create({ runtime }).then(select, () => {});
    });
  const now = Date.now();

  return (
    <aside className="uc-sidebar" aria-label={t.sessions}>
      <button type="button" className="uc-nav-item uc-nav-new" onClick={onNew}>
        <SquarePen aria-hidden />
        <span className="uc-nav-label">{t.newSession}</span>
      </button>
      <p className="uc-sidebar-label">{t.sessions}</p>
      <nav className="uc-sidebar-scroll" aria-label={t.sessionListLabel}>
        {sessions.length === 0 && !loading ? (
          <p className="uc-sidebar-empty">{t.noSessions}</p>
        ) : (
          <ul className="uc-session-list">
            {sessions.map((s) => {
              const active = s.id === activeId;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    className={cx('uc-nav-item', active && 'uc-nav-active')}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => onSelect(s.id)}
                  >
                    <span className="uc-nav-label" title={s.title}>
                      {s.title}
                    </span>
                    <span className="uc-nav-meta">{t.ago(now - Date.parse(s.createdAt))}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </aside>
  );
}
