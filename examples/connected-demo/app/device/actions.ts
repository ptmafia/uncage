'use server';

import { getHub } from '../../lib/hub-registry.ts';
import { currentUser } from '../../lib/session.ts';

export type DecideResult = { result: 'ok' | 'not_found' | 'expired' } | { error: { code: string; message: string } };

/** Server Action: a POST that Next.js only accepts from this site's own Origin. */
export async function decide(code: string, approve: boolean): Promise<DecideResult> {
  const user = await currentUser();
  if (!user) return { error: { code: 'unauthorized', message: 'Sign in again.' } };
  try {
    const hub = getHub();
    return { result: await (approve ? hub.approveDevice(code, user) : hub.denyDevice(code, user)) };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { error: { code: err.code ?? 'internal_error', message: err.message ?? 'Failed' } };
  }
}
