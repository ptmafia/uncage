import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createUncageNodeHandler } from './proxy.js';

/** A stand-in daemon on a real port. */
let daemon: Server;
let endpoint: string;
let seen: { method?: string; url?: string; headers: IncomingMessage['headers']; body: Buffer }[];
let upstreamClosed: Promise<void>;
let onUpstreamClose: () => void;
const FRAME_GAP_MS = 150;

beforeEach(async () => {
  seen = [];
  upstreamClosed = new Promise((r) => (onUpstreamClose = r));
  daemon = createServer((req, res) => {
    if (req.url?.startsWith('/v1/sessions/ses_1/events')) {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.alloc(0) });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.flushHeaders();
      let n = 0;
      const timer = setInterval(() => {
        n++;
        res.write(`id: ${n}\nevent: message.delta\ndata: {"n":${n}}\n\n`);
        if (n === 3 && !req.url?.includes('forever')) {
          clearInterval(timer);
          res.end();
        }
      }, FRAME_GAP_MS);
      res.on('close', () => {
        clearInterval(timer);
        onUpstreamClose();
      });
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => daemon.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${(daemon.address() as AddressInfo).port}`;
});

const servers: { close(): Promise<unknown> | void }[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  daemon.closeAllConnections();
  await new Promise((r) => daemon.close(r));
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push({
    close: () => {
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    },
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Reads a streamed body, returning each chunk's text and arrival time (ms since the request). */
async function readTimed(res: Response, t0: number): Promise<{ text: string; at: number }[]> {
  const out: { text: string; at: number }[] = [];
  const decoder = new TextDecoder();
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    out.push({ text: decoder.decode(chunk), at: Date.now() - t0 });
  }
  return out;
}

describe('createUncageNodeHandler', () => {
  it('streams SSE through a real node:http server frame by frame (no buffering)', async () => {
    const app = await listen(createUncageNodeHandler({ endpoint, token: 'tok' }));
    const t0 = Date.now();
    const res = await fetch(`${app}/api/uncage/sessions/ses_1/events?after=0`, { headers: { accept: 'text/event-stream' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const chunks = await readTimed(res, t0);
    const text = chunks.map((c) => c.text).join('');
    expect(text.match(/event: message\.delta/g)).toHaveLength(3);
    // The first frame arrived well before the last one was even written upstream.
    const firstAt = chunks.find((c) => c.text.includes('"n":1'))!.at;
    const lastAt = chunks.find((c) => c.text.includes('"n":3'))!.at;
    expect(lastAt - firstAt).toBeGreaterThanOrEqual(FRAME_GAP_MS);
    expect(seen[0]?.headers.authorization).toBe('Bearer tok');
    expect(seen[0]?.url).toBe('/v1/sessions/ses_1/events?after=0');
  });

  it('streams request bodies upstream byte for byte (duplex half) and keeps Idempotency-Key', async () => {
    const app = await listen(createUncageNodeHandler({ endpoint, token: 'tok' }));
    const bytes = new Uint8Array(256 * 1024).map((_, i) => i % 251);
    const res = await fetch(`${app}/api/uncage/sessions/ses_1/runs`, {
      method: 'POST',
      headers: { origin: app, 'content-type': 'application/octet-stream', 'idempotency-key': 'k1' },
      body: bytes,
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.headers['idempotency-key']).toBe('k1');
    expect(Buffer.compare(seen[0]!.body, Buffer.from(bytes))).toBe(0);
  });

  it('keeps the proxy Host and Origin checks', async () => {
    const app = await listen(createUncageNodeHandler({ endpoint, token: 'tok' }));
    const res = await fetch(`${app}/api/uncage/sessions`, { method: 'POST', headers: { origin: 'http://localhost:5201' } });
    expect(res.status).toBe(403);
    const { error } = (await res.json()) as { error: { code: string; message: string; hint: string } };
    expect(error.code).toBe('forbidden_origin');
    expect(error.message).toContain('Origin http://localhost:5201');
    expect(error.hint).toContain('changeOrigin: false');

    // A rebound Host is refused (raw request so the Host header can be set).
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(`${app}/api/uncage/health`);
      httpRequest({ host: u.hostname, port: u.port, path: u.pathname, headers: { host: `evil.example:${u.port}` } }, (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      })
        .on('error', reject)
        .end();
    });
    expect(status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('works mounted under a prefix (Express-style originalUrl) and with a body parsed before it', async () => {
    const handler = createUncageNodeHandler({ endpoint, token: 'tok' });
    const app = await listen((req, res) => {
      // What `app.use('/api/uncage', handler)` after `express.json()` looks like to the handler.
      const r = req as IncomingMessage & { originalUrl?: string; body?: unknown };
      r.originalUrl = req.url;
      req.url = req.url!.slice('/api/uncage'.length);
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        r.body = JSON.parse(Buffer.concat(chunks).toString()) as unknown;
        handler(req, res);
      });
    });
    const res = await fetch(`${app}/api/uncage/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtime: 'claude' }),
    });
    expect(res.status).toBe(201);
    expect(seen[0]?.url).toBe('/v1/sessions');
    expect(JSON.parse(seen[0]!.body.toString())).toEqual({ runtime: 'claude' });
  });

  it('aborts the upstream event stream when the browser disconnects', async () => {
    const app = await listen(createUncageNodeHandler({ endpoint, token: 'tok' }));
    const ac = new AbortController();
    const res = await fetch(`${app}/api/uncage/sessions/ses_1/events?forever=1`, { signal: ac.signal });
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    await expect(Promise.race([upstreamClosed.then(() => 'closed'), new Promise((r) => setTimeout(() => r('open'), 2000))])).resolves.toBe(
      'closed',
    );
  });

  it('405 with Allow for other methods; upstream errors go to next()', async () => {
    const app = await listen(createUncageNodeHandler({ endpoint, token: 'tok' }));
    const res = await fetch(`${app}/api/uncage/sessions/ses_1`, { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, POST, PATCH');

    const errors: unknown[] = [];
    const broken = createUncageNodeHandler({ endpoint, token: 'tok', basePath: '/api/uncage' });
    const app2 = await listen((req, res) => {
      // A malformed Host header makes `new URL` throw before the proxy runs.
      req.headers.host = 'bad host';
      broken(req, res, (err) => {
        errors.push(err);
        res.statusCode = 502;
        res.end();
      });
    });
    expect((await fetch(`${app2}/api/uncage/health`)).status).toBe(502);
    expect(errors).toHaveLength(1);
  });

  it('mounts in Fastify via reply.hijack() with the raw body untouched', async () => {
    const fastify = Fastify();
    const handler = createUncageNodeHandler({ endpoint, token: 'tok' });
    fastify.removeAllContentTypeParsers();
    fastify.addContentTypeParser('*', (_req, _payload, done) => done(null));
    fastify.all('/api/uncage/*', (request, reply) => {
      reply.hijack();
      handler(request.raw, reply.raw);
    });
    await fastify.listen({ port: 0, host: '127.0.0.1' });
    servers.push(fastify);
    const app = `http://127.0.0.1:${(fastify.server.address() as AddressInfo).port}`;
    const res = await fetch(`${app}/api/uncage/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: app },
      body: '{"runtime":"claude"}',
    });
    expect(res.status).toBe(201);
    expect(seen[0]?.body.toString()).toBe('{"runtime":"claude"}');
    const t0 = Date.now();
    const sse = await fetch(`${app}/api/uncage/sessions/ses_1/events`);
    const chunks = await readTimed(sse, t0);
    expect(chunks.map((c) => c.text).join('').match(/event: message\.delta/g)).toHaveLength(3);
  });
});
