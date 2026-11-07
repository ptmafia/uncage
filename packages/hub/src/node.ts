import { toNodeHandler as fetchToNode, type UncageNodeHandler } from '@uncage/server/wire';
import type { Hub } from './types.js';

export type { UncageNodeHandler } from '@uncage/server/wire';

/**
 * The hub's browser API as a Node `(req, res, next?)` handler for Express, Connect, Fastify
 * (`reply.hijack()` then `handler(request.raw, reply.raw)`) and `node:http`:
 *
 *   app.use(toNodeHandler(hub));   // serves <basePath>/*; mount before body parsers
 *   hub.attach(server);            // machine WebSockets on the same HTTP server
 *
 * Request URLs are rebuilt from `req.originalUrl` / `req.url`, so mount it without stripping the
 * `basePath` prefix (Express: `app.use(handler)`, not `app.use('/api/uncage', handler)`).
 */
export function toNodeHandler(h: Hub): UncageNodeHandler {
  const handle = (req: Request) => h.handler(req);
  return fetchToNode({ GET: handle, POST: handle, PATCH: handle, DELETE: handle });
}
