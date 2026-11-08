import { useMachines, useSession } from '@uncage/react';
import type { JSX } from 'react';
import { useChatController, useRuntimeInfo, useUi } from '../context.js';
import { MachineStatus } from './MachineStatus.js';

/**
 * Title row of an open session: title, runtime name, read-only tag. In connected mode it also
 * shows the computer the conversation runs on (with a picker), in a draft too; picking another
 * computer while a session is open starts a new session on it.
 */
export function ConversationHeader(): JSX.Element | null {
  const { t } = useUi();
  const { session } = useSession();
  const { draft, startNewSession } = useChatController();
  const { connected, currentId } = useMachines();
  const { name } = useRuntimeInfo(session?.runtimeId);
  const showSession = session !== undefined && !draft;
  if (!showSession && !connected) return null;
  return (
    <header className="uc-header">
      {showSession && (
        <>
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
        </>
      )}
      {connected && (
        <div className="uc-header-end">
          <MachineStatus
            onSelect={(m) => {
              if (!draft && currentId !== undefined && m.id !== currentId) startNewSession?.();
            }}
          />
        </div>
      )}
    </header>
  );
}
