import { afterEach, describe, expect, it } from 'vitest';
import { startFaasHubs, startTestHub } from './test-helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined);
});

/** Blocks the event loop, like a long synchronous stretch (PGlite WASM, sync fs on a slow Windows runner). */
function stall(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end);
}

describe('in-process test hubs', () => {
  // Regression (CI: ECONNRESET on `fetch(/machines)` from the test): the test's fetch and the hub
  // share one event loop. After a stall past Node's server keep-alive timeout (5 s + 1 s buffer),
  // the next request went out on the pooled connection before the server's idle timer ran; the
  // server then closed the socket with that request unread, and the client got a reset.
  it('a request after a long event-loop stall reuses the idle connection without a reset', async () => {
    const t = await startTestHub();
    cleanups.push(() => t.close());
    const f = await startFaasHubs({ n: 2 });
    cleanups.push(() => f.close());
    expect((await t.as('alice', '/machines')).status).toBe(200);
    expect((await f.as('alice', '/machines')).status).toBe(200);
    stall(6_500);
    expect((await t.as('alice', '/machines')).status).toBe(200);
    expect((await f.as('alice', '/machines')).status).toBe(200);
  });
});
