import { useSession, useUncageError } from '@uncage/react';
import { CloudOff, Info, RefreshCw, X } from 'lucide-react';
import type { JSX } from 'react';
import { useUi } from '../context.js';

/**
 * Banners above the conversation: the live stream is reconnecting / offline, the history replay
 * was incomplete, or the last request failed (dismissable). Renders nothing when all is well.
 */
export function ConnectionBanner(): JSX.Element | null {
  const { t } = useUi();
  const { session, connection, replayIncomplete } = useSession();
  const { error, dismiss } = useUncageError();
  const conn = session && (connection === 'reconnecting' || connection === 'offline') ? connection : undefined;
  if (!conn && !(session && replayIncomplete) && !error) return null;
  return (
    <div className="uc-banners">
      {conn && (
        <p className="uc-banner" data-tone={conn === 'offline' ? 'err' : 'warn'} role="status">
          {conn === 'offline' ? <CloudOff aria-hidden /> : <RefreshCw aria-hidden />}
          <span>{conn === 'offline' ? t.offline : t.reconnecting}</span>
        </p>
      )}
      {session && replayIncomplete && (
        <p className="uc-banner" data-tone="info" role="status">
          <Info aria-hidden />
          <span>{t.replayIncomplete}</span>
        </p>
      )}
      {error && (
        <div className="uc-banner" data-tone="err" role="alert">
          <span className="uc-banner-text">
            {error.message}
            {error.hint && <span className="uc-banner-hint"> {error.hint}</span>}
          </span>
          <button type="button" className="uc-btn uc-btn-ghost uc-btn-icon-sm" aria-label={t.dismiss} onClick={dismiss}>
            <X aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}
