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
  /**
   * Title and body per event; `null` sends nothing. Defaults to `defaultPushMessage` (short generic
   * English messages without conversation content; see there for what leaves your hub).
   */
  message?(e: AttentionEvent): { title: string; body: string } | null;
  /**
   * Opt in to putting the session title and the approval's title (often a shell command or a file
   * path) into the default message. They then travel through Expo and Apple / Google and show on
   * the lock screen. Default `false`. Ignored when you pass `message`.
   */
  includeContent?: boolean;
  /** A token Expo reports as `DeviceNotRegistered` (app uninstalled): delete it from your database. */
  onInvalidToken?(token: string): void | Promise<void>;
  /** Defaults to `EXPO_PUSH_ENDPOINT`. */
  endpoint?: string;
  /** A request to Expo still unanswered after this is aborted (the call rejects). Default 15 000 ms. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Longest title or body `defaultPushMessage` produces, in characters (an ellipsis included). */
const MAX_PUSH_TEXT = 180;

/** One line (newlines and runs of spaces collapsed), at most `MAX_PUSH_TEXT` characters. */
function pushText(s: string): string {
  const line = s.replace(/\s+/g, ' ').trim();
  const chars = [...line];
  return chars.length <= MAX_PUSH_TEXT ? line : `${chars.slice(0, MAX_PUSH_TEXT - 1).join('').trimEnd()}…`;
}

/**
 * The default messages (English; pass `message` to localize).
 *
 * **What leaves your hub**: the message goes to Expo, then Apple (APNs) or Google (FCM), and shows
 * on the lock screen. By default it is generic ("An approval needs you", "A run finished", "A run
 * failed") and carries no conversation content: the app opens the right screen from the push
 * `data` (`sessionId`, `approvalId`, `kind`) and loads the details over its signed-in connection.
 *
 * With `includeContent: true` (an explicit opt-in) the text also has the session title and, for
 * an approval, the approval's `title`: the runtime's summary of the tool call, often the shell
 * command or the file it touches. Nothing else from the event (no tool input, output or file
 * contents) is included, and each text is cut to one line of at most 180 characters.
 */
export function defaultPushMessage(e: AttentionEvent, opts: { includeContent?: boolean } = {}): { title: string; body: string } {
  const out = (title: string, body: string) => ({ title: pushText(title), body: pushText(body) });
  if (!opts.includeContent) {
    switch (e.kind) {
      case 'approval_requested':
        return out('An approval needs you', 'Open the app to review it.');
      case 'run_completed':
        return out('A run finished', 'Open the app to see the result.');
      case 'run_failed':
        return out('A run failed', 'Open the app to see what happened.');
    }
  }
  switch (e.kind) {
    case 'approval_requested': {
      const what = e.approval?.title || 'Your agent is waiting for your approval.';
      return out('Approval needed', e.sessionTitle ? `${e.sessionTitle}: ${what}` : what);
    }
    case 'run_completed':
      return out('Run finished', e.sessionTitle || 'Your agent finished.');
    case 'run_failed':
      return out('Run failed', e.sessionTitle || 'Your agent stopped with an error.');
  }
}

type Ticket = { status: 'ok'; id?: string } | { status: 'error'; message?: string; details?: { error?: string; expoPushToken?: string } };

/**
 * An `onAttention` handler that sends Expo push notifications to the user's devices: one message
 * per token, in requests of at most 100, with `data: { sessionId, approvalId?, kind }` for the app
 * to open the right screen. The default text has no conversation content (`includeContent` opts
 * in; see `defaultPushMessage`). Tokens Expo reports as `DeviceNotRegistered` go to `onInvalidToken`.
 * Rejects (the hub logs it) when a request fails or times out (`timeoutMs`), when `onInvalidToken`
 * throws, or when Expo refused messages for another reason (e.g. `InvalidCredentials`: error codes
 * and counts only, never tokens). Several failures reject with an `AggregateError` (all of them in
 * `errors`). Uses only `fetch` (any platform).
 */
export function expoPushNotifier(o: ExpoPushNotifierOptions): OnAttention {
  const includeContent = o.includeContent === true;
  const message = o.message ?? ((e: AttentionEvent) => defaultPushMessage(e, { includeContent }));
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
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      const first = failures[0] instanceof Error ? `: ${failures[0].message}` : '';
      throw new AggregateError(failures, `Expo push failed (${failures.length} failures)${first}`);
    }
    const counts = new Map<string, number>();
    for (const code of ok.flatMap((r) => r.errors)) counts.set(code, (counts.get(code) ?? 0) + 1);
    if (counts.size > 0) {
      throw new Error(`Expo push tickets failed: ${[...counts].map(([c, n]) => `${c} ×${n}`).join(', ')}`);
    }
  };
}
