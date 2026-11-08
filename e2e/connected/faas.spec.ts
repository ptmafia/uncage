/**
 * The connected golden path in FaaS mode: the demo started with `next start` — no custom server,
 * no WebSocket, no local disk — so the hub runs in the route handler app/api/uncage/[[...path]]
 * on one Postgres (throwaway docker container), and the agent connects over HTTP streaming. The
 * hub ends every stream after 5 s (UNCAGE_STREAM_MAX_MS), so the run, the approval, the publish
 * and the history all cross several stream rotations. Public mode is on (guest sign-in, owner-only
 * pages), as on the Vercel deployment. Runs only with UNCAGE_DOCKER_TESTS=1 (project
 * `connected-faas-mock`); otherwise reported as skipped with the reason.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { CONNECTED_PORTS } from '../playwright.config.ts';
import { connectedGoldenPath } from './golden-path.ts';
import { Stack, type Proc } from './stack.ts';

const SKIP_REASON = 'needs Docker with postgres:16-alpine: set UNCAGE_DOCKER_TESTS=1 to run';
test.skip(process.env.UNCAGE_DOCKER_TESTS !== '1', SKIP_REASON);
if (process.env.UNCAGE_DOCKER_TESTS !== '1') console.log(`connected-faas-mock skipped: ${SKIP_REASON}`);

const stack = new Stack('faas');
test.afterAll(() => stack.cleanup());

test('FaaS demo: connect over HTTP streaming, run, approve, publish, reload history, offline', async ({ page }) => {
  test.setTimeout(300_000);
  const { databaseUrl: DATABASE_URL } = await stack.dockerPostgres();
  const DEMO_SECRET = randomBytes(48).toString('base64');
  const demo = await stack.demoFaas(CONNECTED_PORTS.faas, { DATABASE_URL, DEMO_SECRET, UNCAGE_STREAM_MAX_MS: '5000', DEMO_PUBLIC: '1' });

  // The hub offers HTTP streaming only: nothing in this process serves WebSockets.
  const info = (await (await page.request.get(`${demo.url}/api/uncage/agent/info`)).json()) as { transports: Array<{ kind: string }> };
  expect(info.transports.map((t) => t.kind)).toEqual(['http']);

  let agentProc!: Proc;
  const { assetId } = await connectedGoldenPath({
    page,
    stack,
    url: demo.url,
    agent: async (home) => (agentProc = await stack.fakeAgent(home, { UNCAGE_LOG_LEVEL: 'info' })),
    runTimeoutMs: 120_000,
  });
  expect(stack.count(agentProc, /http stream rotated/)).toBeGreaterThanOrEqual(2); // rotations happened

  // The published page came out of Postgres, owner-only: another guest gets the same 404 as a stranger.
  const other = await page.context().browser()!.newContext();
  try {
    const guest = await other.newPage();
    await guest.goto(`${demo.url}/login`);
    await guest.getByRole('button', { name: '以访客身份进入' }).click();
    expect((await guest.request.get(`${demo.url}/asset-files/${assetId}/index.html`)).status()).toBe(404);
  } finally {
    await other.close();
  }
  // Nothing was written to local disk.
  expect(existsSync(demo.dataDir), `${demo.dataDir} was created`).toBe(false);
});
