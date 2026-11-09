/**
 * Demo settings, read from the environment. Shared by `server.ts` (plain Node) and the Next.js
 * pages, so it only uses Node built-ins.
 */
import { resolve } from 'node:path';

/** Any environment-like map (`process.env`, or a plain object in tests). */
type Env = Record<string, string | undefined>;

/** Everything the demo writes (hub store, assets, the cookie secret). Default `./.data`. */
export function dataDir(env: Env = process.env): string {
  // turbopackIgnore: a runtime data path, not something Next.js should trace into the build.
  return resolve(/*turbopackIgnore: true*/ env.DEMO_DATA_DIR || '.data');
}

/**
 * The platform's public URL when `PUBLIC_URL` is not set: Railway's / Render's public domain, or on
 * Vercel the project's production domain (`VERCEL_PROJECT_PRODUCTION_URL`). Undefined elsewhere.
 */
export function platformUrl(env: Env = process.env): string | undefined {
  if (env.RAILWAY_PUBLIC_DOMAIN) return `https://${env.RAILWAY_PUBLIC_DOMAIN}`;
  if (env.RENDER_EXTERNAL_URL) return env.RENDER_EXTERNAL_URL.replace(/\/+$/, '');
  if (env.VERCEL && env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${env.VERCEL_PROJECT_PRODUCTION_URL.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  return undefined;
}

/**
 * The URL users open, which is also what `uncage setup <url>` is given. `PUBLIC_URL` wins; then the
 * platform's public URL (Railway, Render, Vercel: `platformUrl`); else `http://localhost:<PORT>`
 * (development only: FaaS mode refuses it in production, see `requireFaasEnv`).
 */
export function publicUrl(env: Env = process.env): string {
  if (env.PUBLIC_URL) return env.PUBLIC_URL.replace(/\/+$/, '');
  return platformUrl(env) ?? `http://localhost:${env.PORT || 3200}`;
}

/**
 * `DEMO_PUBLIC=1`: a shared, temporary demo on the internet. Sign-in hands out a random guest
 * identity (nobody can pick a name, so nobody can sign in as someone else and drive their
 * computer), and every page shows a "temporary demo" banner.
 */
export function isPublicDemo(env: Env = process.env): boolean {
  return env.DEMO_PUBLIC === '1';
}

/** Public demo: megabytes of published pages all visitors together may keep (`DEMO_MAX_TOTAL_MB`, default 200). */
export const DEFAULT_MAX_TOTAL_MB = 200;

/** `DEMO_MAX_TOTAL_MB` in bytes (a positive number; anything else → the default). */
export function maxTotalBytes(env: Env = process.env): number {
  const mb = Number(env.DEMO_MAX_TOTAL_MB);
  return Math.floor((Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_TOTAL_MB) * 1024 * 1024);
}

/** Where the banner's "documentation" link points (`DOCS_URL`), if set. */
export function docsUrl(env: Env = process.env): string | undefined {
  // Same rule as the help site's SITE_URL: empty counts as unset, trailing slashes collapse (here to one, it is a directory).
  const url = env.DOCS_URL?.trim().replace(/\/+$/, '');
  return url ? `${url}/` : undefined;
}
