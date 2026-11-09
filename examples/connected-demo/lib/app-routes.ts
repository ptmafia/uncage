/**
 * The route handlers the companion app (examples/connected-expo) uses besides the hub's own API:
 * `POST /api/app/token` (sign-in), `POST` / `DELETE /api/app/push-token` (Expo push registration),
 * and the app-link files under `/.well-known/`. Plain Fetch handlers, so the Next.js route files
 * stay one line and both modes (lib/mode.ts) serve them the same way.
 */
import { appTokenExpiry, signAppToken } from './app-token.ts';
import { bearerToken, guestUsername, normalizeUsername, secret, userFromRequest } from './auth.ts';
import { isPublicDemo } from './config.ts';
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
 * - else, on the public demo, a fresh random guest (like the login form),
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
    if (!name && isPublicDemo(env)) name = guestUsername();
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
