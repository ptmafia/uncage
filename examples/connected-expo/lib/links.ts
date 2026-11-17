/**
 * Incoming links. The CLI's QR code (`uncage setup <site>`) is `https://<site>/device?code=XXXX-XXXX`;
 * with app links set up it opens this app (`app/device.tsx`), as do `uncagedemo://device?code=…`
 * and, in Expo Go, `exp://<host>/--/device?code=…`.
 *
 * Device-approval phishing: anyone can run `uncage setup` against the site on their own computer
 * and send the user the link, and any app or web page can fire the custom scheme. So a code is
 * only carried into the approve screen from a verified https App Link / Universal Link for the
 * configured site (the OS opens the app for those only after checking the site's
 * assetlinks.json / apple-app-site-association), and even then the user must type its last 4
 * characters. `uncagedemo://`, `exp://` and every other form open the manual-entry screen.
 */

/** Device codes are short (`ABCD-EFGH`); anything else is not passed on. */
const CODE = /^[A-Za-z0-9-]{1,32}$/;

export function sanitizeDeviceCode(raw: unknown): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const code = value.trim();
  return CODE.test(code) ? code : undefined;
}

interface ParsedLink {
  /** Lower-case scheme, or `undefined` for a bare path. */
  scheme?: string;
  /** Lower-case host for http(s)/exp links. */
  host?: string;
  /** Whether the route is `/device`. */
  device: boolean;
  query: string;
}

function parseLink(path: string): ParsedLink | undefined {
  if (path.length > 2048) return undefined;
  let rest = path;
  let scheme: string | undefined;
  let host: string | undefined;
  const withScheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/is.exec(path);
  if (withScheme) {
    scheme = withScheme[1]!.toLowerCase();
    // https://site/device, exp://host:8081/--/device: drop the host. uncagedemo://device: the
    // "host" is the route.
    if (['http', 'https', 'exp', 'exps'].includes(scheme)) {
      host = /^[^/?#]*/.exec(withScheme[2]!)![0].toLowerCase();
      rest = withScheme[2]!.slice(host.length);
    } else {
      rest = `/${withScheme[2]!}`;
    }
  }
  rest = rest.replace(/^\/--(?=\/)/, '');
  const match = /^\/*device\/?(?:\?([^#]*))?(?:#.*)?$/i.exec(rest);
  return { ...(scheme ? { scheme } : {}), ...(host !== undefined ? { host } : {}), device: match !== null, query: match?.[1] ?? '' };
}

/** The `code` of a `/device?code=` path or URL, else `undefined` (whatever the link's origin). */
export function deviceCodeFromPath(path: string): string | undefined {
  const p = parseLink(path);
  if (!p?.device) return undefined;
  return sanitizeDeviceCode(new URLSearchParams(p.query).get('code') ?? undefined);
}

/**
 * A code from a link must have exactly the shape the CLI prints (`ABCD-EFGH` or `ABCDEFGH`):
 * padding such as `ABCD-EFGH----` could otherwise put the hidden last 4 characters on screen.
 */
export function isWellFormedDeviceCode(code: string): boolean {
  return /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/i.test(code.trim());
}

/** `ABCD-••••`, built from the compacted code (spaces and dashes removed). */
export function maskDeviceCode(code: string): string {
  return `${code.toUpperCase().replace(/[\s-]/g, '').slice(0, 4)}-••••`;
}

export type DeviceLink = { kind: 'verified'; code: string } | { kind: 'manual' };

/**
 * What a `/device` link may do. `verified`: an https link to `siteUrl`'s host (an App Link /
 * Universal Link the OS verified) with a well-formed code (`ABCD-EFGH`); the approve screen pre-fills it, and the user
 * still types its last 4 characters. `manual`: any other `/device` link (custom scheme, Expo Go,
 * another host, a bare path); the code is dropped and the manual-entry screen opens.
 * `undefined`: not a `/device` link.
 */
export function deviceLinkFromPath(path: string, siteUrl: string | undefined): DeviceLink | undefined {
  const p = parseLink(path);
  if (!p?.device) return undefined;
  const code = sanitizeDeviceCode(new URLSearchParams(p.query).get('code') ?? undefined);
  const site = httpsHost(siteUrl);
  if (code && isWellFormedDeviceCode(code) && site && p.scheme === 'https' && p.host === site) return { kind: 'verified', code };
  return { kind: 'manual' };
}

function httpsHost(siteUrl: string | undefined): string | undefined {
  if (!siteUrl) return undefined;
  try {
    const u = new URL(siteUrl);
    return u.protocol === 'https:' ? u.host.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** Codes that arrived in a verified app link while the app runs; `app/device.tsx` pre-fills only these. */
const verifiedLinkCodes = new Set<string>();
export function rememberVerifiedLinkCode(code: string): void {
  if (verifiedLinkCodes.size >= 20) verifiedLinkCodes.clear();
  verifiedLinkCodes.add(code.toUpperCase());
}
export function isVerifiedLinkCode(code: string | undefined): boolean {
  return code !== undefined && verifiedLinkCodes.has(code.toUpperCase());
}

/**
 * `app/+native-intent.tsx`'s decision for an incoming link: the route to open and the code to keep
 * for after sign-in (verified links only; remembered as verified). `undefined`: not a `/device` link.
 */
export function routeDeviceLink(path: string, siteUrl: string | undefined): { route: string; pendingCode?: string } | undefined {
  const link = deviceLinkFromPath(path, siteUrl);
  if (!link) return undefined;
  if (link.kind === 'manual') return { route: '/device' };
  rememberVerifiedLinkCode(link.code);
  return { route: `/device?code=${encodeURIComponent(link.code)}`, pendingCode: link.code };
}

/** `iso` as "just now" / "3 minutes ago" / "2 hours ago", relative to `now`. */
export function timeAgo(iso: string | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return 'unknown';
  const min = Math.floor((now - t) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const h = Math.floor(min / 60);
  return `${h} hour${h === 1 ? '' : 's'} ago`;
}

/** Route ids (sessions): letters, digits, `_` and `-` only. */
export function sanitizeId(raw: unknown): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}
