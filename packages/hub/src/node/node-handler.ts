import type { IncomingMessage } from 'node:http';
import { toNodeHandler as fetchToNode, type UncageNodeHandler } from '@uncage/server/node-handler';
import type { Hub } from '../types.js';

export type { UncageNodeHandler } from '@uncage/server/node-handler';

const CLIENT_IP_HEADER = 'x-uncage-hub-client-ip';

/** Path of the original request URL (Express keeps it in `originalUrl` when mounted under a prefix). */
function requestPath(req: IncomingMessage & { originalUrl?: string }): string {
  const raw = req.originalUrl ?? req.url ?? '/';
  const q = raw.indexOf('?');
  return q === -1 ? raw : raw.slice(0, q);
}

/**
 * The hub as a Node `(req, res, next?)` middleware for Express, Connect, Fastify
 * (`reply.hijack()` then `handler(request.raw, reply.raw)`) and `node:http`:
 *
 *   app.use(toNodeHandler(hub));                 // or app.use('/api/uncage', toNodeHandler(hub))
 *   attachWebSocket(hub, server);                // machine WebSockets on the same HTTP server
 *
 * Only requests under `hub.basePath` are handled; anything else goes to `next()` untouched (with no
 * `next`, e.g. plain `node:http`, it gets a 404). Paths are read from `req.originalUrl` (Express) or
 * `req.url`, so mounting under the prefix works too. Mount before body parsers. The client IP
 * for rate limits is Express's `req.ip` (set `app.set('trust proxy', …)` behind a proxy), else the
 * socket address.
 */
export function toNodeHandler(h: Hub): UncageNodeHandler {
  const handle = (req: Request) => {
    const clientIp = req.headers.get(CLIENT_IP_HEADER);
    return h.fetch(req, clientIp ? { clientIp } : {});
  };
  const inner = fetchToNode({ GET: handle, POST: handle, PATCH: handle, DELETE: handle });
  return (req, res, next) => {
    const path = requestPath(req);
    if (path !== h.basePath && !path.startsWith(`${h.basePath}/`)) {
      if (next) return next();
      res.statusCode = 404;
      res.end();
      return;
    }
    // Hand the socket address to `fetch` through a header the client cannot pre-set.
    delete req.headers[CLIENT_IP_HEADER];
    // Express's `req.ip` honours `trust proxy`; otherwise the socket address.
    const expressIp = (req as { ip?: unknown }).ip;
    const ip = typeof expressIp === 'string' && expressIp !== '' ? expressIp : req.socket.remoteAddress;
    if (ip) req.headers[CLIENT_IP_HEADER] = ip;
    inner(req, res, next);
  };
}
