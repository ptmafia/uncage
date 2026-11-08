/**
 * Runs an entry in production mode on every OS: `node scripts/production.ts server.ts`. Sets
 * `NODE_ENV=production` (unless already set) before the entry is imported, so the scripts in
 * package.json need no `NODE_ENV=… node` shell prefix (which pnpm's default Windows shell rejects).
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const entry = process.argv[2];
if (!entry) {
  console.error('usage: node scripts/production.ts <entry.ts> [args…]');
  process.exit(2);
}
process.env.NODE_ENV ??= 'production';
// The entry sees its own arguments where it expects them.
process.argv.splice(1, 2, resolve(entry));
await import(pathToFileURL(resolve(entry)).href);
