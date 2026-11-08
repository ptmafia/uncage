/**
 * Web-standard replacements for the Node APIs the hub core used (`node:crypto`, `Buffer`,
 * `timer.unref()`), so the root entry runs on any Fetch platform (workerd, Edge, Deno, Bun, Node).
 */
import { UncageError } from '@uncage/core/errors';

const encoder = new TextEncoder();

/** Hex SHA-256 of the UTF-8 bytes of `s` (`crypto.subtle`). */
export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(s));
  return toHex(new Uint8Array(digest));
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  // getRandomValues fills at most 65 536 bytes per call.
  for (let at = 0; at < n; at += 65_536) crypto.getRandomValues(out.subarray(at, Math.min(n, at + 65_536)));
  return out;
}

function toHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

/** `bytes` random bytes, base64url without padding (machine tokens, device codes). */
export function randomToken(bytes = 32): string {
  return toBase64(randomBytes(bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `bytes` random bytes as lowercase hex (`2 × bytes` characters). */
export function randomHex(bytes: number): string {
  return toHex(randomBytes(bytes));
}

/** A uniformly random integer in `[0, max)` (`max` ≤ 2^32). */
export function randomInt(max: number): number {
  if (!Number.isInteger(max) || max < 1 || max > 2 ** 32) throw new RangeError(`randomInt: bad max ${max}`);
  // Rejection sampling: drop values from the incomplete last bucket so every result is equally likely.
  const limit = 2 ** 32 - (2 ** 32 % max);
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % max;
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  t['-'.charCodeAt(0)] = 62;
  t['_'.charCodeAt(0)] = 63;
  return t;
})();

/** Standard base64 with padding. */
export function toBase64(b: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i]! << 16) | (b[i + 1]! << 8) | b[i + 2]!;
    out += B64[n >> 18]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  if (i < b.length) {
    const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8);
    out += B64[n >> 18]! + B64[(n >> 12) & 63]! + (i + 1 < b.length ? B64[(n >> 6) & 63]! : '=') + '=';
  }
  return out;
}

/**
 * Decodes base64 or base64url (padding optional). Like `Buffer.from(s, 'base64')`, characters
 * outside the alphabet are skipped and decoding stops at the first `=`.
 */
export function fromBase64(s: string): Uint8Array {
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let len = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 61) break; // '='
    const v = c < 128 ? B64_INDEX[c]! : -1;
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[len++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, len);
}

/** UTF-8 byte length of `s` (lone surrogates count as U+FFFD, 3 bytes, like `TextEncoder`). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Lets the process exit with `t` pending where the platform supports it (Node, Bun); a no-op elsewhere. */
export function unrefTimer(t: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  (t as { unref?: () => void } | undefined)?.unref?.();
}

/** Concatenates byte chunks. */
export function concatBytes(parts: Uint8Array[], size = parts.reduce((n, p) => n + p.byteLength, 0)): Uint8Array {
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/**
 * Reads at most `limit` bytes of the body; `null` when it is longer (a `Content-Length` over the
 * limit is refused before reading; otherwise reading stops as soon as the limit is passed).
 */
export async function readBody(req: Request, limit: number, timeoutMs?: number): Promise<Uint8Array | null> {
  if (Number(req.headers.get('content-length')) > limit) {
    await req.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Idle timeout (re-armed on every chunk, so a large body on a slow link gets through) plus an
  // overall cap of 4 × `timeoutMs`: a client trickling bytes must not hold the request forever.
  let idle: ReturnType<typeof setTimeout> | undefined;
  let total: ReturnType<typeof setTimeout> | undefined;
  let fail: ((e: Error) => void) | undefined;
  const deadline =
    timeoutMs === undefined
      ? undefined
      : new Promise<never>((_, reject) => {
          fail = reject;
          total = setTimeout(
            () => reject(new UncageError('invalid_request', { message: `The request body did not arrive within ${Math.round((4 * timeoutMs) / 1000)} s.` })),
            4 * timeoutMs,
          );
          unrefTimer(total);
        });
  deadline?.catch(() => undefined);
  const arm = (): void => {
    if (timeoutMs === undefined) return;
    clearTimeout(idle);
    idle = setTimeout(
      () => fail?.(new UncageError('invalid_request', { message: `The request body did not arrive: no data for ${Math.round(timeoutMs / 1000)} s.` })),
      timeoutMs,
    );
    unrefTimer(idle);
  };
  try {
    for (;;) {
      arm();
      const { done, value } = await (deadline ? Promise.race([reader.read(), deadline]) : reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  } finally {
    clearTimeout(idle);
    clearTimeout(total);
  }
  return concatBytes(chunks);
}
