/**
 * ⚠️  DEMO SIGN-IN — NOT AUTHENTICATION. ⚠️
 * Anyone who can reach `POST /login` can sign in as ANY user name, with no password. It is
 * therefore refused unless the Worker is reached as localhost / 127.0.0.1 / [::1] or
 * `ALLOW_DEMO_LOGIN=1` is set (only for a throwaway demo). In a real website delete this file
 * and the /login route, and return your own signed-in user from `getUser` in src/hub.ts — that
 * is the only seam the hub uses for browser requests (`{ id, name }` or `null`).
 *
 * The cookie is `<name>.<HMAC-SHA256(name)>` signed with `DEMO_SECRET` via `crypto.subtle`.
 */
import type { HubUser } from '@uncage/hub';

export const COOKIE = 'cf_demo_user';
/** A secret shorter than this is refused (a guessable key lets anyone forge a sign-in). */
export const MIN_SECRET_BYTES = 32;
const NAME = /^[A-Za-z0-9_-]{1,32}$/;

/** Why `secret` cannot sign cookies, or `null` when it is fine. Checked once per request in worker.ts. */
export function secretProblem(secret: string | undefined): string | null {
  return secret && new TextEncoder().encode(secret).length >= MIN_SECRET_BYTES
    ? null
    : `DEMO_SECRET must be set to at least ${MIN_SECRET_BYTES} bytes: \`openssl rand -hex 32\`, then \`wrangler secret put DEMO_SECRET\` (deployed) or DEMO_SECRET=… in .dev.vars (wrangler dev).`;
}

/**
 * Whether the demo sign-in may be used for this request: only on a local host, or when
 * `ALLOW_DEMO_LOGIN=1` explicitly opens it (anyone can then sign in as anyone).
 */
export function demoLoginAllowed(req: Request, allow: string | undefined): boolean {
  if (allow === '1') return true;
  const host = new URL(req.url).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

export const validUserName = (name: string): boolean => NAME.test(name);

const encoder = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string | undefined): Promise<CryptoKey> {
  const problem = secretProblem(secret);
  if (problem || !secret) throw new Error(problem ?? 'DEMO_SECRET is missing.');
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    keys.set(secret, key);
  }
  return key;
}

const hex = (b: ArrayBuffer): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string): Uint8Array<ArrayBuffer> | null =>
  /^(?:[0-9a-f]{2})+$/.test(s) ? new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16))) : null;

/** The cookie value for `name`. */
export async function signUser(name: string, secret: string | undefined): Promise<string> {
  if (!validUserName(name)) throw new Error('A user name is 1–32 letters, digits, "-" or "_".');
  return `${name}.${hex(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(name)))}`;
}

/** `Set-Cookie` for a signed-in user (Secure on https). */
export function loginCookie(value: string, req: Request): string {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}${secure}`;
}

function cookieValue(req: Request): string | undefined {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return undefined;
}

/** The signed-in user of a request, or `null` (no cookie, or a forged / malformed one). */
export async function userFromRequest(req: Request, secret: string | undefined): Promise<HubUser | null> {
  const value = cookieValue(req);
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  const name = value.slice(0, dot);
  const sig = unhex(value.slice(dot + 1));
  if (dot <= 0 || !validUserName(name) || !sig) return null;
  // crypto.subtle.verify compares in constant time.
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), sig, encoder.encode(name));
  return ok ? { id: `user:${name}`, name } : null;
}
