/**
 * DEMO-ONLY app sign-in: an HMAC-signed bearer token for the mobile app (which has no cookie jar it
 * can share with the website). `uat1.<username>.<expiry, unix seconds>.<hmac>`, valid 30 days.
 *
 * The key is derived from the cookie key with its own purpose label, so a cookie value is never a
 * valid app token and an app token is never a valid cookie. A real site would issue tokens from
 * its own authentication (OAuth, its session system) and check them in `getUser` the same way.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const APP_TOKEN_TTL_MS = 30 * 24 * 3600_000;
const PREFIX = 'uat1';
const PURPOSE = 'connected-demo/app-token/v1';
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** The app-token key: HMAC of the purpose label under the site secret (the cookie key). */
export function appTokenKey(secret: Buffer): Buffer {
  return createHmac('sha256', secret).update(PURPOSE).digest();
}

const mac = (payload: string, secret: Buffer): string => createHmac('sha256', appTokenKey(secret)).update(payload).digest('base64url');

/** A token for `username`, expiring `APP_TOKEN_TTL_MS` after `now`. `key` is the site secret. */
export function signAppToken(username: string, o: { key: Buffer; now?: number }): string {
  const exp = Math.floor(((o.now ?? Date.now()) + APP_TOKEN_TTL_MS) / 1000);
  const payload = `${PREFIX}.${username}.${exp}`;
  return `${payload}.${mac(payload, o.key)}`;
}

/** When a token (already verified) expires. */
export function appTokenExpiry(token: string): Date {
  return new Date(Number(token.split('.')[2]) * 1000);
}

/** The username in a valid, unexpired token, else null. */
export function verifyAppToken(token: string | undefined | null, o: { key: Buffer; now?: number }): string | null {
  if (!token || token.length > 200) return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [prefix, name, exp, sig] = parts as [string, string, string, string];
  if (prefix !== PREFIX || !NAME.test(name) || !/^\d{1,12}$/.test(exp)) return null;
  const want = Buffer.from(mac(`${prefix}.${name}.${exp}`, o.key));
  const got = Buffer.from(sig);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  return Number(exp) * 1000 > (o.now ?? Date.now()) ? name : null;
}
