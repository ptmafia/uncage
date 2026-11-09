/**
 * The route handlers the companion app (examples/connected-expo) uses besides the hub's own API:
 * `POST /api/app/token` (sign-in), `POST` / `DELETE /api/app/push-token` (Expo push registration),
 * and the app-link files under `/.well-known/`. Plain Fetch handlers, so the Next.js route files
 * stay one line and both modes (lib/mode.ts) serve them the same way.
 */
import { appTokenExpiry, signAppToken } from './app-token.ts';
import { bearerToken, guestUsername, normalizeUsername, secret, userFromRequest } from './auth.ts';
import { isPublicDemo } from './config.ts';
import { clientIpResolver } from './hub.ts';
import { isExpoPushToken, pushTokenStore } from './push-tokens.ts';
import { appleAppSiteAssociation, assetLinks } from './well-known.ts';

type Env = Record<string, string | undefined>;

const error = (status: number, code: string, message: string): Response =>
  Response.json({ error: { code, message, retryable: false } }, { status, headers: { 'cache-control': 'no-store' } });

/**
 * A browser request from another site is refused (it could carry the visitor's cookie). The native
 * app sends no `Origin`; a browser always does on POST.
 */
function foreignOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host !== (req.headers.get('host') ?? new URL(req.url).host);
  } catch {
    return true;
  }
}

/** Public demo: new guests one client IP may mint through `/api/app/token` per minute. */
export const GUEST_MINTS_PER_MINUTE = 10;
const WINDOW_MS = 60_000;
/** Buckets kept at most (oldest first out), so a flood of addresses cannot grow memory. */
const MAX_BUCKETS = 10_000;

/**
 * A fixed one-minute window per client IP, in this process's memory: a demo-sized brake on scripted
 * guest creation (each guest can register push tokens). With several instances each counts its own.
 */
export const guestMintLimiter = (() => {
  const buckets = new Map<string, { start: number; n: number }>();
  return {
    /** Counts one mint for `key`; false once the window's allowance is used up. */
    take(key: string, now: number = Date.now()): boolean {
      let b = buckets.get(key);
      if (!b || now - b.start >= WINDOW_MS) {
        buckets.delete(key);
        if (buckets.size >= MAX_BUCKETS) buckets.delete(buckets.keys().next().value!);
        b = { start: now, n: 0 };
        buckets.set(key, b);
      }
      b.n += 1;
      return b.n <= GUEST_MINTS_PER_MINUTE;
    },
    /** Seconds until `key`'s window ends. */
    retryAfter(key: string, now: number = Date.now()): number {
      const b = buckets.get(key);
      return b ? Math.max(1, Math.ceil((b.start + WINDOW_MS - now) / 1000)) : 1;
    },
    reset(): void {
      buckets.clear();
    },
  };
})();

/**
 * The client's address, the way the hub's rate limits find it (lib/hub.ts `clientIpResolver`:
 * `CLIENT_IP_HEADER` / `TRUST_PROXY`), else on Vercel the address its edge sets. Without either the
 * route handler cannot see the socket, so every such visitor shares one bucket.
 */
function clientKey(req: Request, env: Env): string {
  const ip = clientIpResolver(env)?.(req) ?? (env.VERCEL ? req.headers.get('x-real-ip')?.trim() : undefined);
  return ip || 'unknown';
}

async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const v = (await req.json()) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * `POST /api/app/token` → `{ token, user, expiresAt }`: an app token (lib/app-token.ts) for
 * - the bearer of a valid app token (renewal; an invalid one is a 401),
 * - else the signed-in cookie user (a web page handing over to the app),
 * - else, on the public demo, a fresh random guest (like the login form; at most
 *   `GUEST_MINTS_PER_MINUTE` per client IP, then 429),
 * - else `{ username }` from the JSON body (DEMO-ONLY: no password, like the login form).
 */
export async function handleAppToken(req: Request, env: Env = process.env): Promise<Response> {
  if (foreignOrigin(req)) return error(403, 'forbidden', 'Cross-site request refused.');
  const key = secret(env);
  let name: string | null;
  if (bearerToken(req) !== undefined) {
    name = userFromRequest(req, key)?.id ?? null;
    if (!name) return error(401, 'unauthorized', 'The app token is invalid or expired. Sign in again.');
  } else {
    name = userFromRequest(req, key)?.id ?? null;
    if (!name && isPublicDemo(env)) {
      const ip = clientKey(req, env);
      if (!guestMintLimiter.take(ip)) {
        const res = error(429, 'rate_limited', 'Too many new guests from this address. Try again in a minute.');
        res.headers.set('retry-after', String(guestMintLimiter.retryAfter(ip)));
        return res;
      }
      name = guestUsername();
    }
    if (!name) name = normalizeUsername((await jsonBody(req)).username);
    if (!name) return error(400, 'invalid_request', 'Send { "username": "…" } (lower-case letters, digits, - and _, up to 32).');
  }
  const token = signAppToken(name, { key });
  return Response.json(
    { token, user: { id: name, name }, expiresAt: appTokenExpiry(token).toISOString() },
    { headers: { 'cache-control': 'no-store' } },
  );
}

/**
 * `POST /api/app/push-token` `{ token }` registers the signed-in user's (bearer or cookie) Expo
 * push token; `DELETE` with the same body unregisters it (sign-out). 204 on success.
 */
export async function handlePushToken(req: Request, env: Env = process.env): Promise<Response> {
  if (foreignOrigin(req)) return error(403, 'forbidden', 'Cross-site request refused.');
  const user = userFromRequest(req, secret(env));
  if (!user) return error(401, 'unauthorized', 'Sign in first.');
  const { token } = await jsonBody(req);
  if (!isExpoPushToken(token)) return error(400, 'invalid_request', 'Send { "token": "ExponentPushToken[…]" } from expo-notifications.');
  const store = pushTokenStore(env);
  if (req.method === 'DELETE') await store.remove(token, user.id);
  else await store.add(user.id, token);
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

/** `/.well-known/assetlinks.json` or `/.well-known/apple-app-site-association`: JSON when configured, else 404. */
export function wellKnownResponse(name: 'assetlinks.json' | 'apple-app-site-association', env: Env = process.env): Response {
  const body = name === 'assetlinks.json' ? assetLinks(env) : appleAppSiteAssociation(env);
  if (!body) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' } });
}
