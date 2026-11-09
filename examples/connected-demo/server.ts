/**
 * The demo's traditional-mode entry (Railway, Docker, `pnpm dev`; see lib/mode.ts): one Node `http`
 * server carrying
 *   - the Uncage hub's browser API and device endpoints under /api/uncage (`toNodeHandler(hub)`),
 *   - the machines' WebSockets at /api/uncage/agent (`attachWebSocket(hub, server)`),
 *   - everything else: the Next.js app (pages, server actions, /asset-files).
 *
 *   pnpm dev                    # next dev mode
 *   pnpm build && pnpm start    # production mode
 *
 * Started without this file (`next start`, Vercel), the same app runs in FaaS mode instead: the
 * route handler app/api/uncage/[[...path]]/route.ts serves the hub (`pnpm start:faas`).
 *
 * Env: PORT (3200), HOST (127.0.0.1), PUBLIC_URL (http://localhost:$PORT), DEMO_DATA_DIR (./.data),
 * DATABASE_URL + REDIS_URL (multi-node), TRUST_PROXY=1 (behind scripts/multinode.ts).
 */
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWebSocket, toNodeHandler } from '@uncage/hub/node';
import next from 'next';
import { assetStore } from './lib/assets.ts';
import { isPublicDemo, publicUrl } from './lib/config.ts';
import { createDemoHub, PUBLIC_ASSET_MAX_AGE_MS } from './lib/hub.ts';
import { publishHub } from './lib/hub-registry.ts';

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT || 3200);
const host = process.env.HOST || '127.0.0.1';
const dir = dirname(fileURLToPath(import.meta.url));

const { hub, close: closeHub } = await createDemoHub({ mode: 'traditional' });
publishHub(hub); // also what puts this process in traditional mode (lib/mode.ts)
const hubHandler = toNodeHandler(hub);

const server = createServer();
const app = next({ dev, dir, hostname: host, port, httpServer: server });
const handle = app.getRequestHandler();
await app.prepare();

server.on('request', (req, res) => {
  // Hub paths are answered by the hub; anything else falls through to Next.js.
  hubHandler(req, res, () => {
    handle(req, res).catch((err: unknown) => {
      console.error(err);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  });
});

attachWebSocket(hub, server); // machine WebSockets at <basePath>/agent
if (dev) {
  // Next's own upgrades (HMR); the hub ignores paths that are not its own.
  const upgrade = app.getUpgradeHandler();
  const agentPath = `${hub.basePath}/agent`;
  server.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== agentPath) void upgrade(req, socket, head);
  });
}

if (isPublicDemo()) {
  // Guests' pages are throwaway: drop anything older than a day, now and hourly.
  const sweep = (): void => {
    assetStore()
      .purgeOlderThan(PUBLIC_ASSET_MAX_AGE_MS)
      .then((n) => console.log(`purged ${n} expired asset(s)`))
      .catch((err: unknown) => console.error('asset purge failed', err));
  };
  sweep();
  setInterval(sweep, 3600_000).unref();
}

server.listen(port, host, () => {
  console.log(`ready ${publicUrl()} (listening on http://${host}:${port}, ${dev ? 'dev' : 'production'})`);
});

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(1), 10_000).unref();
  server.closeAllConnections();
  server.close();
  Promise.allSettled([closeHub(), app.close()]).then(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
