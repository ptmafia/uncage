/**
 * Minimal CSRF check for the demo's hand-written POST route handlers: the browser's `Origin` (or,
 * without it, `Sec-Fetch-Site`) must say the request comes from this same site. Server Actions get
 * the equivalent check from Next.js itself.
 */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  const host = req.headers.get('host');
  if (origin) {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  return req.headers.get('sec-fetch-site') === 'same-origin';
}
