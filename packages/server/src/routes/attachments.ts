import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { UncageError } from '@uncage/core';
import { ATTACHMENT_LIMITS } from '@uncage/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RouteContext } from '../context.js';
import { downloadHeaders } from '../wire.js';

type IdParams = { Params: { id: string } };

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

/** Upload bytes discarded after a rejection before the connection is dropped instead. */
const MAX_DISCARD_BYTES = 8 * ATTACHMENT_LIMITS.maxBytes;
/** How long a rejected upload may keep sending before the connection is dropped. */
export const DISCARD_TIMEOUT_MS = 30_000;

/**
 * After a rejected upload the client may still be sending. Reading and dropping the rest (rather
 * than closing the socket) lets it receive the error reply instead of a connection reset; a client
 * that keeps going past `MAX_DISCARD_BYTES` or `timeoutMs` is cut off (destroying the request
 * destroys its socket).
 */
export function discardRest(raw: Readable, timeoutMs = DISCARD_TIMEOUT_MS): void {
  let discarded = 0;
  const timer = setTimeout(() => raw.destroy(), timeoutMs);
  timer.unref();
  const stop = () => clearTimeout(timer);
  raw.once('end', stop);
  raw.once('close', stop);
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
