import { useRun, useSession } from '@uncage/react';
import { ArrowUp, Square } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { useChatController, useRuntimeInfo, useUi } from '../context.js';

/**
 * Prompt input pinned under the conversation. Enter sends, Shift+Enter inserts a newline, Enter
 * while an IME is composing is ignored. The send button turns into Stop while a run is active.
 * Disabled (with a hint) when the runtime is unavailable or the session is read-only.
 */
export function Composer(): JSX.Element {
  const { t } = useUi();
  const controller = useChatController();
  const { session } = useSession();
  const { isActive, cancel } = useRun();
  const { info, name } = useRuntimeInfo(controller.runtimeId);
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const active = !controller.draft && isActive;
  const readOnly = !controller.draft && session?.readOnly === true;
  const unavailable = info !== undefined && info.status !== 'available';
  const hint = readOnly
    ? t.readOnlyHint
    : unavailable
      ? [info.message ?? t.runtimeUnavailable(name), info.hint].filter(Boolean).join(' ')
      : undefined;
  const disabled = readOnly || unavailable;
  const canSend = !disabled && !active && text.trim().length > 0;

  // Auto-grow: reset, then fit the content (CSS caps it at 40vh and scrolls beyond).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const submit = () => {
    if (!canSend) return;
    const prompt = text.trim();
    setText('');
    void controller.send(prompt);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    // IME candidate confirmation (keyCode 229 covers Safari, which reports isComposing late).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    submit();
  };

  return (
    <div className="uc-composer-wrap">
      {hint && (
        <p className="uc-composer-hint" role="note">
          {hint}
        </p>
      )}
      <div className="uc-composer" data-disabled={disabled || undefined}>
        <textarea
          ref={ref}
          className="uc-composer-input"
          rows={1}
          value={text}
          disabled={disabled}
          aria-label={t.composerLabel}
          placeholder={t.placeholder(name)}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="uc-composer-bar">
          {active ? (
            <button type="button" className="uc-btn uc-btn-primary uc-btn-icon" aria-label={t.stop} onClick={() => void cancel()}>
              <Square className="uc-icon-stop" aria-hidden />
            </button>
          ) : (
            <button type="button" className="uc-btn uc-btn-primary uc-btn-icon" aria-label={t.send} disabled={!canSend} onClick={submit}>
              <ArrowUp aria-hidden />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
