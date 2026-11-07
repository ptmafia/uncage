'use client';

import { ApproveDevice, type ApproveDeviceProps, type ApproveDeviceState } from '@uncage/react-ui';
import '@uncage/react-ui/styles.css';
import { useState } from 'react';
import { decide } from './actions.ts';

type ErrorProp = ApproveDeviceProps['error'];

export function ApprovePage({
  code,
  lookup,
  initialError,
}: Pick<ApproveDeviceProps, 'code' | 'lookup'> & { initialError?: { code: string; message: string } }) {
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
      lookup={lookup}
      state={state}
      error={error}
      locale="zh-CN"
      onApprove={() => void act(true)}
      onDeny={() => void act(false)}
    />
  );
}
