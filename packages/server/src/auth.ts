import { createHash, timingSafeEqual } from 'node:crypto';
import { UncageError } from '@uncage/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sendError } from './errors.js';

export interface AuthConfig {
  token: string;
  allowedOrigins: readonly string[];
  /** The port the daemon is reachable on; read per request because `listen()` may resolve port 0. */
  port: () => number;
}

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

/**
 * `onRequest` hook enforcing, in order: Host allow-list (DNS-rebinding guard) → Origin allow-list
 * (cross-site guard) → bearer token. Comparing fixed-length digests keeps the token check
 * constant-time without leaking the token length.
 */
export function authHook(cfg: AuthConfig) {
  const expected = digest(cfg.token);
  const origins = new Set(cfg.allowedOrigins);

  return async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    const host = request.headers.host?.toLowerCase();
    const port = cfg.port();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return sendError(
        reply,
        request,
        new UncageError('forbidden_origin', {
          message: 'The request Host header is not allowed.',
          hint: `Connect to http://127.0.0.1:${port} or http://localhost:${port}.`,
        }),
      );
    }

    const origin = request.headers.origin;
    if (origin !== undefined && !origins.has(origin)) {
      return sendError(reply, request, new UncageError('forbidden_origin'));
    }

    const header = request.headers.authorization;
    const match = header === undefined ? null : /^Bearer (.+)$/.exec(header);
    if (!match?.[1] || !timingSafeEqual(digest(match[1]), expected)) {
      return sendError(reply, request, new UncageError('unauthorized'));
    }
    return undefined;
  };
}
