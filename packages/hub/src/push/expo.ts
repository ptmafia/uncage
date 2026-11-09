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
  /** A request to Expo still unanswered after this is aborted (the call rejects). Default 15 000 ms. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

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
 * Rejects (the hub logs it) when a request fails or times out (`timeoutMs`), when `onInvalidToken`
 * throws, or when Expo refused messages for another reason (e.g. `InvalidCredentials`: error codes
 * and counts only, never tokens). Uses only `fetch` (any platform).
 */
export function expoPushNotifier(o: ExpoPushNotifierOptions): OnAttention {
  const message = o.message ?? defaultPushMessage;
  const endpoint = o.endpoint ?? EXPO_PUSH_ENDPOINT;
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (e) => {
    const m = message(e);
    if (!m) return;
    const tokens = [...new Set(await o.tokensFor(e.userId))];
    if (tokens.length === 0) return;
    const doFetch = o.fetch ?? fetch;
    const data = { sessionId: e.sessionId, ...(e.approval ? { approvalId: e.approval.id } : {}), kind: e.kind };
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (o.accessToken) headers.authorization = `Bearer ${o.accessToken}`;

    const send = async (batch: string[]): Promise<{ invalid: string[]; errors: string[] }> => {
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(batch.map((to) => ({ to, title: m.title, body: m.body, data, sound: 'default' }))),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        // Status and error codes only: Expo's error bodies can echo push tokens, and this gets logged.
        const body = (await res.json().catch(() => null)) as { errors?: Array<{ code?: unknown }> } | null;
        const codes = (body?.errors ?? []).map((e) => e.code).filter((c): c is string => typeof c === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(c));
        throw new Error(`Expo push request failed: HTTP ${res.status}${codes.length ? ` (${codes.join(', ')})` : ''}`);
      }
      const tickets = ((await res.json()) as { data?: Ticket[] }).data ?? [];
      const invalid: string[] = [];
      const errors: string[] = [];
      tickets.forEach((t, i) => {
        if (t.status !== 'error') return;
        if (t.details?.error === 'DeviceNotRegistered') {
          const token = t.details.expoPushToken ?? batch[i];
          if (token) invalid.push(token);
        } else {
          const code = t.details?.error;
          errors.push(typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : 'unknown');
        }
      });
      return { invalid, errors };
    };

    const batches: string[][] = [];
    for (let i = 0; i < tokens.length; i += BATCH) batches.push(tokens.slice(i, i + BATCH));
    const results = await Promise.allSettled(batches.map(send));
    const ok = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    const failures: unknown[] = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
    if (o.onInvalidToken) {
      const reported = await Promise.allSettled(ok.flatMap((r) => r.invalid).map(async (t) => o.onInvalidToken!(t)));
      for (const r of reported) if (r.status === 'rejected') failures.push(r.reason);
    }
    if (failures.length > 0) throw failures[0];
    const counts = new Map<string, number>();
    for (const code of ok.flatMap((r) => r.errors)) counts.set(code, (counts.get(code) ?? 0) + 1);
    if (counts.size > 0) {
      throw new Error(`Expo push tickets failed: ${[...counts].map(([c, n]) => `${c} ×${n}`).join(', ')}`);
    }
  };
}
