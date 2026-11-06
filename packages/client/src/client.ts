import {
  ErrorBodySchema,
  UncageEventSchema,
  type ActiveRunInfo,
  type ApprovalDecision,
  type ApprovalRequest,
  type Attachment,
  type CreateSessionBody,
  type ErrorBody,
  type Run,
  type RuntimeInfo,
  type Session,
  type SessionSettings,
  type SessionSnapshot,
  type StartRunBody,
  type UncageEvent,
} from '@uncage/protocol';
import { ERROR_REASONS, UncageClientError } from './errors.js';
import { parseSSE } from './sse.js';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface SubscribeHandlers {
  after: number;
  onEvent(e: UncageEvent): void;
  onState?(s: ConnectionState): void;
  onError?(e: UncageClientError): void;
}

export interface UncageClient {
  health(): Promise<{ ok: true; protocol: '1.0' }>;
  runtimes(): Promise<RuntimeInfo[]>;
  createSession(b: CreateSessionBody): Promise<Session>;
  listSessions(): Promise<Session[]>;
  snapshot(sessionId: string): Promise<SessionSnapshot>;
  startRun(sessionId: string, b: StartRunBody): Promise<Run>;
  cancelRun(runId: string): Promise<Run>;
  updateSettings(sessionId: string, patch: Partial<SessionSettings>): Promise<Session>;
  uploadAttachment(sessionId: string, file: Blob & { name: string }, opts?: { signal?: AbortSignal }): Promise<Attachment>;
  attachmentUrl(attachmentId: string): string;
  listActiveRuns(): Promise<ActiveRunInfo[]>;
  decide(approvalId: string, d: ApprovalDecision, idempotencyKey?: string): Promise<ApprovalRequest>;
  subscribe(sessionId: string, h: SubscribeHandlers): () => void;
}

export interface UncageClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  headers?: () => Record<string, string>;
}

const BACKOFF_MS = [500, 1000, 2000, 5000];
const OFFLINE_AFTER_MS = 60_000;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** Canonical Content-Type for an upload: browsers often leave `type` empty or send `image/jpg`. */
export function uploadContentType(file: Blob & { name: string }): string {
  const declared = (file.type.split(';')[0] ?? '').trim().toLowerCase();
  if (declared === 'image/jpg') return 'image/jpeg';
  if (declared) return declared;
  const dot = file.name.lastIndexOf('.');
  const ext = dot < 0 ? '' : file.name.slice(dot + 1).toLowerCase();
  return Object.hasOwn(IMAGE_MIME_BY_EXT, ext) ? IMAGE_MIME_BY_EXT[ext]! : 'application/octet-stream';
}

async function toError(res: Response): Promise<UncageClientError> {
  let body: ErrorBody | undefined;
  try {
    const parsed = ErrorBodySchema.safeParse(((await res.json()) as { error?: unknown }).error);
    if (parsed.success) body = parsed.data;
  } catch {
    // non-JSON error body
  }
  return new UncageClientError(
    body ?? {
      code: 'internal_error',
      message: `Request failed with HTTP ${res.status}.`,
      retryable: res.status >= 500,
      details: { reason: ERROR_REASONS.httpStatus, status: res.status },
    },
    res.status,
  );
}

/** A fetch that never got a response (aborts excepted) → `internal_error` tagged `network`. */
const networkError = (err: unknown): UncageClientError =>
  new UncageClientError(
    {
      code: 'internal_error',
      message: err instanceof Error ? err.message : String(err),
      retryable: true,
      details: { reason: ERROR_REASONS.network },
    },
    0,
  );

export function createUncageClient(o: UncageClientOptions = {}): UncageClient {
  const baseUrl = (o.baseUrl ?? '/api/uncage').replace(/\/+$/, '');
  const rawFetch: typeof fetch = o.fetch ?? ((...args) => globalThis.fetch(...args));
  const doFetch = async (url: string, init: RequestInit): Promise<Response> => {
    try {
      return await rawFetch(url, init);
    } catch (err) {
      if (init.signal?.aborted) throw err;
      throw networkError(err);
    }
  };
  const extraHeaders = () => o.headers?.() ?? {};

  async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const init: RequestInit = { method, headers: { accept: 'application/json', ...extraHeaders(), ...headers } };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)['content-type'] = 'application/json';
    }
    const res = await doFetch(`${baseUrl}${path}`, init);
    if (!res.ok) throw await toError(res);
    return (await res.json()) as T;
  }

  const enc = encodeURIComponent;

  async function uploadAttachment(
    sessionId: string,
    file: Blob & { name: string },
    opts: { signal?: AbortSignal } = {},
  ): Promise<Attachment> {
    const init: RequestInit = {
      method: 'POST',
      headers: {
        accept: 'application/json',
        ...extraHeaders(),
        'content-type': uploadContentType(file),
        'x-filename': enc(file.name),
      },
      body: file,
    };
    if (opts.signal) init.signal = opts.signal;
    const res = await doFetch(`${baseUrl}/sessions/${enc(sessionId)}/attachments`, init);
    if (!res.ok) throw await toError(res);
    return (await res.json()) as Attachment;
  }

  function subscribe(sessionId: string, h: SubscribeHandlers): () => void {
    const controller = new AbortController();
    const { signal } = controller;
    let lastSequence = h.after;
    let lastEventId: string | undefined;
    let state: ConnectionState | undefined;
    let warned = false;
    const setState = (s: ConnectionState) => {
      if (s === state || signal.aborted) return;
      state = s;
      h.onState?.(s);
    };

    // A throwing consumer must neither tear down the stream nor be mistaken for a network failure.
    const guard = (fn: () => void) => {
      try {
        fn();
      } catch (err) {
        console.error('[uncage] subscriber handler threw', err);
        queueMicrotask(() => {
          throw err;
        });
      }
    };
    const terminal = (err: UncageClientError) => {
      setState('offline');
      guard(() => h.onError?.(err));
    };

    const run = async () => {
      setState('connecting');
      let attempt = 0;
      let failingSince: number | undefined;
      while (!signal.aborted) {
        try {
          const headers: Record<string, string> = { accept: 'text/event-stream', ...extraHeaders() };
          if (lastEventId) headers['last-event-id'] = lastEventId;
          const res = await doFetch(`${baseUrl}/sessions/${enc(sessionId)}/events?after=${lastSequence}`, { headers, signal });
          if (!res.ok) {
            const err = await toError(res);
            // Definitive client errors will not fix themselves; the caller must resubscribe.
            if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
              terminal(err);
              return;
            }
            throw err;
          }
          if (!res.body) throw new Error('empty response body');
          setState('live');
          failingSince = undefined;
          for await (const frame of parseSSE(res.body)) {
            attempt = 0;
            if (frame.event === 'error') {
              const parsed = ErrorBodySchema.safeParse(safeJson(frame.data));
              if (parsed.success) {
                if (parsed.data.code === 'event_replay_unavailable') {
                  terminal(new UncageClientError(parsed.data, 200));
                  return;
                }
              }
              continue;
            }
            const parsed = UncageEventSchema.safeParse(safeJson(frame.data));
            if (!parsed.success) {
              if (!warned) {
                warned = true;
                console.warn('[uncage] dropped malformed SSE event frame');
              }
              continue;
            }
            if (parsed.data.sequence <= lastSequence) continue;
            lastSequence = parsed.data.sequence;
            if (frame.id) lastEventId = frame.id;
            guard(() => h.onEvent(parsed.data));
          }
        } catch {
          // fall through to backoff (aborts exit via the loop condition)
        }
        if (signal.aborted) return;
        failingSince ??= Date.now();
        setState(Date.now() - failingSince >= OFFLINE_AFTER_MS ? 'offline' : 'reconnecting');
        const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
        attempt++;
        await sleep(base * (0.75 + Math.random() * 0.5), signal);
      }
    };
    void run();
    return () => controller.abort();
  }

  return {
    health: () => request('GET', '/health'),
    runtimes: () => request('GET', '/runtimes'),
    createSession: (b) => request('POST', '/sessions', b),
    listSessions: () => request('GET', '/sessions'),
    snapshot: (id) => request('GET', `/sessions/${enc(id)}`),
    startRun: (id, b) =>
      request('POST', `/sessions/${enc(id)}/runs`, b, { 'idempotency-key': globalThis.crypto.randomUUID() }),
    updateSettings: (id, patch) => request('PATCH', `/sessions/${enc(id)}/settings`, patch),
    uploadAttachment,
    attachmentUrl: (id) => `${baseUrl}/attachments/${enc(id)}`,
    listActiveRuns: () => request('GET', '/runs?active=1'),
    cancelRun: (id) => request('POST', `/runs/${enc(id)}/cancel`, {}),
    decide: (id, d, key) =>
      request('POST', `/approvals/${enc(id)}/decision`, d, { 'idempotency-key': key ?? globalThis.crypto.randomUUID() }),
    subscribe,
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
