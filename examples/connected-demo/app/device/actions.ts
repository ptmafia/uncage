'use server';

import type { ApproveDeviceProps } from '@uncage/react-ui';
import { getHub } from '../../lib/hub-registry.ts';
import { currentUser } from '../../lib/session.ts';

export type DecideResult = { result: 'ok' | 'not_found' | 'expired' } | { error: { code: string; message: string } };

/** Server Action: a POST that Next.js only accepts from this site's own Origin. */
export async function decide(code: string, approve: boolean): Promise<DecideResult> {
  const user = await currentUser();
  if (!user) return { error: { code: 'unauthorized', message: 'Sign in again.' } };
  try {
    const hub = await getHub();
    return { result: await (approve ? hub.approveDevice(code, user) : hub.denyDevice(code, user)) };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { error: { code: err.code ?? 'internal_error', message: err.message ?? 'Failed' } };
  }
}

export type LookupResult = { lookup: ApproveDeviceProps['lookup'] } | { error: { code: string; message: string } };

/** Server Action: looks up a code the user typed on the page (counts against the failed-code limit). */
export async function lookupTyped(code: string): Promise<LookupResult> {
  const user = await currentUser();
  if (!user) return { error: { code: 'unauthorized', message: 'Sign in again.' } };
  try {
    return { lookup: await (await getHub()).lookupDevice(code.slice(0, 32), user) };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { error: { code: err.code ?? 'internal_error', message: err.message ?? 'Failed' } };
  }
}
