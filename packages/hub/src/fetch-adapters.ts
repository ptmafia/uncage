/**
 * Fetch-platform adapters for the Web-standard hub: Next.js App Router route handlers and
 * one-hub-per-request platforms (Cloudflare Workers). Web-standard only — this module never
 * imports `next` (pass Next's `after` as `waitUntil` yourself).
 */
import type { Hub } from './types.js';

/** A Next.js App Router route handler (also any `(Request) => Promise<Response>` host). */
export type RouteHandler = (req: Request) => Promise<Response>;

type WaitUntil = (p: Promise<unknown>) => void;

/** Next.js / Vercel expose the platform's request context (incl. `waitUntil`) here. */
const NEXT_REQUEST_CONTEXT = Symbol.for('@next/request-context');

/**
 * The platform's `waitUntil` for the current request, bound to its context: Vercel (and Next's
 * edge sandbox) publish `globalThis[Symbol.for('@next/request-context')].get().waitUntil`, the
 * same hook Next's own `after()` uses there. `undefined` elsewhere (e.g. self-hosted `next start`).
 */
function platformWaitUntil(): WaitUntil | undefined {
  try {
    const holder = (globalThis as Record<symbol, { get?(): { waitUntil?: WaitUntil } | undefined } | undefined>)[NEXT_REQUEST_CONTEXT];
    const ctx = holder?.get?.();
    const fn = ctx?.waitUntil;
    return typeof fn === 'function' ? fn.bind(ctx) : undefined;
  } catch {
    return undefined;
  }
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
 * - `clientIp(req)`: the client address for per-IP rate limits. Without it no IP is passed and the
 *   hub's own `rateLimits` rules apply (`rateLimits.clientIp`, else the rightmost X-Forwarded-For
 *   only with `trustForwardedFor: true` — right on Vercel, which appends the client to it).
 * - `waitUntil`: work that may outlive the response (opportunistic maintenance, …) so it never
 *   delays a response. Pass Next's `after` (from `next/server`; Next 15.1+). Without it the
 *   platform request context's `waitUntil` is used when present (Vercel), bound to its context;
 *   else the hub runs that work inline.
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
    const clientIp = o.clientIp?.(req);
    const waitUntil = o.waitUntil ?? platformWaitUntil();
    return h.fetch(req, {
      ...(clientIp ? { clientIp } : {}),
      ...(waitUntil ? { waitUntil } : {}),
    });
  };
  return { GET: handle, POST: handle, PATCH: handle, DELETE: handle };
}

/**
 * Platforms that forbid sharing I/O objects (sockets, streams) across requests, such as Cloudflare
 * Workers: creates a hub for this request, serves it, and closes the hub once the response body
 * has finished or was cancelled (the client went away) — never earlier, so streams keep working.
 *
 * ```ts
 * export default {
 *   fetch: (req, env, ctx) =>
 *     fetchOnce(() => makeHub(env), req, {
 *       waitUntil: ctx.waitUntil.bind(ctx),
 *       clientIp: req.headers.get('cf-connecting-ip') ?? undefined,
 *     }),
 * };
 * ```
 *
 * - `create()` runs per request: build the store / cluster on a per-request client inside it.
 *   `postgresHubStore` and `postgresCluster` remember a migrated database per pool / connection
 *   string for the isolate's life, so migrations are checked once per isolate, not per request.
 * - `waitUntil` (pass it bound, e.g. `ctx.waitUntil.bind(ctx)`) receives the hub's background work
 *   and the close, so the isolate stays alive until they finish.
 * - `onClose` runs after `hub.close()` (the hub never closes your store): end the per-request
 *   `pg.Pool` / client there. A failing close is logged, never thrown into the response.
 * - A failing `create()` rejects (the platform answers 500).
 */
export async function fetchOnce(
  create: () => Promise<Hub>,
  req: Request,
  o: { clientIp?: string; waitUntil?(p: Promise<unknown>): void; onClose?(): void | Promise<void> } = {},
): Promise<Response> {
  const hub = await create();
  let closing: Promise<void> | undefined;
  const close = (): void => {
    if (closing) return;
    closing = (async () => {
      try {
        await hub.close();
      } finally {
        await o.onClose?.();
      }
    })().catch((err: unknown) => {
      console.error('[uncage] fetchOnce: closing the per-request hub failed:', err);
    });
    try {
      o.waitUntil?.(closing);
    } catch {
      // An unbound / throwing waitUntil must not break the response; the close still runs.
    }
  };

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
  if (!body) {
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
