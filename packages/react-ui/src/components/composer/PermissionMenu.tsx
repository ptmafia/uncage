import { useSessionSettings } from '@uncage/react';
import type { PermissionMode } from '@uncage/protocol';
import { ChevronDown, Shield, ShieldAlert } from 'lucide-react';
import { useEffect, useId, useRef, useState, type JSX } from 'react';
import { useUi } from '../../context.js';
import { Popover } from './Popover.js';

const BYPASS: PermissionMode = 'bypassPermissions';

/**
 * "Agent will run any command without asking. Continue?" — Cancel (focused) / Enable. Modal: Esc
 * cancels and Tab cycles between the two buttons wherever focus is (also after a click on the
 * dialog's text, which focuses the dialog itself).
 */
function BypassConfirm({ onCancel, onConfirm }: { onCancel(): void; onConfirm(): void }): JSX.Element {
  const { t } = useUi();
  const id = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    onCancelRef.current = onCancel;
  });
  useEffect(() => {
    cancel.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancelRef.current();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const order = e.shiftKey ? [confirm, cancel] : [cancel, confirm];
        // From either button go to the other; from anywhere else start at the first.
        const next = document.activeElement === order[0]!.current ? order[1]! : order[0]!;
        next.current?.focus();
      }
    };
    // Capture phase on the document: works whatever holds focus (body, the dialog, a button).
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);
  return (
    <div className="uc-dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        ref={dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-desc`}
        className="uc-dialog"
        tabIndex={-1}
      >
        <div className="uc-dialog-head">
          <span className="uc-dialog-icon" aria-hidden>
            <ShieldAlert />
          </span>
          <h2 id={`${id}-title`} className="uc-dialog-title">
            {t.permissionModes.bypassPermissions}
          </h2>
        </div>
        <p id={`${id}-desc`} className="uc-dialog-body">
          {t.bypassConfirm}
        </p>
        <div className="uc-dialog-actions">
          <button ref={cancel} type="button" className="uc-btn uc-btn-secondary" onClick={onCancel}>
            {t.cancel}
          </button>
          <button ref={confirm} type="button" className="uc-btn uc-btn-danger" onClick={onConfirm}>
            {t.enable}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Permission mode picker (shield icon). Lists only the modes the runtime (and the server policy)
 * offers, so bypass appears only when the server allows it; choosing it asks for confirmation.
 */
export function PermissionMenu({ disabled = false }: { disabled?: boolean }): JSX.Element | null {
  const { t } = useUi();
  const { settings, capabilities, update, pendingForNextRun } = useSessionSettings();
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const modes = capabilities?.permissionModes ?? [];
  if (modes.length === 0) return null;
  const current = settings.permissionMode;
  const bypass = current === BYPASS;
  const label = t.permissionModes[current];
  const done = () => {
    setConfirming(false);
    trigger.current?.focus();
  };
  return (
    <>
      <Popover
        label={t.permissionTitle}
        triggerLabel={t.labelled(t.permissionTitle, label)}
        triggerRef={trigger}
        {...(bypass ? { triggerTone: 'err' as const } : {})}
        trigger={
          <>
            {bypass ? <ShieldAlert aria-hidden /> : <Shield aria-hidden />}
            <span className="uc-tool-label">{label}</span>
            <ChevronDown className="uc-tool-chevron" aria-hidden />
          </>
        }
        disabled={disabled}
        items={modes.map((m) => ({
          id: m,
          label: t.permissionModes[m],
          description: t.permissionHints[m],
          checked: m === current,
          ...(m === BYPASS ? { tone: 'err' as const } : {}),
        }))}
        onSelect={(id) => {
          if (id === current) return;
          if (id === BYPASS) setConfirming(true);
          else void update({ permissionMode: id as PermissionMode });
        }}
        {...(pendingForNextRun ? { footnote: t.appliesNextRun } : {})}
      />
      {confirming && (
        <BypassConfirm
          onCancel={done}
          onConfirm={() => {
            done();
            void update({ permissionMode: BYPASS });
          }}
        />
      )}
    </>
  );
}
