/**
 * Incoming links. The CLI's QR code (`uncage setup <site>`) is `https://<site>/device?code=XXXX-XXXX`;
 * with app links set up it opens this app (`app/device.tsx`), as do `uncagedemo://device?code=…`
 * and, in Expo Go, `exp://<host>/--/device?code=…`.
 */

/** Device codes are short (`ABCD-EFGH`); anything else is not passed on. */
const CODE = /^[A-Za-z0-9-]{1,32}$/;

export function sanitizeDeviceCode(raw: unknown): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const code = value.trim();
  return CODE.test(code) ? code : undefined;
}

/** The `code` of a `/device?code=` path or URL, else `undefined`. */
export function deviceCodeFromPath(path: string): string | undefined {
  if (path.length > 2048) return undefined;
  let rest = path;
  const withScheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/is.exec(path);
  if (withScheme) {
    const scheme = withScheme[1]!.toLowerCase();
    // https://site/device, exp://host:8081/--/device: drop the host. uncagedemo://device: the
    // "host" is the route.
    rest = ['http', 'https', 'exp', 'exps'].includes(scheme) ? withScheme[2]!.replace(/^[^/?#]*/, '') : `/${withScheme[2]!}`;
  }
  rest = rest.replace(/^\/--(?=\/)/, '');
  const match = /^\/*device\/?\?([^#]*)/i.exec(rest);
  if (!match) return undefined;
  return sanitizeDeviceCode(new URLSearchParams(match[1]).get('code') ?? undefined);
}

/** Route ids (sessions): letters, digits, `_` and `-` only. */
export function sanitizeId(raw: unknown): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}
