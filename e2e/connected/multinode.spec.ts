/**
 * The connected golden path on TWO hub nodes: the demo's `scripts/multinode.ts` (HUB_NODES=2)
 * on real Redis + Postgres (throwaway docker containers) behind its round-robin proxy, so the
 * machine's WebSocket sits on one node while the browser's requests alternate between both.
 * Runs only with UNCAGE_DOCKER_TESTS=1 (project `connected-multinode`).
 */
import { expect, test } from '@playwright/test';
import { CONNECTED_PORTS } from '../playwright.config.ts';
import { connectedGoldenPath } from './golden-path.ts';
import { Stack } from './stack.ts';

const stack = new Stack('multinode');
test.afterAll(() => stack.cleanup());

test('two hub nodes (Redis + Postgres): connect, run with site tools, publish, history after the agent stops', async ({ page }) => {
  test.setTimeout(300_000);
  const services = await stack.docker();
  const demo = await stack.multinode(CONNECTED_PORTS.multinode, services);
  let checkedBothNodes = false;
  await connectedGoldenPath({
    page,
    stack,
    url: demo.url,
    agent: (home) => stack.fakeAgent(home),
    runTimeoutMs: 60_000,
    beforeSend: async (p) => {
      // Consecutive requests go to node 1, node 2, node 1, …: every one sees the machine online.
      for (let i = 0; i < 4; i++) {
        const machines = (await (await p.request.get(`${demo.url}/api/uncage/machines`)).json()) as Array<{ online: boolean }>;
        expect(machines.map((m) => m.online)).toEqual([true]);
      }
      checkedBothNodes = true;
    },
  });
  expect(checkedBothNodes).toBe(true);
  // Both nodes served traffic.
  expect(demo.proc.output()).toContain('[node 1]');
  expect(demo.proc.output()).toContain('[node 2]');
});
