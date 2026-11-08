/**
 * Demo settings, read from the environment. Shared by `server.ts` (plain Node) and the Next.js
 * pages, so it only uses Node built-ins.
 */
import { resolve } from 'node:path';

/** Any environment-like map (`process.env`, or a plain object in tests). */
type Env = Record<string, string | undefined>;

/** Everything the demo writes (hub store, assets, the cookie secret). Default `./.data`. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  // turbopackIgnore: a runtime data path, not something Next.js should trace into the build.
  return resolve(/*turbopackIgnore: true*/ env.DEMO_DATA_DIR || '.data');
}

/**
 * The URL users open, which is also what `uncage setup <url>` is given. `PUBLIC_URL` wins; on
 * Railway / Render the platform's public domain is used when it is not set.
 */
export function publicUrl(env: Env = process.env): string {
  if (env.PUBLIC_URL) return env.PUBLIC_URL.replace(/\/+$/, '');
  if (env.RAILWAY_PUBLIC_DOMAIN) return `https://${env.RAILWAY_PUBLIC_DOMAIN}`;
  if (env.RENDER_EXTERNAL_URL) return env.RENDER_EXTERNAL_URL.replace(/\/+$/, '');
  return `http://localhost:${env.PORT || 3200}`;
}

/**
 * `DEMO_PUBLIC=1`: a shared, temporary demo on the internet. Sign-in hands out a random guest
 * identity (nobody can pick a name, so nobody can sign in as someone else and drive their
 * computer), and every page shows a "temporary demo" banner.
 */
export function isPublicDemo(env: Env = process.env): boolean {
  return env.DEMO_PUBLIC === '1';
}

/** Where the banner's "documentation" link points (`DOCS_URL`), if set. */
export function docsUrl(env: Env = process.env): string | undefined {
  return env.DOCS_URL || undefined;
}
