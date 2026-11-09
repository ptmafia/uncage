/* global process, console */
// The real hub for the Linux full-chain check: createHub + PGlite + WebSockets on 127.0.0.1:3000
// (the agent container shares this container's network namespace, so loopback http is allowed).
// Test-only routes: POST /test/approve {"code"} approves a device code as user "u1".
import { createServer } from 'node:http';
import { createHub } from '@uncage/hub';
import { attachWebSocket, pgliteHubStore, toNodeHandler } from '@uncage/hub/node';

const store = await pgliteHubStore({ dataDir: 'memory://' });
const hub = await createHub({
  publicUrl: 'http://127.0.0.1:3000',
  store,
  getUser: async (req) => {
    const id = req.headers.get('x-user');
    return id ? { id } : null;
  },
});
const node = toNodeHandler(hub);
const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/test/approve') {
    let body = '';
    for await (const c of req) body += c;
    const { code } = JSON.parse(body);
    const r = await hub.approveDevice(code, { id: 'u1' });
    res.writeHead(r === 'ok' ? 200 : 409, { 'content-type': 'application/json' }).end(JSON.stringify({ result: r }));
    return;
  }
  node(req, res);
});
attachWebSocket(hub, server);
server.listen(3000, '0.0.0.0', () => console.log('HUB READY http://127.0.0.1:3000/api/uncage'));
const stop = async () => {
  await hub.close();
  server.close();
  await store.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
