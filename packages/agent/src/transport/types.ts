import type { AgentFrame, HubFrame, TransportKind } from '@uncage/protocol';

export interface AgentLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface AgentTiming {
  /** Reconnect backoff: starts here, doubles per failed attempt (with jitter). Default 1 000. */
  backoffMinMs: number;
  /** Default 30 000. */
  backoffMaxMs: number;
  /**
   * A `tool_call` without `tool_result` fails with `tool_failed` after this. Default 150 000: longer
   * than the hub's own limit (`toolTimeoutMs` 120 000 + 10 000 lease grace), so the hub's answer
   * (result or "timed out on the website") normally arrives first.
   */
  toolTimeoutMs: number;
  /** No data from the hub for this long → the connection is presumed dead. Default 35 000 (hub pings every 10 s). */
  idleTimeoutMs: number;
  /** The backoff only resets after a connection stayed up this long. Default 30 000. */
  stableMs: number;
  /** A chunked attachment upload with no frame for this long is dropped. Default 60 000. */
  uploadIdleMs: number;
  /**
   * Consecutive WebSocket attempts that never got a `welcome` or lasted less than `stableMs` before
   * the agent switches to HTTP streaming (when the site offers it). Default 3.
   */
  wsFallbackAfter: number;
  /** After falling back to HTTP, WebSocket is tried again after this long. Default 1 800 000 (30 min). */
  wsReprobeMs: number;
  /** HTTP upstream retries (hub answered `retry`, or the POST failed): 500 ms doubling up to this. Default 10 000. */
  httpRetryMaxMs: number;
}

export const DEFAULT_TIMING: AgentTiming = {
  backoffMinMs: 1000,
  backoffMaxMs: 30_000,
  toolTimeoutMs: 150_000,
  idleTimeoutMs: 35_000,
  stableMs: 30_000,
  uploadIdleMs: 60_000,
  wsFallbackAfter: 3,
  wsReprobeMs: 1_800_000,
  httpRetryMaxMs: 10_000,
};

/** Exponential backoff with jitter: a random delay in [base/2, base], base = min(max, min·2^attempt). */
export function backoffDelay(attempt: number, t: Pick<AgentTiming, 'backoffMinMs' | 'backoffMaxMs'>, random = Math.random): number {
  const base = Math.min(t.backoffMaxMs, t.backoffMinMs * 2 ** Math.min(attempt, 30));
  return Math.round(base / 2 + random() * (base / 2));
}

/** A frame that can never be sent (larger than the transport allows): retrying will not help. */
export class FrameTooLargeError extends Error {
  constructor(t: string) {
    super(`frame "${t}" too large`);
    this.name = 'FrameTooLargeError';
  }
}

/** Why a link ended. `stop`: the site must not simply reconnect. */
export type LinkEnd = { welcomed: boolean; upMs: number; stop?: 'revoked' | 'replaced' | 'upgrade'; minAgentVersion?: string };

/** One connection to a hub over one transport, from dial to end. */
export interface AgentLink {
  readonly kind: TransportKind;
  /**
   * Resolves once the frame is handed over. ws: written to the socket; http: listed in `processed`
   * by the hub (retried with the same `up_` id until then). Rejects with `machine_offline` when the
   * link is not welcomed or ends first, `FrameTooLargeError` for an oversized frame.
   */
  send(f: AgentFrame): Promise<void>;
  readonly ended: Promise<LinkEnd>;
  /** Ends the link (HTTP: also tells the hub, so the machine goes offline at once). */
  close(): void;
}

/**
 * Whether an error body (`{ error: { code } }`, JSON text or parsed) is the hub's own "unknown or
 * revoked machine token". Only that 401 means revoked: a 401 from a proxy or a deployment
 * protection page in front of the site (Vercel, Cloudflare Access) is retried.
 */
export function isHubUnauthorized(body: unknown): boolean {
  let v = body;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return false;
    }
  }
  const err = v && typeof v === 'object' ? (v as { error?: unknown }).error : undefined;
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'unauthorized';
}

export interface DialOptions {
  hubUrl: string;
  /**
   * The transport URL the hub offered (`/agent/info` `transports[].url`), already checked to be on
   * the site's host with a safe scheme (`offeredTransportUrl`). Default: derived from `hubUrl`
   * (`<hubUrl>/agent`, ws(s) for WebSocket).
   */
  url?: string;
  token: string;
  hello: Omit<Extract<AgentFrame, { t: 'hello' }>, 'transport'>;
  /** The hub accepted the link. ws: `replies` is empty (follow-up frames arrive through `onFrame`). */
  onWelcome(w: { machineId: string; replies: HubFrame[] }): void;
  /** A hub frame after the welcome (never `welcome`, `ping` or `upgrade_required`). */
  onFrame(f: HubFrame): void;
  /**
   * http: highest outbox seq dispatched, kept for the process lifetime.
   *
   * Crash semantics: a command dispatched but not yet acknowledged when the agent process dies is
   * delivered again to the next process and runs again (dedupe is per process). A command acknowledged whose result never reached the hub before the crash is lost:
   * the website request times out (`commandTimeoutMs`). Within one process, results not accepted
   * by the hub are re-sent after every welcome.
   */
  cursor: { get(): number; set(seq: number): void };
  /** A run in progress or a tool call pending (keeps the hub in fast polling). */
  busy(): boolean;
  timing: AgentTiming;
  fetch: typeof fetch;
  logger: AgentLogger;
  /** For log lines. */
  siteId?: string;
}
