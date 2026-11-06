import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createUncageHandler } from './proxy.js';

interface Seen {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let upstream: Server;
let endpoint: string;
let seen: Seen[];
let respond: (res: import('node:http').ServerResponse) => void;
let home: string;
const savedEnv = { HOME: process.env.HOME, UNCAGE_TOKEN: process.env.UNCAGE_TOKEN, UNCAGE_URL: process.env.UNCAGE_URL };

beforeEach(async () => {
  seen = [];
  respond = (res) => {
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  };
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      respond(res);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  home = mkdtempSync(join(tmpdir(), 'uncage-proxy-'));
  process.env.HOME = home;
  delete process.env.UNCAGE_TOKEN;
  delete process.env.UNCAGE_URL;
});

afterEach(async () => {
  upstream.closeAllConnections();
  await new Promise((r) => upstream.close(r));
  rmSync(home, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('createUncageHandler', () => {
  it('adds bearer, strips Origin/Cookie', async () => {
    const h = createUncageHandler({ endpoint, token: 'tok' });
    const res = await h.POST(
      new Request('http://app.local:3000/api/uncage/sessions/ses_1/runs?x=1', {
        method: 'POST',
        headers: {
          origin: 'http://app.local:3000',
          cookie: 'session=secret',
          authorization: 'Bearer browser-supplied',
          'content-type': 'application/json',
          'idempotency-key': 'idem-1',
          accept: 'application/json',
          'x-other': 'dropped',
        },
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const [req] = seen;
    expect(req?.method).toBe('POST');
    expect(req?.url).toBe('/v1/sessions/ses_1/runs?x=1');
    expect(req?.body).toBe('{"prompt":"hi"}');
    expect(req?.headers.authorization).toBe('Bearer tok');
    expect(req?.headers['idempotency-key']).toBe('idem-1');
    expect(req?.headers.accept).toBe('application/json');
    expect(req?.headers['content-type']).toBe('application/json');
    expect(req?.headers.origin).toBeUndefined();
    expect(req?.headers.cookie).toBeUndefined();
    expect(req?.headers['x-other']).toBeUndefined();
    expect(req?.headers.host).toBe(new URL(endpoint).host);
  });

  it('forwards Last-Event-ID on GET', async () => {
    const h = createUncageHandler({ endpoint, token: 'tok', basePath: '/custom/' });
    await h.GET(new Request('http://app.local/custom/sessions/ses_1/events', { headers: { 'last-event-id': 'evt_0000000003' } }));
    expect(seen[0]?.url).toBe('/v1/sessions/ses_1/events');
    expect(seen[0]?.headers['last-event-id']).toBe('evt_0000000003');
  });

  it('streams SSE body through unchanged', async () => {
    const frames = ['id: evt_0000000001\nevent: a\ndata: {"t":"你好"}\n\n', ': ping\n\n', 'id: evt_0000000002\nevent: b\ndata: {}\n\n'];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform' });
      res.write(frames[0]);
      void gate.then(() => {
        res.write(frames[1]);
        res.end(frames[2]);
      });
    };
    const h = createUncageHandler({ endpoint, token: 'tok' });
    const res = await h.GET(new Request('http://app.local/api/uncage/sessions/ses_1/events'));
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    // The first frame arrives before upstream has finished: the body is streamed, not buffered.
    const first = await reader.read();
    expect(decoder.decode(first.value, { stream: true })).toBe(frames[0]);
    release();
    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += decoder.decode(value, { stream: true });
    }
    expect(rest).toBe(frames[1]! + frames[2]!);
  });

  it('passes upstream error status and body through', async () => {
    respond = (res) => {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end('{"error":{"code":"session_busy"}}');
    };
    const h = createUncageHandler({ endpoint, token: 'tok' });
    const res = await h.POST(new Request('http://app.local/api/uncage/runs/run_1/cancel', { method: 'POST' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'session_busy' } });
  });

  it('503 with hint when token missing', async () => {
    const h = createUncageHandler({ endpoint });
    const res = await h.GET(new Request('http://app.local/api/uncage/health'));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; hint: string } };
    expect(body.error.code).toBe('runtime_unavailable');
    expect(body.error.hint).toContain('Run `uncage serve` first');
    expect(seen).toEqual([]);
  });

  it('reads the token from env, else ~/.uncage/token lazily', async () => {
    const h = createUncageHandler({ endpoint });
    expect((await h.GET(new Request('http://app.local/api/uncage/health'))).status).toBe(503);

    mkdirSync(join(home, '.uncage'));
    writeFileSync(join(home, '.uncage', 'token'), 'file-token\n', { mode: 0o600 });
    await h.GET(new Request('http://app.local/api/uncage/health'));
    expect(seen.at(-1)?.headers.authorization).toBe('Bearer file-token');

    process.env.UNCAGE_TOKEN = 'env-token';
    await h.GET(new Request('http://app.local/api/uncage/health'));
    expect(seen.at(-1)?.headers.authorization).toBe('Bearer env-token');
  });

  it('503 when the daemon is unreachable', async () => {
    const h = createUncageHandler({ endpoint: 'http://127.0.0.1:1', token: 'tok' });
    const res = await h.GET(new Request('http://app.local/api/uncage/health'));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('runtime_unavailable');
  });

  it('404 outside basePath and no path escape from /v1', async () => {
    const h = createUncageHandler({ endpoint, token: 'tok' });
    expect((await h.GET(new Request('http://app.local/other/health'))).status).toBe(404);
    expect((await h.GET(new Request('http://app.local/api/uncage-x/health'))).status).toBe(404);
    expect((await h.GET(new Request('http://app.local/api/uncage/%2e%2e/secret'))).status).toBe(404);
    expect(seen).toEqual([]);
  });
});
