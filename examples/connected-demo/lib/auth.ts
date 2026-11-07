/**
 * DEMO-ONLY sign-in: a username in an HMAC-signed cookie. There is no password and no account
 * store, so anyone can be anyone. Replace this with your website's real authentication; the hub
 * only needs `getUser(req)` to return the signed-in user.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config.ts';

export const SESSION_COOKIE = 'demo_user';
const USERNAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Usernames are lower-case `[a-z0-9_-]`, 1–32 chars. Returns the normalized name or null. */
export function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().toLowerCase();
  return USERNAME.test(name) ? name : null;
}

const cached = new Map<string, Buffer>();
/** HMAC-SHA256 keys shorter than this are guessable. */
export const MIN_SECRET_BYTES = 32;
let warned = false;

/**
 * `DEMO_SECRET` (at least 32 bytes), else a random secret kept in `<data dir>/secret` so every node
 * and restart agrees.
 */
export function secret(env: NodeJS.ProcessEnv = process.env): Buffer {
  if (env.DEMO_SECRET) {
    const key = Buffer.from(env.DEMO_SECRET);
    if (key.length >= MIN_SECRET_BYTES) return key;
    if (!warned) console.warn(`DEMO_SECRET is shorter than ${MIN_SECRET_BYTES} bytes: ignored, using the generated secret in the data dir.`);
    warned = true;
  }
  const file = join(dataDir(env), 'secret');
  const hit = cached.get(file);
  if (hit) return hit;
  let key: Buffer;
  try {
    key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64url');
  } catch {
    mkdirSync(dataDir(env), { recursive: true });
    try {
      writeFileSync(file, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
    } catch {
      // Another node created it first.
    }
    key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64url');
  }
  cached.set(file, key);
  return key;
}

const mac = (value: string, key: Buffer): string => createHmac('sha256', key).update(value).digest('base64url');

/** Cookie value for `username`: `<username>.<hmac>`. */
export function signUser(username: string, key: Buffer = secret()): string {
  return `${username}.${mac(username, key)}`;
}

/** The username in a cookie value, or null when it is missing or tampered with. */
export function verifyUser(value: string | undefined | null, key: Buffer = secret()): string | null {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const name = normalizeUsername(value.slice(0, dot));
  if (!name || name !== value.slice(0, dot)) return null;
  const want = Buffer.from(mac(name, key));
  const got = Buffer.from(value.slice(dot + 1));
  return got.length === want.length && timingSafeEqual(got, want) ? name : null;
}

/** A `Cookie` header's value for `name`. */
export function readCookie(header: string | null | undefined, name: string = SESSION_COOKIE): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** The signed-in user of a Fetch `Request` (what the hub's `getUser` needs). */
export function userFromRequest(req: Request): { id: string; name: string } | null {
  const name = verifyUser(readCookie(req.headers.get('cookie')));
  return name ? { id: name, name } : null;
}
