'use client';

import { ApproveDevice, type ApproveDeviceProps, type ApproveDeviceState } from '@uncage/react-ui';
import '@uncage/react-ui/styles.css';
import { useState, type FormEvent } from 'react';
import { decide, lookupTyped } from './actions.ts';

type ErrorProp = ApproveDeviceProps['error'];

/**
 * `code` from the URL (`/device?code=`, the CLI's link or QR code) is shown with `source="link"`:
 * a warning, the request time and IP, and Approve only after the user typed the code's last 4
 * characters (someone may have sent the link). Without one the user types the whole code here,
 * kept in client state only (never in the URL), and approves it with `source="typed"`.
 */
export function ApprovePage({
  code,
  lookup,
  initialError,
  invalidLink = false,
}: Pick<ApproveDeviceProps, 'code' | 'lookup'> & { initialError?: { code: string; message: string }; invalidLink?: boolean }) {
  const [typed, setTyped] = useState<{ code: string; lookup: ApproveDeviceProps['lookup'] } | null>(null);
  if (code) return <Decision code={code} source="link" lookup={lookup} initialError={initialError} />;
  if (typed) return <Decision code={typed.code} source="typed" lookup={typed.lookup} />;
  return <EnterCode onFound={setTyped} invalidLink={invalidLink} />;
}

function Decision({
  code,
  source,
  lookup,
  initialError,
}: Pick<ApproveDeviceProps, 'code' | 'lookup' | 'source'> & { initialError?: { code: string; message: string } }) {
  const [state, setState] = useState<ApproveDeviceState>('idle');
  const [error, setError] = useState<ErrorProp>(initialError as ErrorProp);
  const act = async (approve: boolean) => {
    setState(approve ? 'approving' : 'denying');
    setError(undefined);
    const r = await decide(code, approve);
    if ('error' in r) {
      setState('idle'); // buttons stay enabled for a retry
      setError(r.error as ErrorProp);
    } else {
      setState(r.result === 'ok' ? (approve ? 'approved' : 'denied') : r.result);
    }
  };
  return (
    <ApproveDevice
      code={code}
      source={source}
      lookup={lookup}
      state={state}
      error={error}
      locale="zh-CN"
      onApprove={() => void act(true)}
      onDeny={() => void act(false)}
    />
  );
}

/** Plain `/device`: the user types the whole code from their terminal. */
function EnterCode({
  onFound,
  invalidLink,
}: {
  onFound(v: { code: string; lookup: ApproveDeviceProps['lookup'] }): void;
  invalidLink: boolean;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim() || busy) return;
    setBusy(true);
    setMessage(undefined);
    const r = await lookupTyped(value);
    setBusy(false);
    if ('error' in r) setMessage(r.error.message);
    else if (!r.lookup) setMessage('验证码无效或已过期。重新运行 `uncage setup` 获取新的验证码。');
    else onFound({ code: value.trim().toUpperCase(), lookup: r.lookup });
  };
  return (
    <div className="uc-root uc-approve-page" data-theme="auto" lang="zh-CN">
      <form className="uc-dialog uc-approve" onSubmit={(e) => void submit(e)}>
        <h1 className="uc-dialog-title">连接一台电脑</h1>
        {invalidLink && (
          <p className="uc-banner" data-tone="warn" role="note">
            <span className="uc-banner-text">这个链接无效。请改为输入终端里显示的验证码。</span>
          </p>
        )}
        <label className="uc-approve-confirm">
          输入终端里 `uncage setup` 显示的验证码
          <input
            className="uc-approve-confirm-input"
            style={{ width: '12em' }}
            value={value}
            onChange={(e) => setValue(e.target.value.slice(0, 16))}
            autoComplete="off"
            spellCheck={false}
            placeholder="ABCD-EFGH"
          />
        </label>
        {message && (
          <p className="uc-banner" data-tone="err" role="alert">
            <span className="uc-banner-text">{message}</span>
          </p>
        )}
        <div className="uc-dialog-actions">
          <button type="submit" className="uc-btn uc-btn-primary" disabled={busy || !value.trim()}>
            继续
          </button>
        </div>
      </form>
    </div>
  );
}
