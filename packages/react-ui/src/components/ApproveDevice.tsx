import type { ErrorCode } from '@uncage/protocol';
import { CheckCircle2, Laptop, ShieldAlert, XCircle } from 'lucide-react';
import { useId, type JSX } from 'react';
import { cx, UncageUIProvider, useUi } from '../context.js';
import { errorText, type Locale } from '../i18n.js';

/** What the hub knows about a pending code (`hub.lookupDevice(code, user)`; extra fields are ignored). */
export interface DeviceLookupInfo {
  /** The computer's name as sent by `uncage setup`. */
  name?: string;
  os?: string;
  expiresAt?: string;
  /** Approving re-pairs (rotates the token of) this existing computer of the user. */
  repairsMachine?: { id: string; name: string } | null;
}

/**
 * `idle`: waiting for a decision. `approving` / `denying`: the request is in flight.
 * `approved` / `denied`: done. `expired` / `not_found`: the code can no longer be used
 * (`hub.approveDevice` answered `'expired'` / `'not_found'`).
 */
export type ApproveDeviceState = 'idle' | 'approving' | 'denying' | 'approved' | 'denied' | 'expired' | 'not_found';

export interface ApproveDeviceProps {
  /** The user code from the link (`?code=`), as the terminal shows it. */
  code: string;
  /** `hub.lookupDevice(code, user)`; `null` = unknown, used or expired code. */
  lookup: DeviceLookupInfo | null;
  onApprove(): void;
  onDeny(): void;
  /** Default `'idle'`. */
  state?: ApproveDeviceState;
  /**
   * The last failed attempt (e.g. `rate_limited`, thrown by the hub); shown above the buttons,
   * which stay enabled so the user can retry.
   */
  error?: { code: ErrorCode; message: string; hint?: string; details?: Record<string, unknown> };
  /** UI language (default: the surrounding `UncageUIProvider`, else `'en'`). */
  locale?: Locale;
  /** Sets `data-theme` on the root (default `'auto'`). */
  theme?: 'light' | 'dark' | 'auto';
  className?: string;
}

/**
 * The website's device-approval page body for `uncage setup`: which computer asks to connect, the
 * code to compare with the terminal, and Approve / Deny. Presentational: the website looks the
 * code up and records the decision server-side (`hub.lookupDevice` / `approveDevice` /
 * `denyDevice` with the signed-in user) and passes the outcome back in `state`.
 *
 * Security — approving gives a computer remote access to the user's account, so the page is a
 * clickjacking and CSRF target:
 * - Serve it only on the website's own origin, behind the user's normal signed-in session.
 * - Refuse framing: send `Content-Security-Policy: frame-ancestors 'none'` and
 *   `X-Frame-Options: DENY` on the page's response.
 * - Record the decision with a POST protected against CSRF (Next.js Server Actions check the
 *   Origin; a plain route handler needs an Origin check or CSRF token and SameSite cookies). Never
 *   approve from a GET or from the `?code=` link alone.
 * See the `@uncage/react-ui` README for a Next.js example.
 */
export function ApproveDevice(props: ApproveDeviceProps): JSX.Element {
  if (props.locale === undefined) return <ApproveDeviceView {...props} />;
  return (
    <UncageUIProvider locale={props.locale}>
      <ApproveDeviceView {...props} />
    </UncageUIProvider>
  );
}

function ApproveDeviceView({
  code,
  lookup,
  onApprove,
  onDeny,
  state = 'idle',
  error,
  theme = 'auto',
  className,
}: ApproveDeviceProps): JSX.Element {
  const { t, locale } = useUi();
  const titleId = useId();
  const busy = state === 'approving' || state === 'denying';
  const gone = lookup === null || state === 'expired' || state === 'not_found';
  const done = state === 'approved' || state === 'denied';
  const shownError = error && errorText(t, error);

  let content: JSX.Element;
  if (done) {
    content = (
      <p className="uc-approve-result" role="status" data-tone={state === 'approved' ? 'ok' : 'neutral'}>
        {state === 'approved' ? <CheckCircle2 aria-hidden /> : <XCircle aria-hidden />}
        <span>{state === 'approved' ? t.approvedDone : t.deniedDone}</span>
      </p>
    );
  } else if (gone) {
    content = (
      <p className="uc-approve-result" role="alert" data-tone="err">
        <XCircle aria-hidden />
        <span>{state === 'expired' ? t.deviceExpired : t.deviceNotFound}</span>
      </p>
    );
  } else {
    const name = lookup.name ?? t.unnamedComputer;
    const os = lookup.os ? t.osName(lookup.os) : '';
    content = (
      <>
        <p className="uc-approve-body">{t.approveBody(name, os)}</p>
        <p className="uc-approve-what">{t.approveWhat}</p>
        <div className="uc-approve-code-box">
          <span className="uc-approve-code-label">{t.approveCode}</span>
          <code className="uc-approve-code">{code}</code>
          <span className="uc-approve-code-hint">{t.approveMatch}</span>
        </div>
        {lookup.repairsMachine && (
          <p className="uc-banner" data-tone="warn" role="note">
            <ShieldAlert aria-hidden />
            <span className="uc-banner-text">{t.approveRepairs(lookup.repairsMachine.name)}</span>
          </p>
        )}
        {shownError && (
          <p className="uc-banner" data-tone="err" role="alert">
            <span className="uc-banner-text">{shownError.message}</span>
          </p>
        )}
        <div className="uc-dialog-actions">
          <button
            type="button"
            className="uc-btn uc-btn-secondary"
            disabled={busy}
            aria-busy={state === 'denying' || undefined}
            onClick={onDeny}
          >
            {state === 'denying' && <span className="uc-spinner" aria-hidden />}
            {t.deny}
          </button>
          <button
            type="button"
            className="uc-btn uc-btn-primary"
            disabled={busy}
            aria-busy={state === 'approving' || undefined}
            onClick={onApprove}
          >
            {state === 'approving' && <span className="uc-spinner" aria-hidden />}
            {t.approve}
          </button>
        </div>
      </>
    );
  }

  return (
    <div className={cx('uc-root', 'uc-approve-page', className)} data-theme={theme} lang={locale}>
      <section className="uc-dialog uc-approve" aria-labelledby={titleId}>
        <div className="uc-dialog-head">
          <span className="uc-connect-icon" aria-hidden>
            <Laptop />
          </span>
          <h1 id={titleId} className="uc-dialog-title">
            {t.approveTitle}
          </h1>
        </div>
        {content}
      </section>
    </div>
  );
}
