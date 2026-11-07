/**
 * Demo settings, read from the environment. Shared by `server.ts` (plain Node) and the Next.js
 * pages, so it only uses Node built-ins.
 */
import { resolve } from 'node:path';

/** Everything the demo writes (hub store, assets, the cookie secret). Default `./.data`. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  // turbopackIgnore: a runtime data path, not something Next.js should trace into the build.
  return resolve(/*turbopackIgnore: true*/ env.DEMO_DATA_DIR || '.data');
}

/** The URL users open, which is also what `uncage setup <url>` is given. */
export function publicUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.PUBLIC_URL || `http://localhost:${env.PORT || 3200}`;
}
