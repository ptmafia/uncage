import type { MachineInfo } from '@uncage/protocol';
import { useMachines, useUncageStore } from '@uncage/react';
import { CheckCircle2, ChevronRight, Laptop } from 'lucide-react';
import { useEffect, useId, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { cx, useUi } from '../context.js';
import { errorText } from '../i18n.js';
import { CopyCommand } from './CopyCommand.js';

/** How often the dialog checks whether the computer came online. */
export const CONNECT_POLL_MS = 3000;

export interface ConnectMachineProps {
  /**
   * `'dialog'` (default): a modal with Cancel (Esc and a backdrop click also close it).
   * `'inline'`: embedded in the page, e.g. the chat's empty state; no Cancel.
   */
  variant?: 'dialog' | 'inline';
  /** Dialog: Cancel / Done, Esc or a backdrop click. */
  onClose?(): void;
  /**
   * A computer came online while this was shown (a new one, or a known one reconnecting). It is
   * selected for new sessions before this is called.
   */
  onConnected?(machine: MachineInfo): void;
  className?: string;
}

/** Tab stops (roving-tabindex items such as the inactive OS tab are skipped). */
const FOCUSABLE =
  'button:not([disabled]):not([tabindex="-1"]), [href]:not([tabindex="-1"]), summary:not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])';

/** The visitor's OS from the browser (`userAgentData.platform`, else `platform`); macOS / Linux when unknown. */
function detectOs(nav: { platform?: string; userAgentData?: { platform?: string } } | undefined = globalThis.navigator): 'unix' | 'windows' {
  const p = nav?.userAgentData?.platform ?? nav?.platform ?? '';
  return /^win/i.test(p) ? 'windows' : 'unix';
}

/**
 * "Connect your computer": the one command to run on the computer (the site's checking installer:
 * `install.sh` on macOS / Linux, `install.ps1` on Windows, in OS tabs that start on the detected OS),
 * with a copy button, a secondary `uncage setup <url>` for a computer that already has the CLI, and
 * a live status row that switches from
 * "Waiting for your computer…" to "Connected: <name>" once a computer comes online. Polls the
 * hub every 3 s while shown and the page is visible. Mount it only while it should be visible
 * (unmounting stops the polling). Connected mode only (needs an Uncage hub).
 */
export function ConnectMachine({ variant = 'dialog', onClose, onConnected, className }: ConnectMachineProps): JSX.Element {
  const { t, locale } = useUi();
  const store = useUncageStore();
  const { machines, install, error, connected, loadInstallInfo } = useMachines({ watch: CONNECT_POLL_MS });
  const id = useId();
  const [tab, setTab] = useState<'unix' | 'windows'>('unix');
  // After mount, not in the initializer: the server render (and hydration) must match, and Node has a
  // `navigator` of its own, which describes the server.
  useEffect(() => {
    setTab(detectOs());
  }, []);
  const [installFailed, setInstallFailed] = useState<typeof error>();
  const [joined, setJoined] = useState<MachineInfo>();
  /** Ids online when the dialog opened (captured from the first connected-mode list). */
  const baseline = useRef<Set<string> | null>(null);
  const onConnectedRef = useRef(onConnected);
  useEffect(() => {
    onConnectedRef.current = onConnected;
  });

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void loadInstallInfo().then((ok) => {
      if (mounted.current && !ok) setInstallFailed(store.getState().machines.error);
    });
    return () => {
      mounted.current = false;
    };
  }, [store, loadInstallInfo]);

  useEffect(() => {
    if (!connected || joined) return;
    if (baseline.current === null) {
      baseline.current = new Set(machines.filter((m) => m.online).map((m) => m.id));
      return;
    }
    const known = baseline.current;
    const fresh = machines.find((m) => m.online && !known.has(m.id));
    if (!fresh) {
      // A known computer that went offline counts as new when it comes back.
      for (const m of machines) if (!m.online) known.delete(m.id);
      return;
    }
    setJoined(fresh);
    store.actions.selectMachine(fresh.id);
    onConnectedRef.current?.(fresh);
  }, [connected, machines, joined, store]);

  const retryInstall = () => {
    setInstallFailed(undefined);
    void loadInstallInfo().then((ok) => {
      if (mounted.current && !ok) setInstallFailed(store.getState().machines.error);
    });
  };

  const dialog = variant === 'dialog';
  const panel = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    if (!dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current?.();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      previous?.focus();
    };
  }, [dialog]);

  /** Keeps Tab inside the dialog. */
  const trapTab = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!dialog || e.key !== 'Tab' || !panel.current) return;
    const nodes = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (nodes.length === 0) return;
    const first = nodes[0]!;
    const last = nodes[nodes.length - 1]!;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const onTabKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const next = tab === 'unix' ? 'windows' : 'unix';
    const to = e.key === 'Home' ? 'unix' : e.key === 'End' ? 'windows' : next;
    setTab(to);
    document.getElementById(`${id}-tab-${to}`)?.focus();
  };

  const shownError = installFailed && errorText(t, installFailed);
  const retryable = installFailed !== undefined;
  const pollError = error && !installFailed && error.code === 'rate_limited' ? errorText(t, error) : undefined;

  const body = (
    <div
      ref={panel}
      className={cx('uc-connect', dialog ? 'uc-dialog uc-connect-dialog' : 'uc-connect-inline', className)}
      {...(dialog ? { role: 'dialog', 'aria-modal': true, tabIndex: -1 } : { role: 'region' })}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-desc`}
      lang={locale}
      onKeyDown={trapTab}
    >
      <div className="uc-connect-head">
        <span className="uc-connect-icon" aria-hidden>
          <Laptop />
        </span>
        <div className="uc-connect-heading">
          <h2 id={`${id}-title`} className="uc-connect-title">
            {t.connectTitle}
          </h2>
          <p id={`${id}-desc`} className="uc-connect-subtitle">
            {t.connectSubtitle}
          </p>
        </div>
      </div>

      <div className="uc-connect-steps">
        <div className="uc-connect-step">
          <div className="uc-connect-step-body">
            <h3 className="uc-connect-step-title">{t.connectOneCommand}</h3>
            <div className="uc-tabs" role="tablist" aria-label={t.osTabs}>
              {(['unix', 'windows'] as const).map((k) => (
                <button
                  key={k}
                  id={`${id}-tab-${k}`}
                  type="button"
                  role="tab"
                  className="uc-tab"
                  aria-selected={tab === k}
                  aria-controls={`${id}-panel`}
                  tabIndex={tab === k ? 0 : -1}
                  onClick={() => setTab(k)}
                  onKeyDown={onTabKey}
                >
                  {k === 'unix' ? t.osUnix : t.osWindows}
                </button>
              ))}
            </div>
            <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`} className="uc-tabpanel">
              {shownError ? (
                <div className="uc-connect-error" role="alert">
                  <span>{shownError.message}</span>
                  {retryable && (
                    <button type="button" className="uc-btn uc-btn-secondary uc-btn-sm" onClick={retryInstall}>
                      {t.retry}
                    </button>
                  )}
                </div>
              ) : !install ? (
                <p className="uc-connect-muted">{t.loadingCommands}</p>
              ) : tab === 'unix' ? (
                <CopyCommand command={install.install} />
              ) : install.windows ? (
                <CopyCommand command={install.windows} />
              ) : (
                // A custom client without a Windows installer.
                <p className="uc-connect-soon">
                  <span className="uc-pill" data-tone="neutral">
                    {t.comingSoon}
                  </span>
                </p>
              )}
            </div>
            <p className="uc-connect-note">{t.connectOneCommandNote}</p>
            {install && (
              <div className="uc-connect-alt">
                <p className="uc-connect-note">{t.connectAlreadyInstalled}</p>
                <CopyCommand command={install.setup} />
              </div>
            )}
          </div>
        </div>
      </div>

      <p className="uc-connect-status" role="status" data-state={joined ? 'connected' : 'waiting'}>
        {joined ? <CheckCircle2 className="uc-connect-ok" aria-hidden /> : <span className="uc-live-dot" aria-hidden />}
        <span>{joined ? t.computerConnected(joined.name) : t.waitingForComputer}</span>
      </p>
      {pollError && (
        <p className="uc-connect-muted" role="note">
          {pollError.message}
        </p>
      )}

      <details className="uc-connect-more">
        <summary>
          <ChevronRight className="uc-connect-chevron" aria-hidden />
          <span>{t.noBrowserTitle}</span>
        </summary>
        <div className="uc-connect-more-body">
          <p>{t.noBrowserBody}</p>
          {install && <CopyCommand command={`${install.setup} --no-browser`} />}
        </div>
      </details>

      {dialog && (
        <div className="uc-dialog-actions">
          <button type="button" className={cx('uc-btn', joined ? 'uc-btn-primary' : 'uc-btn-secondary')} onClick={() => onClose?.()}>
            {joined ? t.done : t.cancel}
          </button>
        </div>
      )}
    </div>
  );

  if (!dialog) return body;
  return (
    <div className="uc-dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose?.()}>
      {body}
    </div>
  );
}
