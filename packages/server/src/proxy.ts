/**
 * Same-origin proxy for Next.js route handlers (Node runtime). Deliberately imports nothing from
 * fastify or @uncage/core so apps can mount it without pulling in the daemon.
 *
 *   // app/api/uncage/[...path]/route.ts
 *   export const { GET, POST, PATCH } = createUncageHandler();
 *
 *   // Express / Connect / node:http (mount before any body parser)
 *   app.use('/api/uncage', createUncageNodeHandler());
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ERROR_CATALOG, type ErrorBody, type ErrorCode } from '@uncage/protocol';
import { toNodeHandler, type UncageNodeHandler } from './node-handler.js';

export type { UncageNodeHandler } from './node-handler.js';

export interface ProxyOptions {
  /** Defaults to env `UNCAGE_URL`, else `http://127.0.0.1:4783`. */
  endpoint?: string;
  /** Defaults to env `UNCAGE_TOKEN`, else the contents of `~/.uncage/token` (read lazily). */
  token?: string;
  /** The route prefix the handler is mounted under. Defaults to `/api/uncage`. */
  basePath?: string;
  /**
   * Hostnames the proxy answers to, matched against the request's `Host` header (port stripped;
   * `X-Forwarded-Host` is ignored). A non-empty list
   * REPLACES the default (add the loopback names yourself if you still need them). Entries are bare
   * hostnames with no scheme or port; IPv6 literals are bracketed (`[::1]`). Entries are trimmed and
   * lowercased, and empty ones dropped. Defaults to env `UNCAGE_ALLOWED_HOSTS` (comma-separated, same
   * rules), else loopback only: `localhost`, `127.0.0.1`, `[::1]` (any port).
   */
  allowedHosts?: string[];
}

export interface UncageHandler {
  GET(req: Request): Promise<Response>;
  POST(req: Request): Promise<Response>;
  PATCH(req: Request): Promise<Response>;
}

const DEFAULT_ENDPOINT = 'http://127.0.0.1:4783';
const DEFAULT_BASE_PATH = '/api/uncage';
const SERVE_HINT = 'Run `uncage serve` first.';

/** Request headers forwarded upstream; everything else (Origin, Cookie, Host, Authorization, …) is dropped. */
const FORWARD_REQUEST_HEADERS = ['accept', 'content-type', 'idempotency-key', 'last-event-id', 'x-filename'];
/** Hop-by-hop or body-encoding headers that must not be copied from the upstream response. */
const DROP_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length']);

/** `details.reason` of the proxy's errors for a stopped or unreachable daemon (no token, connection refused). */
const DAEMON_UNREACHABLE = 'daemon_unreachable';

function errorResponse(
  code: ErrorCode,
  opts: { message?: string; hint?: string; details?: Record<string, unknown> } = {},
): Response {
  const entry = ERROR_CATALOG[code];
  const error: ErrorBody = {
    code,
    message: opts.message ?? entry.message,
    hint: opts.hint ?? entry.hint,
    retryable: entry.retryable,
    ...(opts.details ? { details: opts.details } : {}),
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
 * The browser-facing host, from the `Host` header. Next builds route-handler `req.url` from the
 * server's own configured hostname (e.g. `localhost:3000`), not from what the browser asked for,
 * so `req.url` cannot be used for the DNS-rebinding check. `X-Forwarded-Host` is never trusted.
 * Falls back to `req.url`'s host only when the header is absent (browsers always send it).
 * Returns `undefined` for an unparseable header.
 */
function requestHost(req: Request, url: URL): { host: string; hostname: string } | undefined {
  const raw = req.headers.get('host')?.trim().toLowerCase();
  if (!raw) return { host: url.host, hostname: url.hostname };
  let parsed: URL;
  try {
    parsed = new URL(`http://${raw}`);
  } catch {
    return undefined;
  }
  // Reject anything beyond host[:port] (userinfo, path, …) smuggled into the header.
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return undefined;
  const portSuffix = /:(\d+)$/.exec(raw);
  const hostname = parsed.hostname; // IPv6 stays bracketed: `[::1]`
  return { host: portSuffix ? `${hostname}:${portSuffix[1]}` : hostname, hostname };
}

/**
 * Origin equals `scheme://<Host header>`, or both are loopback names for the same scheme and port
 * (`localhost` vs `127.0.0.1` vs `[::1]`). A non-loopback Origin must match exactly.
 */
function sameOrigin(origin: string, expected: URL): boolean {
  if (origin === expected.origin) return true;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  return (
    o.protocol === expected.protocol &&
    o.port === expected.port &&
    LOOPBACK_HOSTS.has(o.hostname) &&
    LOOPBACK_HOSTS.has(expected.hostname)
  );
}

const normalizeHosts = (hosts: readonly string[] | undefined): string[] =>
  (hosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean);

/** Option first, then env; a list that is empty after normalization counts as absent. */
function resolveAllowedHosts(o: ProxyOptions): Set<string> {
  const fromOption = normalizeHosts(o.allowedHosts);
  if (fromOption.length > 0) return new Set(fromOption);
  const fromEnv = normalizeHosts(process.env.UNCAGE_ALLOWED_HOSTS?.split(','));
  return fromEnv.length > 0 ? new Set(fromEnv) : LOOPBACK_HOSTS;
}

const trimSlashes = (s: string): string => s.replace(/^\/+|\/+$/g, '');

/**
 * Creates the GET/POST/PATCH route handlers. Request bodies (e.g. attachment uploads) stream upstream
 * byte for byte, and response bodies (event streams, attachment downloads) stream back.
 *
 * Requests whose `Host` header hostname is not allowed get 403 `forbidden_origin` and nothing is forwarded; this stops DNS-rebinding pages (evil.com resolving to
 * 127.0.0.1, so Origin and Host agree) from driving the daemon through the host app. Allowed hosts
 * default to loopback names; set `allowedHosts: ['app.example.com']` or env `UNCAGE_ALLOWED_HOSTS`
 * (comma-separated) when serving the host app on another hostname.
 */
export function createUncageHandler(o: ProxyOptions = {}): UncageHandler {
  const basePath = `/${trimSlashes(o.basePath ?? DEFAULT_BASE_PATH)}`;
  const allowedHosts = resolveAllowedHosts(o);
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
    const host = requestHost(req, url);
    if (!host) {
      return errorResponse('forbidden_origin', {
        message: 'The request Host header is invalid.',
        hint: 'Send a plain host[:port] Host header; allow the hostname with createUncageHandler({ allowedHosts }) or UNCAGE_ALLOWED_HOSTS',
        details: { reason: 'invalid_host' },
      });
    }
    if (!allowedHosts.has(host.hostname)) {
      return errorResponse('forbidden_origin', {
        message: `Host ${host.hostname} is not allowed to use the Uncage proxy.`,
        hint: 'Add this host to createUncageHandler({ allowedHosts }) or UNCAGE_ALLOWED_HOSTS',
      });
    }
    // The daemon's Origin check cannot see the browser's Origin (it is stripped below), so the
    // proxy enforces same-origin itself against the browser-facing origin (scheme from req.url,
    // host from the Host header). Origin-less requests (same-origin GETs, server-side callers)
    // proceed: the Host check above already covers them.
    const origin = req.headers.get('origin');
    const crossSiteFetch = req.method !== 'GET' && req.headers.get('sec-fetch-site') === 'cross-site';
    const expected = new URL(`${url.protocol}//${host.host}`);
    // These requests never reach the daemon, so its allowedOrigins cannot help: say which header
    // disagreed and what usually rewrites it.
    if (origin !== null && !sameOrigin(origin, expected)) {
      return errorResponse('forbidden_origin', {
        message: `Origin ${origin} does not match Host ${host.host} (expected Origin ${expected.origin}).`,
        hint:
          'A dev server or reverse proxy in front of this app is rewriting the Host header; forward the browser\'s Host ' +
          '(Vite server.proxy: changeOrigin: false; nginx: proxy_set_header Host $host). If the page really is on ' +
          'another origin, serve it from the same origin as the app.',
        details: { reason: 'origin_mismatch', origin, host: host.host },
      });
    }
    if (crossSiteFetch) {
      return errorResponse('forbidden_origin', {
        message: 'Cross-site request refused (Sec-Fetch-Site: cross-site).',
        hint: 'Call the Uncage proxy from pages served by this app (same origin).',
        details: { reason: 'cross_site' },
      });
    }
    if (!url.pathname.startsWith(`${basePath}/`)) return errorResponse('not_found');
    const endpoint = (o.endpoint ?? process.env.UNCAGE_URL ?? DEFAULT_ENDPOINT).replace(/\/+$/, '');
    const target = new URL(`${endpoint}/v1/${url.pathname.slice(basePath.length + 1)}${url.search}`);
    // Dot segments (including %2e%2e) are normalised by URL; refuse anything that left /v1/.
    if (!target.pathname.startsWith('/v1/')) return errorResponse('not_found');

    const auth = await resolveToken();
    if (!auth) {
      return errorResponse('runtime_unavailable', {
        message: 'The Uncage daemon token was not found.',
        hint: SERVE_HINT,
        details: { reason: DAEMON_UNREACHABLE },
      });
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
      return errorResponse('runtime_unavailable', {
        message: 'The Uncage daemon is not reachable.',
        hint: SERVE_HINT,
        details: { reason: DAEMON_UNREACHABLE },
      });
    }
    // The daemon may have restarted with a new token; re-read the file next time.
    if (upstream.status === 401 && auth.fromFile) cachedFileToken = undefined;

    const responseHeaders = new Headers();
    upstream.headers.forEach((value, name) => {
      if (!DROP_RESPONSE_HEADERS.has(name)) responseHeaders.set(name, value);
    });
    // The daemon's workspace paths in /health are for `uncage doctor` (which calls the daemon
    // directly); the browser has no use for them.
    if (target.pathname === '/v1/health' && upstream.ok) {
      const health = (await upstream.json().catch(() => undefined)) as Record<string, unknown> | undefined;
      if (health && typeof health === 'object') {
        delete health.workspace;
        responseHeaders.set('content-type', 'application/json; charset=utf-8');
        return new Response(JSON.stringify(health), { status: upstream.status, headers: responseHeaders });
      }
      return errorResponse('internal_error', { message: 'The Uncage daemon sent an invalid health response.' });
    }
    const sse = upstream.headers.get('content-type')?.startsWith('text/event-stream') === true;
    const body = sse && upstream.body ? endOnUpstreamDrop(upstream.body) : upstream.body;
    return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
  };

  return { GET: handle, POST: handle, PATCH: handle };
}

/**
 * The same proxy as a Node `(req, res, next?)` handler for Express, Connect, Fastify
 * (`reply.hijack()` then `handler(request.raw, reply.raw)`) and `node:http`:
 *
 *   app.use('/api/uncage', createUncageNodeHandler());
 *
 * The URL is rebuilt from `req.originalUrl` (Express) or `req.url`, and the browser's `Host`
 * header, so mount it under `basePath` (default `/api/uncage`) without rewriting Host. Mount it
 * before body parsers and compression: request bodies stream upstream untouched (a body already
 * parsed by `express.json()` is re-encoded as JSON), and event streams are written chunk by chunk
 * with backpressure. Disconnecting browsers abort the upstream request. Behind a TLS terminator,
 * set Express `trust proxy` so `req.protocol` is `https` (the Origin check compares schemes).
 */
export function createUncageNodeHandler(o: ProxyOptions = {}): UncageNodeHandler {
  return toNodeHandler(createUncageHandler(o));
}
