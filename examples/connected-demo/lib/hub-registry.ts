/**
 * The one hub of this process, for every caller: the route handler (`app/api/uncage/[[...path]]`),
 * the /device page and its Server Action.
 *
 * - Traditional mode: `server.ts` created the hub at start-up and published it here.
 * - FaaS mode (`next start`, Vercel): the first caller builds it (`createDemoHub({ mode: 'faas' })`)
 *   and every later caller in this instance reuses it. Kept on `globalThis`, since Next.js bundles
 *   each route separately and a module-level variable would exist once per bundle.
 */
import type { Hub } from '@uncage/hub';
import { PUBLISHED_HUB_KEY } from './mode.ts';

const FAAS_KEY = Symbol.for('uncage.connected-demo.faas-hub');
type Slots = Record<symbol, unknown>;

/** `server.ts` publishes its hub here (this also puts the process in traditional mode, see lib/mode.ts). */
export function publishHub(hub: Hub): void {
  (globalThis as Slots)[PUBLISHED_HUB_KEY] = hub;
}

/** The published hub (traditional mode), else this instance's FaaS hub, built on first use. */
export function getHub(): Promise<Hub> {
  const g = globalThis as Slots;
  const published = g[PUBLISHED_HUB_KEY] as Hub | undefined;
  if (published) return Promise.resolve(published);
  let p = g[FAAS_KEY] as Promise<Hub> | undefined;
  if (!p) {
    // Imported lazily: traditional mode never loads the FaaS wiring into the Next.js bundles' runtime.
    p = import('./hub.ts').then(async ({ createDemoHub }) => (await createDemoHub({ mode: 'faas' })).hub);
    g[FAAS_KEY] = p;
    // A failure (database briefly down, missing env) is not kept: the next request tries again.
    const mine = p;
    p.catch(() => {
      if (g[FAAS_KEY] === mine) delete g[FAAS_KEY];
    });
  }
  return p;
}
