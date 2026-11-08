/**
 * A tiny round-robin HTTP + WebSocket proxy for multi-node dev mode: each new request or upgrade
 * goes to the next node, like a load balancer without sticky sessions. So a machine's WebSocket
 * and the browser's requests usually land on different hub nodes. Dev only: no TLS, no health
 * checks (a down node answers 502). HTTP responses carry `x-upstream-node: <n>` (which node
 * answered).
 */
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import { connect } from 'node:net';

export interface Target {
  host: string;
  port: number;
}

/** Appends the client's address, as a real proxy would (the hub's per-IP limits read it). */
function forwardedFor(req: IncomingMessage): string {
  const prior = req.headers['x-forwarded-for'];
  const client = req.socket.remoteAddress ?? '';
  return prior ? `${Array.isArray(prior) ? prior.join(', ') : prior}, ${client}` : client;
}

export function startProxy(port: number, targets: Target[], host = '127.0.0.1'): Promise<Server> {
  let next = 0;
  const pick = (): Target => targets[next++ % targets.length]!;
  /** 1-based node number, sent back as `x-upstream-node` (dev visibility; tests assert on it). */
  const nodeNumber = (t: Target): string => String(targets.indexOf(t) + 1);

  const server = createServer((req, res) => {
    const t = pick();
    const upstream = request(
      { host: t.host, port: t.port, method: req.method, path: req.url, headers: { ...req.headers, 'x-forwarded-for': forwardedFor(req) } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, [...up.rawHeaders, 'x-upstream-node', nodeNumber(t)]);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('bad gateway');
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });

  // Upgraded sockets are not closed by closeAllConnections(), and server.close() would wait for
  // them forever: track them and cut them when the proxy closes.
  const tunnels = new Set<{ destroy(): void }>();
  const closeAll = server.closeAllConnections.bind(server);
  server.closeAllConnections = () => {
    for (const s of tunnels) s.destroy();
    closeAll();
  };

  server.on('upgrade', (req, socket, head) => {
    const t = pick();
    const up = connect(t.port, t.host, () => {
      const headers = { ...req.headers, 'x-forwarded-for': forwardedFor(req) };
      const lines = Object.entries(headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : v === undefined ? [] : [`${k}: ${v}`]));
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    tunnels.add(socket).add(up);
    const close = () => {
      tunnels.delete(socket);
      tunnels.delete(up);
      up.destroy();
      socket.destroy();
    };
    up.on('error', close);
    socket.on('error', close);
    up.on('close', close);
    socket.on('close', close);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
