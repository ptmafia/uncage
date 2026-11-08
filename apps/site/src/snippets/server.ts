import { createServer } from 'node:http';
import { createHub } from '@uncage/hub';
import { attachWebSocket, pgliteHubStore, toNodeHandler } from '@uncage/hub/node';
import { getSessionUser } from './lib/auth.ts';
import { publishPage } from './lib/tools.ts';

const hub = await createHub({
  publicUrl: 'https://your.site',
  store: await pgliteHubStore({ dataDir: './.uncage-hub' }),
  getUser: getSessionUser, // your existing sign-in
  tools: [publishPage],
  sessionStorage: 'site', // keep every conversation
});

const server = createServer(toNodeHandler(hub));
attachWebSocket(hub, server); // users' machines dial in here
server.listen(3000);
