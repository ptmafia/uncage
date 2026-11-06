import { useSession } from '@uncage/react';
import type { JSX } from 'react';
import { useRuntimeInfo, useUi } from '../context.js';

/** Title row of an open session: title, runtime name, read-only tag. */
export function ConversationHeader(): JSX.Element | null {
  const { t } = useUi();
  const { session } = useSession();
  const { name } = useRuntimeInfo(session?.runtimeId);
  if (!session) return null;
  return (
    <header className="uc-header">
      <h2 className="uc-header-title" title={session.title}>
        {session.title}
      </h2>
      <span className="uc-pill" data-tone="neutral">
        {name}
      </span>
      {session.readOnly && (
        <span className="uc-pill" data-tone="warn">
          {t.readOnlyTag}
        </span>
      )}
    </header>
  );
}
