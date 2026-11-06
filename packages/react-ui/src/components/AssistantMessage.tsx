import { useSession, type MessageView } from '@uncage/react';
import type { JSX, ReactNode } from 'react';
import { cx, useNow, useRuntimeInfo, useUi } from '../context.js';
import { Markdown } from './Markdown.js';

/**
 * Name line above an answer: monogram, runtime name, optional status and elapsed time. While
 * `live`, the monogram's ring breathes — the only moving element on screen.
 */
export function Byline({ live, status, elapsed }: { live: boolean; status?: ReactNode; elapsed?: string }): JSX.Element {
  const { session } = useSession();
  const { name } = useRuntimeInfo(session?.runtimeId);
  return (
    <div className="uc-byline" data-live={live || undefined}>
      <span className={cx('uc-avatar', live && 'uc-breathe')} aria-hidden>
        {name.charAt(0).toUpperCase()}
      </span>
      <span className="uc-byline-name">{name}</span>
      {status !== undefined && (
        <>
          <span className="uc-sep" aria-hidden>
            ·
          </span>
          <span className="uc-byline-status">{status}</span>
        </>
      )}
      {elapsed !== undefined && (
        <>
          <span className="uc-sep" aria-hidden>
            ·
          </span>
          <span className="uc-tabular">{elapsed}</span>
        </>
      )}
    </div>
  );
}

/** An assistant answer: byline (name, and elapsed time while streaming) and Markdown body. No bubble. */
export function AssistantMessage({ message }: { message: MessageView }): JSX.Element {
  const { t } = useUi();
  const now = useNow(message.streaming);
  return (
    <div className="uc-assistant">
      <Byline
        live={message.streaming}
        {...(message.streaming ? { elapsed: t.elapsed(now - Date.parse(message.startedAt)) } : {})}
      />
      <Markdown text={message.text} />
    </div>
  );
}
