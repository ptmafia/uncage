/**
 * Fetch-platform adapters for the Web-standard hub: Next.js App Router route handlers and
 * one-hub-per-request platforms (Cloudflare Workers). Web-standard only — this module never
 * imports `next` (pass Next's `after` as `waitUntil` yourself).
 */
import { HUB_INTERNALS, type Hub } from './types.js';

/** A Next.js App Router route handler (also any `(Request) => Promise<Response>` host). */
export type RouteHandler = (req: Request) => Promise<Response>;

type WaitUntil = (p: Promise<unknown>) => void;

/** The no-cluster warning was logged in this isolate / process. */
let warnedNoCluster = false;

/**
 * Logs once per process when `hub` has no `cluster`: on FaaS each instance then keeps its own presence
 * (machines look offline on other instances, command replies are lost).
 */
function warnIfNoCluster(hub: Hub): void {
  if (warnedNoCluster) return;
  const h = (hub as Partial<Hub>)[HUB_INTERNALS];
  if (!h?.defaultCluster) return;
  warnedNoCluster = true;
  h.logger.warn(
    {},
    'this hub has no cluster: presence is per instance, so on FaaS machines look offline on other instances and command replies are lost. Use postgresCluster (or redisCluster) on FaaS.',
  );
}

/** Where Vercel (`@vercel/functions`) and Next.js publish the platform's request context, in lookup order. */
const REQUEST_CONTEXTS = [Symbol.for('@vercel/request-context'), Symbol.for('@next/request-context')];

/**
 * The platform's `waitUntil` for the current request, bound to its context: Vercel publishes
 * `globalThis[Symbol.for('@vercel/request-context')].get().waitUntil`, Next.js (on Vercel and in its
 * edge sandbox) `globalThis[Symbol.for('@next/request-context')]` — the hook Next's own `after()`
 * uses there. `undefined` elsewhere (e.g. self-hosted `next start`).
 */
function platformWaitUntil(): WaitUntil | undefined {
  for (const key of REQUEST_CONTEXTS) {
    try {
      const holder = (globalThis as Record<symbol, { get?(): { waitUntil?: WaitUntil } | undefined } | undefined>)[key];
      const ctx = holder?.get?.();
      const fn = ctx?.waitUntil;
      if (typeof fn === 'function') return fn.bind(ctx);
    } catch {
      // not this platform
    }
  }
  return undefined;
}

/**
 * Whether this function runs on Vercel (`VERCEL` is set in every Vercel build and function).
 * A guarded feature check: `globalThis.process?.…` is `undefined` where there is no `process`
 * (Workers, browsers), which check-web-entry allows.
 */
function onVercel(): boolean {
  return Boolean((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.['VERCEL']);
}

/** The client address Vercel's edge sets (it overwrites both headers, so clients cannot spoof them there). */
function vercelClientIp(req: Request): string | undefined {
  return req.headers.get('x-real-ip')?.trim() || req.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() || undefined;
}

/**
 * Next.js App Router: mount the hub in `app/api/uncage/[...path]/route.ts`.
 *
 * ```ts
 * import { after } from 'next/server';
 * export const { GET, POST, PATCH, DELETE } = toNextHandlers(getHub, { waitUntil: after });
 * export const maxDuration = 300;
 * export const dynamic = 'force-dynamic';
 * export const runtime = 'nodejs';
 * ```
 *
 * - `hub` may be a hub, a promise of one, or a lazy getter. A getter is called on the first request
 *   only and memoized (a rejected getter is retried on the next request), so `next build` never
 *   connects to the database.
 * - `clientIp(req)`: the client address for per-IP rate limits. Without it: on Vercel (the `VERCEL`
 *   env var is set) the address Vercel's edge sets (`x-real-ip`, else the first `x-vercel-forwarded-for`
 *   entry); anywhere else no IP is passed and the hub's own `rateLimits` rules apply
 *   (`rateLimits.clientIp`, else the rightmost X-Forwarded-For only with `trustForwardedFor: true`).
 *   Caveat: with another proxy or CDN in front of Vercel, those headers hold that proxy's address —
 *   pass `clientIp` yourself (e.g. from the proxy's client-IP header).
 * - `waitUntil`: work that may outlive the response (opportunistic maintenance, …) so it never
 *   delays a response. Pass Next's `after` (from `next/server`; Next 15.1+) — the recommended way.
 *   Without it the platform request context's `waitUntil` is used when present (Vercel's, then
 *   Next's), bound to its context; else the hub runs that work inline.
 *
 * The route handler's `Request` reaches `hub.fetch` unchanged, so its `signal` does too: Next (Node
 * runtime, `next start` and Vercel) aborts `req.signal` when the client disconnects and cancels
 * the response body, which ends the hub's streaming responses (browser SSE, agent NDJSON stream).
 */
export function toNextHandlers(
  hub: Hub | Promise<Hub> | (() => Hub | Promise<Hub>),
  o: { clientIp?(req: Request): string | undefined; waitUntil?(p: Promise<unknown>): void } = {},
): { GET: RouteHandler; POST: RouteHandler; PATCH: RouteHandler; DELETE: RouteHandler } {
  let memo: Promise<Hub> | undefined;
  const resolve = (): Promise<Hub> => {
    if (typeof hub !== 'function') return Promise.resolve(hub);
    if (!memo) {
      const p = (async () => hub())();
      memo = p;
      // A failure (e.g. the database was briefly down) is not memoized: the next request retries.
      p.catch(() => {
        if (memo === p) memo = undefined;
      });
    }
    return memo;
  };
  const handle: RouteHandler = async (req) => {
    const h = await resolve();
    // On Vercel every function instance is a separate process: a default cluster cannot work there.
    if (onVercel()) warnIfNoCluster(h);
    const clientIp = o.clientIp ? o.clientIp(req) : onVercel() ? vercelClientIp(req) : undefined;
    const waitUntil = o.waitUntil ?? platformWaitUntil();
    return h.fetch(req, {
      ...(clientIp ? { clientIp } : {}),
      ...(waitUntil ? { waitUntil } : {}),
    });
  };
  return { GET: handle, POST: handle, PATCH: handle, DELETE: handle };
}

/** What `fetchOnce`'s `create` returns: a hub, or a hub with the cleanup of what was created for it. */
export type CreatedHub = Hub | { hub: Hub; close(): void | Promise<void> };

/**
 * Platforms that forbid sharing I/O objects (sockets, streams) across requests, such as Cloudflare
 * Workers: creates a hub for this request, serves it, and closes it once the response body has
 * finished or was cancelled (the client went away) — never earlier, so streams keep working.
 *
 * ```ts
 * export default {
 *   fetch: (req, env, ctx) =>
 *     fetchOnce(
 *       async (defer) => {
 *         const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString });
 *         defer(() => pool.end()); // also runs if building the hub fails
 *         return makeHub(env, pool);
 *       },
 *       req,
 *       { waitUntil: ctx.waitUntil.bind(ctx), clientIp: req.headers.get('cf-connecting-ip') ?? undefined },
 *     ),
 * };
 * ```
 *
 * - `create(defer)` runs per request: build the store / cluster on a per-request client inside it.
 *   The hub never closes your store, so clean up what you created: return `{ hub, close }`, and/or
 *   register cleanups with `defer(fn)` as resources are opened. After the response, `hub.close()`
 *   runs, then `close`, then the deferred cleanups (last registered first). If `create` rejects,
 *   the cleanups deferred so far run and the error is rethrown (the platform answers 500).
 * - `postgresHubStore` and `postgresCluster` remember a migrated database per pool / connection
 *   string for the isolate's life, so migrations are checked once per isolate (a per-request pool
 *   object costs one cheap `SELECT max(id)`; key by connection string to skip even that).
 * - `waitUntil` (pass it bound, e.g. `ctx.waitUntil.bind(ctx)`) receives the hub's background work
 *   and the cleanup, so the isolate stays alive until they finish.
 * - A failing cleanup is logged, never thrown into the response.
 */
export async function fetchOnce(
  create: (defer: (cleanup: () => void | Promise<void>) => void) => Promise<CreatedHub>,
  req: Request,
  o: { clientIp?: string; waitUntil?(p: Promise<unknown>): void } = {},
): Promise<Response> {
  const cleanups: Array<() => void | Promise<void>> = [];
  let cleaning: Promise<void> | undefined;
  /** Runs `first` (closing the hub), then every cleanup; each failure is logged; runs once. */
  const cleanup = (first?: () => void | Promise<void>): void => {
    if (cleaning) return;
    cleaning = (async () => {
      for (const fn of [...(first ? [first] : []), ...cleanups.reverse()]) {
        try {
          await fn();
        } catch (err) {
          console.error('[uncage] fetchOnce: cleaning up the per-request hub failed:', err);
        }
      }
    })();
    try {
      o.waitUntil?.(cleaning);
    } catch {
      // An unbound / throwing waitUntil must not break the response; the cleanup still runs.
    }
  };

  let hub: Hub;
  try {
    const created = await create((fn) => void cleanups.push(fn));
    if (typeof (created as Hub).fetch === 'function') hub = created as Hub;
    else {
      const c = created as { hub: Hub; close(): void | Promise<void> };
      hub = c.hub;
      cleanups.push(() => c.close());
    }
  } catch (err) {
    cleanup();
    throw err;
  }
  const close = () => cleanup(() => hub.close());
  // One hub per request: a memory cluster never reaches the next request.
  warnIfNoCluster(hub);

  let res: Response;
  try {
    res = await hub.fetch(req, {
      ...(o.clientIp ? { clientIp: o.clientIp } : {}),
      ...(o.waitUntil ? { waitUntil: o.waitUntil } : {}),
    });
  } catch (err) {
    close();
    throw err;
  }
  const body = res.body;
  // The client is gone (the request was cancelled while the hub worked, e.g. a tool call kept alive
  // by `waitUntil`): nobody will read or cancel the body, so close now — nothing runs any more.
  if (!body || req.signal.aborted) {
    close();
    return res;
  }
  // Re-stream the body so we see when it ends or is cancelled; status and headers are kept.
  const reader = body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          close();
        } else controller.enqueue(value);
      } catch (err) {
        controller.error(err);
        close();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        close();
      }
    },
  });
  return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
}
