/**
 * Framework-free wire helpers shared by the daemon and `@uncage/hub` (which serves the same
 * browser API Fetch-style). Imports nothing from fastify or @uncage/core.
 */
import { ERROR_CATALOG, type Attachment, type ErrorBody, type ErrorCode, type UncageEvent } from '@uncage/protocol';

export { toNodeHandler, type FetchHandlers, type UncageNodeHandler } from './node-handler.js';

export const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
} as const;

/** One SSE frame: `id` (event id, for Last-Event-ID resume), `event` (type), `data` (JSON). */
export const formatEvent = (e: UncageEvent): string =>
  `id: ${e.eventId}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

/** The `event: error` frame that ends a stream whose replay failed. */
export const formatErrorFrame = (body: ErrorBody): string => `event: error\ndata: ${JSON.stringify(body)}\n\n`;

/** SSE comment line sent every heartbeat interval so proxies keep the stream open. */
export const SSE_HEARTBEAT = ': ping\n\n';

/** `{ error: ErrorBody }` with the status from the error catalog. */
export function errorResponse(
  code: ErrorCode,
  opts: { message?: string; hint?: string; details?: Record<string, unknown>; requestId?: string } = {},
): Response {
  const entry = ERROR_CATALOG[code];
  const error: ErrorBody = {
    code,
    message: opts.message ?? entry.message,
    hint: opts.hint ?? entry.hint,
    retryable: entry.retryable,
    ...(opts.details ? { details: opts.details } : {}),
    ...(opts.requestId ? { requestId: opts.requestId } : {}),
  };
  return Response.json({ error }, { status: entry.status });
}

/** Image types a browser may render inline; anything else is served as a download. */
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** RFC 5987 `value-chars`: percent-encode everything but attr-char. */
const rfc5987 = (s: string): string =>
  encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Plain-ASCII fallback for clients that ignore `filename*`. */
const asciiFallback = (s: string): string => s.replace(/[^\x20-\x7e]|["\\]/g, '_').replace(/_+/g, '_');

/** Response headers for an attachment download (inline only for safe image types; never script). */
export function downloadHeaders(a: Attachment, size: number): Record<string, string> {
  const inline = a.kind === 'image' && INLINE_IMAGE_TYPES.has(a.mime);
  return {
    'content-type': inline || a.kind === 'file' ? a.mime : 'application/octet-stream',
    'content-length': String(size),
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${asciiFallback(a.name)}"; filename*=UTF-8''${rfc5987(a.name)}`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, max-age=31536000, immutable',
    // Opened directly in a tab (e.g. through the same-origin proxy), the file must not run script.
    'content-security-policy': "default-src 'none'; sandbox",
  };
}
