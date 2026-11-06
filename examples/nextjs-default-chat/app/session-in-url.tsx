'use client';

import { useSessions } from '@uncage/react';
import { useEffect } from 'react';

/**
 * Optional deep links: opens `?session=<id>` on load and keeps the URL in sync with the open
 * session, so a reload (or a second tab with the same URL) lands on the same conversation.
 */
export function SessionInUrl(): null {
  const { activeSessionId, select } = useSessions();

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('session');
    if (id) void select(id);
  }, [select]);

  useEffect(() => {
    if (activeSessionId === undefined) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('session') === activeSessionId) return;
    url.searchParams.set('session', activeSessionId);
    window.history.replaceState(null, '', url);
  }, [activeSessionId]);

  return null;
}
