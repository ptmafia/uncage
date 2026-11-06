import type { ApprovalRequest } from '@uncage/protocol';
import { useApprovalActions } from '@uncage/react';
import { Check, ChevronDown, ChevronRight, Minus, TriangleExclamationPoint, X } from 'lucide-react';
import { useId, useState, type JSX, type KeyboardEvent } from 'react';
import { useUi } from '../context.js';

const LIVE_STATES = new Set<ApprovalRequest['state']>(['pending', 'submitting', 'reconciling']);
const INTERACTIVE = 'button, a, input, textarea, select, summary';

/** Decorative: the button carrying it is `aria-busy`, so its accessible name stays unchanged. */
function Spinner(): JSX.Element {
  return <span className="uc-spinner" aria-hidden />;
}

/** A terminal approval collapses to one honest line. */
function ResolvedLine({ approval }: { approval: ApprovalRequest }): JSX.Element {
  const { t } = useUi();
  const s = approval.state;
  const [text, icon, tone] =
    s === 'approved'
      ? [t.approved, <Check key="i" strokeWidth={2.5} />, 'ok']
      : s === 'denied'
        ? [t.denied(approval.title), <Minus key="i" strokeWidth={2.5} />, 'muted']
        : s === 'expired'
          ? [t.expired, <TriangleExclamationPoint key="i" />, 'warn']
          : s === 'cancelled'
            ? [t.cancelled, <Minus key="i" strokeWidth={2.5} />, 'muted']
            : [t.approvalFailed, <X key="i" strokeWidth={2.5} />, 'err'];
  return (
    <p className="uc-approval-line" data-state={s} data-tone={tone} role="status">
      <span className="uc-approval-line-icon" aria-hidden>
        {icon}
      </span>
      <span>{text}</span>
    </p>
  );
}

/**
 * The only boxed element in the conversation: an amber card asking to allow one tool call.
 * Shows the title, the most informative target (command in mono, else path / host, plus cwd) and
 * the description; "Details" reveals the raw target. Enter allows while focus is on the card.
 */
export function ApprovalCard({ approval }: { approval: ApprovalRequest }): JSX.Element {
  const { t } = useUi();
  const { decide, pending } = useApprovalActions();
  const [details, setDetails] = useState(false);
  const detailsId = useId();

  if (!LIVE_STATES.has(approval.state)) return <ResolvedLine approval={approval} />;

  const local = pending[approval.id];
  const serverBusy = approval.state !== 'pending';
  const busy = local ?? (serverBusy ? approval.decision : undefined);
  const disabled = local !== undefined || serverBusy;
  const title = t.approvalTitle(approval.title);
  const { command, path, host, cwd } = approval.target;
  const target = command ?? path ?? host;

  const choose = (d: 'allow' | 'deny') => {
    if (!disabled) void decide(approval.id, d);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
    e.preventDefault();
    choose('allow');
  };

  return (
    <section className="uc-approval" aria-label={title} tabIndex={0} onKeyDown={onKeyDown} data-state={approval.state}>
      <header className="uc-approval-head">
        <span className="uc-approval-icon" aria-hidden>
          <TriangleExclamationPoint />
        </span>
        <h3 className="uc-approval-title">{title}</h3>
      </header>
      {target !== undefined && (
        <div className="uc-approval-target">
          {command !== undefined ? <pre className="uc-code">{command}</pre> : <code className="uc-path">{target}</code>}
          {cwd !== undefined && <span className="uc-approval-cwd">{t.inDir(cwd)}</span>}
        </div>
      )}
      {approval.description && <p className="uc-approval-desc">{approval.description}</p>}
      <button
        type="button"
        className="uc-btn uc-btn-ghost uc-btn-sm uc-approval-details"
        aria-expanded={details}
        aria-controls={detailsId}
        onClick={() => setDetails(!details)}
      >
        {details ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
        {t.details}
      </button>
      {details && (
        <pre id={detailsId} className="uc-approval-raw">
          {JSON.stringify(approval.target, null, 2)}
        </pre>
      )}
      <div className="uc-approval-bar">
        <span className="uc-approval-expiry">{t.expiresAt(approval.expiresAt)}</span>
        <div className="uc-approval-actions">
          <button
            type="button"
            className="uc-btn uc-btn-secondary uc-btn-sm"
            disabled={disabled}
            aria-busy={busy === 'deny' || undefined}
            onClick={() => choose('deny')}
          >
            {busy === 'deny' && <Spinner />}
            {t.deny}
          </button>
          <button
            type="button"
            className="uc-btn uc-btn-primary uc-btn-sm"
            disabled={disabled}
            aria-busy={busy === 'allow' || undefined}
            onClick={() => choose('allow')}
          >
            {busy === 'allow' && <Spinner />}
            {t.allowOnce}
          </button>
        </div>
      </div>
    </section>
  );
}
