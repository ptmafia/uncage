import type { ErrorCode } from '@uncage/protocol';
import { matchesDeviceCodeTail } from '@uncage/react';
import { CheckCircle2, Laptop, ShieldAlert, XCircle } from 'lucide-react';
import { useEffect, useId, useState, type JSX } from 'react';
import { cx, UncageUIProvider, useUi } from '../context.js';
import { errorText, formatRelative, type Locale } from '../i18n.js';

/** What the hub knows about a pending code (`hub.lookupDevice(code, user)`; extra fields are ignored). */
export interface DeviceLookupInfo {
  /** The computer's name as sent by `uncage setup`. */
  name?: string;
  os?: string;
  expiresAt?: string;
  /** When `uncage setup` asked for the code (ISO), shown as relative time. */
  requestedAt?: string;
  /** The requesting computer's IP as the hub saw it; `null` = unknown (not shown). */
  requestIp?: string | null;
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
  /**
   * The user code from the link (`?code=`) or typed by the user, as the terminal shows it. With
   * `source: 'link'` it must be exactly `ABCD-EFGH` or `ABCDEFGH`; anything else shows "This link is
   * not valid" (do not look it up).
   */
  code: string;
  /**
   * Where `code` came from. `'link'` (default): it arrived in a URL, so it is not trusted on its
   * own (anyone can run `uncage setup` on their own computer and send the link): the page warns,
   * hides the code's last 4 characters and enables Approve only once the user typed them from
   * their terminal. `'typed'`: the user typed the whole code on your page; no extra step. Never
   * derive `'typed'` from the URL.
   */
  source?: 'link' | 'typed';
  /** `hub.lookupDevice(code, user)`; `null` = unknown, used or expired code. */
  lookup: DeviceLookupInfo | null;
  onApprove(): void;
  onDeny(): void;
  /** Default `'idle'`. */
  state?: ApproveDeviceState;
  /**
   * The last failed attempt (e.g. `rate_limited`, thrown by the hub), shown localized. With a
   * lookup it appears above the buttons, which stay enabled for a retry; with `lookup: null` (the
   * lookup itself failed) it replaces the "code not found" message.
   */
  error?: { code: ErrorCode; message: string; hint?: string; details?: Record<string, unknown> };
  /** UI language (default: the surrounding `UncageUIProvider`, else `'en'`). */
  locale?: Locale;
  /** Sets `data-theme` on the root (default `'auto'`). */
  theme?: 'light' | 'dark' | 'auto';
  className?: string;
}

/**
 * The website's device-approval page body for `uncage setup`: which computer asks to connect, when
 * and from which IP it asked, the code to compare with the terminal, and Approve / Deny. A code
 * from a link (`source: 'link'`, the default) must be confirmed by typing its last 4 characters.
 * Presentational: the website looks the code up and records the decision server-side (`hub.lookupDevice` / `approveDevice` /
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

/** Exactly the shape the CLI prints: `ABCD-EFGH` or `ABCDEFGH` (after trimming). */
const LINK_CODE = /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/i;
const compact = (s: string): string => s.toUpperCase().replace(/[\s-]/g, '');

function ApproveDeviceView({
  code,
  source = 'link',
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
  const fromLink = source === 'link';
  const tailId = useId();
  const [typedTail, setTypedTail] = useState('');
  useEffect(() => setTypedTail(''), [code]);
  // A link code must have exactly the CLI's shape; padding (`ABCD-EFGH----`) could otherwise put
  // the real last 4 characters on screen.
  const linkInvalid = fromLink && !LINK_CODE.test(code.trim());
  const confirmed = !linkInvalid && (!fromLink || matchesDeviceCodeTail(code, typedTail));
  // From a link: hide the last 4 characters (built from the compacted code), the user types them
  // from their own terminal.
  const shownCode = fromLink ? `${compact(code).slice(0, 4)}-••••` : code;

  let content: JSX.Element;
  if (done) {
    content = (
      <p className="uc-approve-result" role="status" data-tone={state === 'approved' ? 'ok' : 'neutral'}>
        {state === 'approved' ? <CheckCircle2 aria-hidden /> : <XCircle aria-hidden />}
        <span>{state === 'approved' ? t.approvedDone : t.deniedDone}</span>
      </p>
    );
  } else if (linkInvalid) {
    content = (
      <p className="uc-approve-result" role="alert" data-tone="err">
        <XCircle aria-hidden />
        <span>{t.deviceLinkInvalid}</span>
      </p>
    );
  } else if (gone && shownError) {
    // The lookup itself failed (e.g. `rate_limited`): say why, not "code not found".
    content = (
      <p className="uc-banner" data-tone="err" role="alert">
        <span className="uc-banner-text">{shownError.message}</span>
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
        <p className="uc-approve-code-hint">{t.approveReported}</p>
        <p className="uc-approve-what">{t.approveWhat}</p>
        {fromLink && (
          <p className="uc-banner" data-tone="warn" role="note" data-testid="uc-approve-warning">
            <ShieldAlert aria-hidden />
            <span className="uc-banner-text">{t.approveLinkWarning}</span>
          </p>
        )}
        {(lookup.requestedAt !== undefined || typeof lookup.requestIp === 'string') && (
          <dl className="uc-approve-meta">
            {lookup.requestedAt !== undefined && (
              <div>
                <dt>{t.approveRequested}</dt>
                <dd>
                  <time dateTime={lookup.requestedAt} title={new Date(lookup.requestedAt).toLocaleString(locale)}>
                    {formatRelative(lookup.requestedAt, locale, t.justNow)}
                  </time>
                </dd>
              </div>
            )}
            {typeof lookup.requestIp === 'string' && (
              <div>
                <dt>{t.approveRequestIp}</dt>
                <dd>{lookup.requestIp}</dd>
              </div>
            )}
          </dl>
        )}
        <div className="uc-approve-code-box">
          <span className="uc-approve-code-label">{t.approveCode}</span>
          <code className="uc-approve-code">{shownCode}</code>
          {!fromLink && <span className="uc-approve-code-hint">{t.approveMatch}</span>}
        </div>
        {fromLink && (
          <div className="uc-approve-confirm">
            <label htmlFor={tailId}>{t.approveTypeTail}</label>
            <input
              id={tailId}
              className="uc-approve-confirm-input"
              value={typedTail}
              onChange={(e) => setTypedTail(e.target.value.slice(0, 16))}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              inputMode="text"
              maxLength={16}
              placeholder="••••"
              disabled={busy}
              aria-describedby={`${tailId}-hint`}
            />
            <span id={`${tailId}-hint`} className="uc-approve-code-hint">
              {t.approveTypeTailHint}
            </span>
          </div>
        )}
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
            disabled={busy || !confirmed}
            aria-busy={state === 'approving' || undefined}
            onClick={() => {
              if (confirmed) onApprove();
            }}
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
