import { useSessionSettings } from '@uncage/react';
import { ShieldAlert } from 'lucide-react';
import type { JSX } from 'react';
import { useUi } from '../context.js';

/** Shown at the top of the conversation while the permission mode is bypass. */
export function BypassBanner(): JSX.Element | null {
  const { t } = useUi();
  const { settings } = useSessionSettings();
  if (settings.permissionMode !== 'bypassPermissions') return null;
  return (
    <p className="uc-banner uc-bypass-banner" data-tone="err" role="status">
      <ShieldAlert aria-hidden />
      <span className="uc-banner-text">{t.bypassBanner}</span>
    </p>
  );
}
