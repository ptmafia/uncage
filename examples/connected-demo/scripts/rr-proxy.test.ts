import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startProxy } from './rr-proxy.ts';

const servers: Server[] = [];
const upgraded = new Set<{ destroy(): void }>();
afterEach(async () => {
  // Backends' upgraded sockets (the proxy cuts its own in closeAllConnections).
  for (const u of upgraded) u.destroy();
  upgraded.clear();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

async function backend(name: string): Promise<number> {
  const s = createServer((req, res) => res.end(`${name} ${req.method} ${req.url} xff=${req.headers['x-forwarded-for']}`));
  s.on('upgrade', (req, socket) => {
    upgraded.add(socket);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\nX-Backend: ${name}\r\n\r\n`);
    socket.on('data', (d) => socket.write(`${name}:${d}`));
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return (s.address() as AddressInfo).port;
}

describe('round-robin dev proxy', () => {
  it('alternates HTTP requests across nodes and appends X-Forwarded-For', async () => {
    const targets = [{ host: '127.0.0.1', port: await backend('a') }, { host: '127.0.0.1', port: await backend('b') }];
    const proxy = await startProxy(0, targets);
    servers.push(proxy);
    const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    const bodies = [];
    const nodes = [];
    for (let i = 0; i < 4; i++) {
      const res = await fetch(`${url}/p?i=${i}`, { headers: { 'x-forwarded-for': '9.9.9.9' } });
      nodes.push(res.headers.get('x-upstream-node'));
      bodies.push(await res.text());
    }
    // Which node answered, so tests can prove every node served traffic.
    expect(nodes).toEqual(['1', '2', '1', '2']);
    expect(bodies).toEqual([
      'a GET /p?i=0 xff=9.9.9.9, 127.0.0.1',
      'b GET /p?i=1 xff=9.9.9.9, 127.0.0.1',
      'a GET /p?i=2 xff=9.9.9.9, 127.0.0.1',
      'b GET /p?i=3 xff=9.9.9.9, 127.0.0.1',
    ]);
  });

  it('tunnels upgrades (WebSockets) to a node, both directions', async () => {
    const targets = [{ host: '127.0.0.1', port: await backend('a') }];
    const proxy = await startProxy(0, targets);
    servers.push(proxy);
    const port = (proxy.address() as AddressInfo).port;
    const echoed = await new Promise<string>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/agent', headers: { connection: 'Upgrade', upgrade: 'echo' } });
      req.on('upgrade', (res, socket) => {
        expect(res.headers['x-backend']).toBe('a');
        socket.once('data', (d) => {
          socket.destroy();
          resolve(d.toString());
        });
        socket.write('ping');
      });
      req.on('error', reject);
      req.end();
    });
    expect(echoed).toBe('a:ping');
  });

  it('answers 502 when a node is down', async () => {
    const proxy = await startProxy(0, [{ host: '127.0.0.1', port: 1 }]);
    servers.push(proxy);
    const res = await fetch(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}/`);
    expect(res.status).toBe(502);
  });
});
