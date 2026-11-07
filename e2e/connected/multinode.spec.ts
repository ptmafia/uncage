/**
 * The connected golden path on TWO hub nodes: the demo's `scripts/multinode.ts` (HUB_NODES=2)
 * on real Redis + Postgres (throwaway docker containers) behind its round-robin proxy, so the
 * machine's WebSocket sits on one node while the browser's requests alternate between both.
 * Runs only with UNCAGE_DOCKER_TESTS=1 (project `connected-multinode`); otherwise reported as
 * skipped with the reason.
 */
import { expect, test } from '@playwright/test';
import { CONNECTED_PORTS } from '../playwright.config.ts';
import { connectedGoldenPath } from './golden-path.ts';
import { Stack } from './stack.ts';

const SKIP_REASON = 'needs Docker with redis:7-alpine + postgres:16-alpine: set UNCAGE_DOCKER_TESTS=1 to run';
test.skip(process.env.UNCAGE_DOCKER_TESTS !== '1', SKIP_REASON);
if (process.env.UNCAGE_DOCKER_TESTS !== '1') console.log(`connected-multinode skipped: ${SKIP_REASON}`);

const stack = new Stack('multinode');
test.afterAll(() => stack.cleanup());

test('two hub nodes (Redis + Postgres): connect, run with site tools, publish, history after the agent stops', async ({ page }) => {
  test.setTimeout(300_000);
  const services = await stack.docker();
  const demo = await stack.multinode(CONNECTED_PORTS.multinode, services);
  const servedBy = new Set<string>();
  await connectedGoldenPath({
    page,
    stack,
    url: demo.url,
    agent: (home) => stack.fakeAgent(home),
    runTimeoutMs: 60_000,
    beforeSend: async (p) => {
      // Consecutive requests alternate between the nodes (the proxy says which one answered in
      // x-upstream-node); every node sees the machine — connected to only one of them — online.
      for (let i = 0; i < 4; i++) {
        const res = await p.request.get(`${demo.url}/api/uncage/machines`);
        servedBy.add(res.headers()['x-upstream-node'] ?? '?');
        expect(((await res.json()) as Array<{ online: boolean }>).map((m) => m.online)).toEqual([true]);
      }
    },
  });
  // Each node actually answered requests (not just started).
  expect([...servedBy].sort()).toEqual(['1', '2']);
});
