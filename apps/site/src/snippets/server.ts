import { createServer } from 'node:http';
import { createHub, toNodeHandler } from '@uncage/hub';
import { getSessionUser } from './lib/auth.ts';
import { publishPage } from './lib/tools.ts';

const hub = await createHub({
  publicUrl: 'https://your.site',
  getUser: getSessionUser, // your existing sign-in
  tools: [publishPage],
  sessionStorage: 'site', // keep every conversation
});

const server = createServer(toNodeHandler(hub));
hub.attach(server); // users' machines dial in here
server.listen(3000);
