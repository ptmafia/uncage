import type {
  ActiveRunInfo,
  ApprovalDecision,
  ApprovalRequest,
  Attachment,
  CreateSessionBody,
  ErrorBody,
  MachineInfo,
  Run,
  RuntimeInfo,
  Session,
  SessionSettings,
  SessionSnapshot,
  StartRunBody,
  UncageEvent,
} from '@uncage/protocol';
import { ERROR_REASONS, UncageClientError } from './errors.js';
import { isErrorBody, isUncageEvent } from './guards.js';
import { parseSSE } from './sse.js';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface SubscribeHandlers {
  after: number;
  onEvent(e: UncageEvent): void;
  onState?(s: ConnectionState): void;
  onError?(e: UncageClientError): void;
}

/** `GET <base>/machines/install` (hub only): the commands that connect a computer. */
export interface InstallInfo {
  /** Installs the Uncage CLI (macOS / Linux). */
  install: string;
  /** `uncage setup <url>`: pairs the computer with this website and starts the agent. */
  setup: string;
  /** Windows install command; `null` when the hub serves no Windows installer (custom clients). */
  windows: string | null;
  /**
   * `uncage://connect?url=<setup url>`: connects a computer that already runs Uncage in one click
   * (the OS hands it to the installed agent). Absent on hubs that do not offer it.
   */
  connectUrl?: string;
}

/** A file picked in React Native (e.g. expo-image-picker): a local `file://` or `content://` URI. */
export interface RNFile {
  uri: string;
  name: string;
  type: string;
}

/** `lookupDevice`: what the approve screen shows about a pending code (same shape as the hub's `lookupDevice`). */
export interface DeviceLookup {
  name?: string;
  os?: string;
  expiresAt: string;
  /** Set when approving would re-pair this existing computer instead of adding one. */
  repairsMachine: { id: string; name: string } | null;
}

/** Outcome of approving or denying a device code. */
export type DeviceDecision = 'ok' | 'not_found' | 'expired';

/** `createSession` body; `machineId` (connected mode only) picks the computer that runs it. */
export type CreateSessionRequest = CreateSessionBody & { machineId?: string };

export interface UncageClient {
  health(): Promise<{ ok: true; protocol: '1.0' }>;
  runtimes(): Promise<RuntimeInfo[]>;
  createSession(b: CreateSessionRequest): Promise<Session>;
  listSessions(): Promise<Session[]>;
  snapshot(sessionId: string): Promise<SessionSnapshot>;
  startRun(sessionId: string, b: StartRunBody): Promise<Run>;
  cancelRun(runId: string): Promise<Run>;
  updateSettings(sessionId: string, patch: Partial<SessionSettings>): Promise<Session>;
  /**
   * Uploads a file: a browser `File` (`Blob & { name }`) or, in React Native, a picked file
   * reference `{ uri, name, type }` (read through the runtime's built-in `fetch(uri)`).
   */
  uploadAttachment(sessionId: string, file: (Blob & { name: string }) | RNFile, opts?: { signal?: AbortSignal }): Promise<Attachment>;
  attachmentUrl(attachmentId: string): string;
  listActiveRuns(): Promise<ActiveRunInfo[]>;
  decide(approvalId: string, d: ApprovalDecision, idempotencyKey?: string): Promise<ApprovalRequest>;
  subscribe(sessionId: string, h: SubscribeHandlers): () => void;
  /**
   * Restarts every open subscription at once from its last sequence (no duplicates, no gap),
   * skipping any backoff wait. Call it when a mobile app returns to the foreground. No-op when
   * nothing is subscribed.
   */
  reconnect(): void;
  /**
   * Connected mode (an Uncage hub): the signed-in user's computers. A local daemon has no
   * `/machines` and rejects with status 404, which is how UIs tell the two modes apart.
   */
  machines(): Promise<MachineInfo[]>;
  /** Connected mode: the install and setup commands for connecting a computer. */
  installInfo(): Promise<InstallInfo>;
  /** Connected mode: disconnects (revokes) one of the user's computers. */
  revokeMachine(machineId: string): Promise<void>;
  /** Connected mode: a pending device code for the approve screen, or `null` if unknown / no longer pending. */
  lookupDevice(code: string): Promise<DeviceLookup | null>;
  /** Connected mode: approves (binds the computer to the signed-in user) or denies a device code. */
  decideDevice(code: string, approve: boolean): Promise<DeviceDecision>;
}

export interface UncageClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Extra headers for every request and event stream (e.g. a bearer token); may be async (token refresh). */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
}

const BACKOFF_MS = [500, 1000, 2000, 5000];
const OFFLINE_AFTER_MS = 60_000;
/**
 * Event type of the frame a server writes before ending an event stream on its own initiative
 * (rotation below a platform's response duration limit; `@uncage/server/wire`).
 */
export const STREAM_RECONNECT_EVENT = 'reconnect';
/** A rotated response shorter than this that delivered no event counts as a failure (no spin). */
const MIN_IDLE_ROTATION_MS = 1000;

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

const untilAborted = <T>(p: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** Canonical Content-Type for an upload: browsers often leave `type` empty or send `image/jpg`. */
export function uploadContentType(file: { type: string; name: string }): string {
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
    const error = ((await res.json()) as { error?: unknown } | null)?.error;
    if (isErrorBody(error)) body = error;
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

const isRNFile = (f: unknown): f is RNFile =>
  typeof f === 'object' && f !== null && typeof (f as { uri?: unknown }).uri === 'string' &&
  !(typeof Blob !== 'undefined' && f instanceof Blob);

/** RFC 4122 v4 id; falls back from `crypto.randomUUID` (absent on Hermes) to `getRandomValues` / `Math.random`. */
function randomUUID(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (typeof c?.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

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
  const extraHeaders = async (): Promise<Record<string, string>> => (await o.headers?.()) ?? {};
  /** Restart hooks of the open subscriptions (`reconnect()`). */
  const live = new Set<() => void>();

  async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const init: RequestInit = { method, headers: { accept: 'application/json', ...(await extraHeaders()), ...headers } };
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
    file: (Blob & { name: string }) | RNFile,
    opts: { signal?: AbortSignal } = {},
  ): Promise<Attachment> {
    let body: Blob = file as Blob;
    let type = isRNFile(file) ? file.type : (file as Blob).type;
    if (isRNFile(file)) {
      // React Native's built-in fetch reads local file:// / content:// URIs (the app's streaming
      // fetch, e.g. expo/fetch, may not), so the file is read with the global one.
      const readInit: RequestInit = {};
      if (opts.signal) readInit.signal = opts.signal;
      let read: Response;
      try {
        read = await globalThis.fetch(file.uri, readInit);
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        throw networkError(err);
      }
      if (!read.ok && read.status !== 0) throw await toError(read);
      body = await read.blob();
      type ||= body.type;
    }
    const init: RequestInit = {
      method: 'POST',
      headers: {
        accept: 'application/json',
        ...(await extraHeaders()),
        'content-type': uploadContentType({ type, name: file.name }),
        'x-filename': enc(file.name),
      },
      body,
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
    /** `lastSequence` at which a gap last made us resume (a gap seen again there is accepted). */
    let gapAt: number | undefined;
    let state: ConnectionState | undefined;
    let warned = false;
    /** Aborts the current attempt (fetch, stream or backoff wait); replaced on every attempt. */
    let attempt$: AbortController | undefined;
    let kicked = false;
    const kick = () => {
      kicked = true;
      attempt$?.abort();
    };
    live.add(kick);
    signal.addEventListener('abort', () => live.delete(kick), { once: true });
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
      live.delete(kick);
      setState('offline');
      guard(() => h.onError?.(err));
    };

    const run = async () => {
      setState('connecting');
      let attempt = 0;
      let failingSince: number | undefined;
      let stop: (() => void) | undefined;
      while (!signal.aborted) {
        if (stop) signal.removeEventListener('abort', stop);
        const ctl = new AbortController();
        attempt$ = ctl;
        kicked = false;
        stop = () => ctl.abort();
        signal.addEventListener('abort', stop, { once: true });
        const attemptSignal = ctl.signal;
        try {
          const headers: Record<string, string> = { accept: 'text/event-stream', ...(await extraHeaders()) };
          if (attemptSignal.aborted) throw new Error('restarted');
          if (lastEventId) headers['last-event-id'] = lastEventId;
          // Raced with the abort: a fetch that ignores its signal must not hold up reconnect().
          const res = await untilAborted(
            doFetch(`${baseUrl}/sessions/${enc(sessionId)}/events?after=${lastSequence}`, { headers, signal: attemptSignal }),
            attemptSignal,
          );
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
          const opened = Date.now();
          let delivered = false;
          let rotated = false;
          let gap = false;
          for await (const frame of parseSSE(res.body, attemptSignal)) {
            if (attemptSignal.aborted) break;
            if (frame.event === STREAM_RECONNECT_EVENT) {
              // The server ends this response between two whole frames: resume after the last
              // event at once (Last-Event-ID), without a state change.
              rotated = true;
              break;
            }
            attempt = 0;
            if (frame.event === 'error') {
              const body = safeJson(frame.data);
              if (isErrorBody(body) && body.code === 'event_replay_unavailable') {
                terminal(new UncageClientError(body, 200));
                return;
              }
              continue;
            }
            const event = safeJson(frame.data);
            if (!isUncageEvent(event)) {
              if (!warned) {
                warned = true;
                console.warn('[uncage] dropped malformed SSE event frame');
              }
              continue;
            }
            if (event.sequence <= lastSequence) continue;
            if (event.sequence > lastSequence + 1 && gapAt !== lastSequence) {
              // Never skip: resume after the last event once; a gap the server still has is real.
              gapAt = lastSequence;
              gap = true;
              break;
            }
            lastSequence = event.sequence;
            if (frame.id) lastEventId = frame.id;
            delivered = true;
            guard(() => h.onEvent(event));
          }
          if (gap && !signal.aborted) {
            // Short jitter so many browsers seeing the same gap do not resume in one burst.
            attempt = 0;
            await sleep(100 + Math.random() * 400, attemptSignal);
            continue;
          }
          if (rotated && !signal.aborted) {
            if (delivered || Date.now() - opened >= MIN_IDLE_ROTATION_MS) {
              attempt = 0;
              continue;
            }
            // Rotating faster than anything happens: wait like a failure, but stay live.
            const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
            attempt++;
            await sleep(base * (0.75 + Math.random() * 0.5), attemptSignal);
            continue;
          }
        } catch {
          // fall through to backoff (aborts exit via the loop condition)
        }
        if (signal.aborted) return;
        if (kicked) {
          // reconnect(): resume after the last event at once, without counting a failure.
          attempt = 0;
          continue;
        }
        failingSince ??= Date.now();
        setState(Date.now() - failingSince >= OFFLINE_AFTER_MS ? 'offline' : 'reconnecting');
        const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
        attempt++;
        await sleep(base * (0.75 + Math.random() * 0.5), attemptSignal);
        if (kicked) attempt = 0;
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
      request('POST', `/sessions/${enc(id)}/runs`, b, { 'idempotency-key': randomUUID() }),
    updateSettings: (id, patch) => request('PATCH', `/sessions/${enc(id)}/settings`, patch),
    uploadAttachment,
    attachmentUrl: (id) => `${baseUrl}/attachments/${enc(id)}`,
    listActiveRuns: () => request('GET', '/runs?active=1'),
    cancelRun: (id) => request('POST', `/runs/${enc(id)}/cancel`, {}),
    decide: (id, d, key) =>
      request('POST', `/approvals/${enc(id)}/decision`, d, { 'idempotency-key': key ?? randomUUID() }),
    subscribe,
    reconnect: () => {
      for (const kick of [...live]) kick();
    },
    machines: () => request('GET', '/machines'),
    installInfo: () => request('GET', '/machines/install'),
    revokeMachine: async (id) => {
      await request('DELETE', `/machines/${enc(id)}`);
    },
    lookupDevice: (code) => request('GET', `/device/lookup?code=${enc(code)}`),
    decideDevice: async (code, approve) =>
      (await request<{ result: DeviceDecision }>('POST', '/device/decision', { code, approve })).result,
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
