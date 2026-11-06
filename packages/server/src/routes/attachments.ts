import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { UncageError } from '@uncage/core';
import { ATTACHMENT_LIMITS, type Attachment } from '@uncage/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RouteContext } from '../context.js';

type IdParams = { Params: { id: string } };

/** Image types a browser may render inline; anything else is served as a download. */
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function fileName(request: FastifyRequest): string {
  const raw = request.headers['x-filename'];
  if (typeof raw !== 'string' || raw === '') {
    throw new UncageError('invalid_request', {
      message: 'The X-Filename header is required.',
      hint: 'Send the file name, URI-encoded (encodeURIComponent), in the X-Filename header.',
    });
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new UncageError('invalid_request', { message: 'The X-Filename header is not valid URI-encoded text.' });
  }
}

/** Media type without parameters, lowercased: `Text/Plain; charset=utf-8` → `text/plain`. */
function mediaType(request: FastifyRequest): string {
  const mime = (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (mime === '') throw new UncageError('invalid_request', { message: 'The Content-Type header is required.' });
  return mime;
}

/** RFC 5987 `value-chars`: percent-encode everything but attr-char. */
const rfc5987 = (s: string): string =>
  encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Plain-ASCII fallback for clients that ignore `filename*`. */
const asciiFallback = (s: string): string => s.replace(/[^\x20-\x7e]|["\\]/g, '_').replace(/_+/g, '_');

function downloadHeaders(a: Attachment, size: number): Record<string, string> {
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

/** Upload bytes discarded after a rejection before the connection is dropped instead. */
const MAX_DISCARD_BYTES = 8 * ATTACHMENT_LIMITS.maxBytes;

/**
 * After a rejected upload the client may still be sending. Reading and dropping the rest (rather
 * than closing the socket) lets it receive the error reply instead of a connection reset; a client
 * that keeps going past `MAX_DISCARD_BYTES` is cut off.
 */
function discardRest(raw: Readable): void {
  let discarded = 0;
  raw.on('data', (chunk: Buffer) => {
    discarded += chunk.byteLength;
    if (discarded > MAX_DISCARD_BYTES) raw.destroy();
  });
  raw.on('error', () => undefined);
  raw.resume();
}

export function attachmentRoutes(app: FastifyInstance, { uncage }: RouteContext): void {
  // Raw-body upload lives in its own encapsulated context so the `*` stream parser applies here only.
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_request, payload, done) => done(null, payload));

    scope.post<IdParams>(
      '/v1/sessions/:id/attachments',
      // Core enforces the exact per-runtime limit while streaming; this is only a backstop.
      { bodyLimit: ATTACHMENT_LIMITS.maxBytes + 1 },
      async (request, reply) => {
        const raw = request.body as Readable | undefined;
        try {
          const name = fileName(request);
          const mime = mediaType(request);
          const declared = Number(request.headers['content-length']);
          if (declared > ATTACHMENT_LIMITS.maxBytes) {
            throw new UncageError('attachment_too_large', { details: { maxBytes: ATTACHMENT_LIMITS.maxBytes } });
          }
          // Not destroying the request when core stops reading early keeps the socket open for the reply.
          const body = raw ? raw.iterator({ destroyOnReturn: false }) : new Uint8Array();
          const attachment = await uncage.attachments.add(request.params.id, { name, mime, body });
          return reply.code(201).send(attachment);
        } catch (e) {
          if (raw && !raw.readableEnded) discardRest(raw);
          throw e;
        }
      },
    );
  });

  app.get<IdParams>('/v1/attachments/:id', async (request, reply) => {
    const { attachment, absPath } = await uncage.attachments.get(request.params.id);
    const st = await stat(absPath).catch(() => null);
    if (!st?.isFile()) throw new UncageError('not_found', { message: `Attachment ${attachment.id} not found.` });
    return reply.headers(downloadHeaders(attachment, st.size)).send(createReadStream(absPath));
  });
}
