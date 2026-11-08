/**
 * Hands the hub `server.ts` created to Next.js server code (the /device page and its Server
 * Action), which Next bundles separately. Type-only import: pages never bundle the hub itself.
 */
import type { Hub } from '@uncage/hub';

const KEY = Symbol.for('uncage.connected-demo.hub');

/** `server.ts` publishes its hub here so Next.js server code (the /device page) can use it. */
export function publishHub(hub: Hub): void {
  (globalThis as Record<symbol, unknown>)[KEY] = hub;
}

/** The hub `server.ts` created. Throws when the app was started without it (`next dev`). */
export function getHub(): Hub {
  const hub = (globalThis as Record<symbol, unknown>)[KEY] as Hub | undefined;
  if (!hub) throw new Error('The Uncage hub is not running: start the demo with `pnpm dev` (node server.ts), not `next dev`.');
  return hub;
}
