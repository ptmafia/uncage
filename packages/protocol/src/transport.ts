import { z } from 'zod';
import { AgentFrameSchema, HubFrameSchema } from './connected.js';
import { MAX_FRAME_BYTES, parseFrame } from './frame-parse.js';

/**
 * HTTP streaming transport (FaaS mode).
 *
 * - `POST <base>/agent/connect` → `HttpConnectResponse` (replaces the WebSocket `hello`/`welcome`).
 * - `GET <base>/agent/stream?link=<linkId>&cursor=<n>` → NDJSON `StreamLine`s: outbox items with a
 *   monotonic `seq` (starting at 1) and control lines; the server ends the stream with `rotate`.
 * - `POST <base>/agent/events` with an `HttpEventsRequest` → `HttpEventsResponse`. Each upstream
 *   message carries an agent-chosen idempotent id the hub dedupes.
 */

/** Largest upstream request body (and file-pull chunk request), in UTF-8 bytes. */
export const MAX_HTTP_BODY_BYTES = 1_048_576;
/** `Content-Type` of the downstream stream. */
export const HTTP_STREAM_CONTENT_TYPE = 'application/x-ndjson; charset=utf-8';
/** Agent-generated idempotent id of one upstream message. */
export const UPSTREAM_ID = /^up_[A-Za-z0-9_-]{16,64}$/;

/** Agent → hub messages allowed upstream over HTTP (no hello/pong: connect replaces hello, the stream replaces ping/pong). */
export const UpstreamMessageSchema = z.object({
  id: z.string().regex(UPSTREAM_ID),
  msg: AgentFrameSchema.refine((f) => f.t !== 'hello' && f.t !== 'pong', { message: 'hello and pong are not sent upstream over HTTP' }),
});
export type UpstreamMessage = z.infer<typeof UpstreamMessageSchema>;

export const HttpConnectResponseSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('welcome'),
    machineId: z.string(),
    protocol: z.number().int(),
    minAgentVersion: z.string(),
    linkId: z.string().regex(/^lnk_[0-9a-f]{24}$/),
    /** Highest outbox `seq` already acknowledged; open the stream with this cursor. */
    cursor: z.number().int().nonnegative(),
    replies: z.array(HubFrameSchema),
  }),
  z.object({ t: z.literal('upgrade_required'), minAgentVersion: z.string() }),
]);
export type HttpConnectResponse = z.infer<typeof HttpConnectResponseSchema>;

export const HttpEventsRequestSchema = z.object({
  linkId: z.string(),
  /** Highest outbox `seq` the agent has processed; lets the hub delete delivered items. */
  ack: z.number().int().nonnegative().optional(),
  /** The agent still has work in flight (keeps the hub in its fast polling mode). */
  busy: z.boolean(),
  msgs: z.array(UpstreamMessageSchema).max(500),
});
export type HttpEventsRequest = z.infer<typeof HttpEventsRequestSchema>;

export const HttpEventsResponseSchema = z.object({
  /** Ids handled now or earlier (duplicates); the agent drops them. */
  processed: z.array(z.string()),
  /** Ids the hub could not take yet; the agent resends them, in order, in a later batch. */
  retry: z.array(z.string()),
  replies: z.array(HubFrameSchema),
});
export type HttpEventsResponse = z.infer<typeof HttpEventsResponseSchema>;

export const StreamLineSchema = z.union([
  z.object({ seq: z.number().int().positive(), msg: HubFrameSchema }),
  z.object({ ctl: z.enum(['ping', 'rotate', 'replaced', 'revoked']), at: z.number().optional() }),
]);
export type StreamLine = z.infer<typeof StreamLineSchema>;

/** Parse a raw `POST /agent/events` body. Throws `ProtocolFrameError` (`code: 'invalid_request'`). */
export function parseHttpEventsRequest(raw: string): HttpEventsRequest {
  return parseFrame(raw, HttpEventsRequestSchema, 'events request', MAX_HTTP_BODY_BYTES);
}

/** Parse one NDJSON line of the downstream stream. Throws `ProtocolFrameError` (`code: 'invalid_request'`). */
export function parseStreamLine(raw: string): StreamLine {
  return parseFrame(raw, StreamLineSchema, 'stream line', MAX_FRAME_BYTES);
}
