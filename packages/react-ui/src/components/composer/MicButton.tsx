import { Mic } from 'lucide-react';
import type { JSX } from 'react';
import { cx, useUi } from '../../context.js';

/**
 * Dictation toggle for `useSpeechInput`. Hidden when the browser has no Web Speech API; a pulsing
 * ring while listening (static under reduced motion).
 */
export function MicButton({
  supported,
  listening,
  disabled = false,
  onToggle,
}: {
  supported: boolean;
  listening: boolean;
  disabled?: boolean;
  onToggle(): void;
}): JSX.Element | null {
  const { t } = useUi();
  if (!supported) return null;
  const label = listening ? t.micStop : t.micStart;
  return (
    <button
      type="button"
      className={cx('uc-btn uc-btn-ghost uc-tool uc-tool-icon uc-mic', listening && 'uc-mic-on')}
      aria-label={label}
      aria-pressed={listening}
      title={label}
      disabled={disabled && !listening}
      onClick={onToggle}
    >
      <Mic aria-hidden />
    </button>
  );
}
