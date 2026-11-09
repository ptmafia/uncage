import type { AttentionEvent, OnAttention } from '../attention.js';

/** Expo's push API (`expo-notifications` tokens: `ExponentPushToken[…]`). */
export const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';
/** Expo accepts at most 100 messages per request. */
const BATCH = 100;

export interface ExpoPushNotifierOptions {
  /** The user's Expo push tokens, from your own database (the hub never stores them). */
  tokensFor(userId: string): Promise<string[]>;
  /** Expo access token, when "enhanced push security" is on for your project. */
  accessToken?: string;
  fetch?: typeof fetch;
  /** Title and body per event; `null` sends nothing. Defaults to short English messages. */
  message?(e: AttentionEvent): { title: string; body: string } | null;
  /** A token Expo reports as `DeviceNotRegistered` (app uninstalled): delete it from your database. */
  onInvalidToken?(token: string): void | Promise<void>;
  /** Defaults to `EXPO_PUSH_ENDPOINT`. */
  endpoint?: string;
}

/** The default messages (English; pass `message` to localize). */
export function defaultPushMessage(e: AttentionEvent): { title: string; body: string } {
  switch (e.kind) {
    case 'approval_requested': {
      const what = e.approval?.title ?? 'Your agent is waiting for your approval.';
      return { title: 'Approval needed', body: e.sessionTitle ? `${e.sessionTitle}: ${what}` : what };
    }
    case 'run_completed':
      return { title: 'Run finished', body: e.sessionTitle || 'Your agent finished.' };
    case 'run_failed':
      return { title: 'Run failed', body: e.sessionTitle || 'Your agent stopped with an error.' };
  }
}

type Ticket = { status: 'ok'; id?: string } | { status: 'error'; message?: string; details?: { error?: string; expoPushToken?: string } };

/**
 * An `onAttention` handler that sends Expo push notifications to the user's devices: one message
 * per token, in requests of at most 100, with `data: { sessionId, approvalId?, kind }` for the app
 * to open the right screen. Tokens Expo reports as `DeviceNotRegistered` go to `onInvalidToken`.
 * A failed request rejects (the hub logs it). Uses only `fetch` (any platform).
 */
export function expoPushNotifier(o: ExpoPushNotifierOptions): OnAttention {
  const message = o.message ?? defaultPushMessage;
  const endpoint = o.endpoint ?? EXPO_PUSH_ENDPOINT;
  return async (e) => {
    const m = message(e);
    if (!m) return;
    const tokens = [...new Set(await o.tokensFor(e.userId))];
    if (tokens.length === 0) return;
    const doFetch = o.fetch ?? fetch;
    const data = { sessionId: e.sessionId, ...(e.approval ? { approvalId: e.approval.id } : {}), kind: e.kind };
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (o.accessToken) headers.authorization = `Bearer ${o.accessToken}`;

    const send = async (batch: string[]): Promise<string[]> => {
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(batch.map((to) => ({ to, title: m.title, body: m.body, data, sound: 'default' }))),
      });
      if (!res.ok) throw new Error(`Expo push request failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
      const tickets = ((await res.json()) as { data?: Ticket[] }).data ?? [];
      const invalid: string[] = [];
      tickets.forEach((t, i) => {
        if (t.status === 'error' && t.details?.error === 'DeviceNotRegistered') {
          const token = t.details.expoPushToken ?? batch[i];
          if (token) invalid.push(token);
        }
      });
      return invalid;
    };

    const batches: string[][] = [];
    for (let i = 0; i < tokens.length; i += BATCH) batches.push(tokens.slice(i, i + BATCH));
    const results = await Promise.allSettled(batches.map(send));
    const invalid = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    if (o.onInvalidToken) for (const t of invalid) await o.onInvalidToken(t);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
  };
}
