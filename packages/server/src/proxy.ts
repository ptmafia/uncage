/**
 * Same-origin proxy for Next.js route handlers (Node runtime). Deliberately imports nothing from
 * fastify or @uncage/core so apps can mount it without pulling in the daemon.
 *
 *   // app/api/uncage/[...path]/route.ts
 *   export const { GET, POST } = createUncageHandler();
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ERROR_CATALOG, type ErrorBody, type ErrorCode } from '@uncage/protocol';

export interface ProxyOptions {
  /** Defaults to env `UNCAGE_URL`, else `http://127.0.0.1:4783`. */
  endpoint?: string;
  /** Defaults to env `UNCAGE_TOKEN`, else the contents of `~/.uncage/token` (read lazily). */
  token?: string;
  /** The route prefix the handler is mounted under. Defaults to `/api/uncage`. */
  basePath?: string;
}

export interface UncageHandler {
  GET(req: Request): Promise<Response>;
  POST(req: Request): Promise<Response>;
}

const DEFAULT_ENDPOINT = 'http://127.0.0.1:4783';
const DEFAULT_BASE_PATH = '/api/uncage';
const SERVE_HINT = 'Run `uncage serve` first.';

/** Request headers forwarded upstream; everything else (Origin, Cookie, Host, Authorization, …) is dropped. */
const FORWARD_REQUEST_HEADERS = ['accept', 'content-type', 'idempotency-key', 'last-event-id'];
/** Hop-by-hop or body-encoding headers that must not be copied from the upstream response. */
const DROP_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length']);

function errorResponse(code: ErrorCode, opts: { message?: string; hint?: string } = {}): Response {
  const entry = ERROR_CATALOG[code];
  const error: ErrorBody = {
    code,
    message: opts.message ?? entry.message,
    hint: opts.hint ?? entry.hint,
    retryable: entry.retryable,
  };
  return Response.json({ error }, { status: entry.status });
}

/**
 * Event streams end, rather than error, when the daemon drops the connection (e.g. it restarted):
 * the browser client reconnects either way, and the host app logs no "failed to pipe" error.
 */
function endOnUpstreamDrop(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch {
        controller.close();
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Same origin, or both loopback names for the same scheme and port: Next builds route-handler
 * `req.url` with host `localhost` even when the browser is on `127.0.0.1`. A non-loopback Origin
 * (e.g. a DNS-rebinding page on evil.com) must still match exactly.
 */
function sameOrigin(origin: string, url: URL): boolean {
  if (origin === url.origin) return true;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  return o.protocol === url.protocol && o.port === url.port && LOOPBACK_HOSTS.has(o.hostname) && LOOPBACK_HOSTS.has(url.hostname);
}

const trimSlashes = (s: string): string => s.replace(/^\/+|\/+$/g, '');

export function createUncageHandler(o: ProxyOptions = {}): UncageHandler {
  const basePath = `/${trimSlashes(o.basePath ?? DEFAULT_BASE_PATH)}`;
  let cachedFileToken: string | undefined;

  const resolveToken = async (): Promise<{ token: string; fromFile: boolean } | undefined> => {
    const explicit = o.token ?? process.env.UNCAGE_TOKEN;
    if (explicit) return { token: explicit, fromFile: false };
    if (cachedFileToken === undefined) {
      const raw = await readFile(join(homedir(), '.uncage', 'token'), 'utf8').catch(() => undefined);
      const token = raw?.trim();
      if (!token) return undefined;
      cachedFileToken = token;
    }
    return { token: cachedFileToken, fromFile: true };
  };

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    // The daemon's Origin check cannot see the browser's Origin (it is stripped below), so the
    // proxy enforces same-origin itself. Origin-less requests (server-side callers) proceed.
    const origin = req.headers.get('origin');
    const crossSiteFetch = req.method !== 'GET' && req.headers.get('sec-fetch-site') === 'cross-site';
    if ((origin !== null && !sameOrigin(origin, url)) || crossSiteFetch) return errorResponse('forbidden_origin');
    if (!url.pathname.startsWith(`${basePath}/`)) return errorResponse('not_found');
    const endpoint = (o.endpoint ?? process.env.UNCAGE_URL ?? DEFAULT_ENDPOINT).replace(/\/+$/, '');
    const target = new URL(`${endpoint}/v1/${url.pathname.slice(basePath.length + 1)}${url.search}`);
    // Dot segments (including %2e%2e) are normalised by URL; refuse anything that left /v1/.
    if (!target.pathname.startsWith('/v1/')) return errorResponse('not_found');

    const auth = await resolveToken();
    if (!auth) {
      return errorResponse('runtime_unavailable', { message: 'The Uncage daemon token was not found.', hint: SERVE_HINT });
    }

    const headers = new Headers({ authorization: `Bearer ${auth.token}` });
    for (const name of FORWARD_REQUEST_HEADERS) {
      const value = req.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body !== null;

    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method: req.method,
        headers,
        signal: req.signal,
        redirect: 'manual',
        ...(hasBody ? { body: req.body, duplex: 'half' } : {}),
      } as RequestInit);
    } catch (err) {
      if (req.signal.aborted) throw err;
      return errorResponse('runtime_unavailable', { message: 'The Uncage daemon is not reachable.', hint: SERVE_HINT });
    }
    // The daemon may have restarted with a new token; re-read the file next time.
    if (upstream.status === 401 && auth.fromFile) cachedFileToken = undefined;

    const responseHeaders = new Headers();
    upstream.headers.forEach((value, name) => {
      if (!DROP_RESPONSE_HEADERS.has(name)) responseHeaders.set(name, value);
    });
    const sse = upstream.headers.get('content-type')?.startsWith('text/event-stream') === true;
    const body = sse && upstream.body ? endOnUpstreamDrop(upstream.body) : upstream.body;
    return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
  };

  return { GET: handle, POST: handle };
}
