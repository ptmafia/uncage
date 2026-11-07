/**
 * Node `(req, res)` adapter for the Fetch-style proxy handlers, for Express, Connect, Fastify
 * (`reply.raw` after `reply.hijack()`) and plain `node:http`. Streams request bodies upstream and
 * response bodies (SSE) back chunk by chunk, with backpressure, and aborts the upstream request
 * when the browser goes away.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { TLSSocket } from 'node:tls';

/** A Connect/Express-style middleware: `(req, res, next?)`. Errors before the response go to `next`. */
export type UncageNodeHandler = (req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void) => void;

const METHODS = ['GET', 'POST', 'PATCH', 'DELETE'] as const;
type Method = (typeof METHODS)[number];

/** Fetch-style handlers by method; methods without one get 405. */
export type FetchHandlers = { [M in Method]?: (req: Request) => Promise<Response> };

/** Express adds these to `req`; plain `node:http` requests have neither. */
interface ExpressLike {
  originalUrl?: string;
  protocol?: string;
  body?: unknown;
}

/**
 * The scheme the browser used: Express's `req.protocol` (honours `trust proxy` behind a TLS
 * terminator), else whether this socket is TLS. `X-Forwarded-*` is not read here, like the proxy.
 */
function requestProtocol(req: IncomingMessage & ExpressLike): string {
  if (req.protocol === 'http' || req.protocol === 'https') return req.protocol;
  return (req.socket as TLSSocket).encrypted ? 'https' : 'http';
}

/**
 * The request body as a web stream. If a body parser already consumed the stream (e.g.
 * `express.json()` mounted before this route), its parsed `req.body` is re-encoded instead.
 */
function requestBody(req: IncomingMessage & ExpressLike): ReadableStream<Uint8Array> | Uint8Array | string | undefined {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  if (!req.readableEnded) return Readable.toWeb(req) as ReadableStream<Uint8Array>;
  const parsed = req.body;
  if (parsed === undefined || parsed === null) return undefined;
  if (typeof parsed === 'string') return parsed;
  if (Buffer.isBuffer(parsed)) return new Uint8Array(parsed);
  return JSON.stringify(parsed);
}

function toHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (name.startsWith(':')) continue; // HTTP/2 pseudo-headers
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

async function writeResponse(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') res.setHeader(name, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader('set-cookie', cookies);
  if (!response.body) {
    res.end();
    return;
  }
  // SSE clients wait for headers; send them now rather than with the first chunk.
  res.flushHeaders();
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    if (res.destroyed) return;
    if (!res.write(chunk)) {
      await new Promise<void>((resolve) => {
        const done = () => {
          res.off('drain', done);
          res.off('close', done);
          resolve();
        };
        res.on('drain', done);
        res.on('close', done);
      });
    }
  }
  res.end();
}

/** Wraps Fetch-style handlers (from `createUncageHandler` or `@uncage/hub`) as a Node `(req, res, next?)` handler. */
export function toNodeHandler(handlers: FetchHandlers): UncageNodeHandler {
  const allowed = METHODS.filter((m) => handlers[m] !== undefined);
  return (req, res, next) => {
    const method = req.method as Method;
    const handle = allowed.includes(method) ? handlers[method] : undefined;
    if (!handle) {
      res.statusCode = 405;
      res.setHeader('allow', allowed.join(', '));
      res.end();
      return;
    }
    const abort = new AbortController();
    // The browser went away before the response finished: close the upstream (e.g. SSE) request.
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    const fail = (err: unknown) => {
      if (abort.signal.aborted || res.headersSent) {
        res.destroy();
        return;
      }
      if (next) return next(err);
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { code: 'internal_error', message: 'The Uncage proxy failed.', retryable: true } }));
    };
    try {
      const r = req as IncomingMessage & ExpressLike;
      // The browser's Host: the proxy's DNS-rebinding and Origin checks compare against it.
      const url = new URL(r.originalUrl ?? req.url ?? '/', `${requestProtocol(r)}://${req.headers.host ?? 'localhost'}`);
      const body = requestBody(r);
      const request = new Request(url, {
        method,
        headers: toHeaders(req),
        signal: abort.signal,
        ...(body !== undefined ? { body, duplex: 'half' } : {}),
      } as RequestInit);
      handle(request).then((response) => writeResponse(response, res)).catch(fail);
    } catch (err) {
      fail(err);
    }
  };
}
