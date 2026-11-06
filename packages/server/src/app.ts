import type { AddressInfo } from 'node:net';
import { UncageError, type Uncage } from '@uncage/core';
import { newId } from '@uncage/protocol';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { authHook } from './auth.js';
import type { RouteContext } from './context.js';
import { sendError, toUncageError } from './errors.js';
import { approvalRoutes } from './routes/approvals.js';
import { healthRoutes } from './routes/health.js';
import { runRoutes } from './routes/runs.js';
import { runtimeRoutes } from './routes/runtimes.js';
import { sessionRoutes } from './routes/sessions.js';

export interface ServerOptions {
  uncage: Uncage;
  token: string;
  /** Defaults to 4783. `0` picks a free port at `listen()`. */
  port?: number;
  host?: '127.0.0.1';
  /** Browser origins allowed to call the API directly. Defaults to `[]`. */
  allowedOrigins?: string[];
  /** SSE heartbeat interval. Defaults to 15000. */
  heartbeatMs?: number;
  logger?: Logger;
}

export interface UncageServer {
  app: FastifyInstance;
  /** Starts listening on 127.0.0.1 and resolves to the base URL, e.g. `http://127.0.0.1:4783`. */
  listen(): Promise<string>;
  /** Stops accepting connections and ends open event streams. Does not close `uncage`. */
  close(): Promise<void>;
}

export const DEFAULT_PORT = 4783;
const DEFAULT_HEARTBEAT_MS = 15_000;

export async function createUncageServer(o: ServerOptions): Promise<UncageServer> {
  if (!o.token) throw new Error('createUncageServer: token is required');
  const host = o.host ?? '127.0.0.1';
  let port = o.port ?? DEFAULT_PORT;

  const app: FastifyInstance = Fastify({
    ...(o.logger ? { loggerInstance: o.logger as FastifyBaseLogger } : { logger: false }),
    genReqId: () => newId('req'),
  });

  const shutdown = new AbortController();
  app.addHook('preClose', async () => shutdown.abort());

  app.addHook('onRequest', authHook({ token: o.token, allowedOrigins: o.allowedOrigins ?? [], port: () => port }));

  app.setErrorHandler((err, request, reply) => {
    const uerr = toUncageError(err);
    if (uerr.code === 'internal_error' && !(err instanceof UncageError)) request.log.error({ err }, 'request failed');
    return sendError(reply, request, uerr);
  });
  app.setNotFoundHandler((request, reply) =>
    sendError(reply, request, new UncageError('not_found', { message: `No route for ${request.method} ${request.url}.` })),
  );

  const ctx: RouteContext = { uncage: o.uncage, heartbeatMs: o.heartbeatMs ?? DEFAULT_HEARTBEAT_MS, shutdown: shutdown.signal };
  for (const routes of [healthRoutes, runtimeRoutes, sessionRoutes, runRoutes, approvalRoutes]) routes(app, ctx);
  await app.ready();

  let closing: Promise<void> | undefined;
  return {
    app,
    async listen() {
      await app.listen({ host, port });
      port = (app.server.address() as AddressInfo).port;
      return `http://${host}:${port}`;
    },
    close: () => (closing ??= app.close()),
  };
}
