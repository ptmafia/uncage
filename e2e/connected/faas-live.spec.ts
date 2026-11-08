/**
 * The Vercel shape against REAL Claude Code: the connected demo started with `next build && next
 * start` — no custom server, no WebSocket, no local disk — on one Postgres (throwaway docker
 * container), public mode (guest sign-in, owner-only pages) as on the Vercel deployment. The hub ends
 * every agent stream after 15 s (UNCAGE_STREAM_MAX_MS), so a real Claude Code run crosses several
 * stream rotations.
 *
 *   guest sign-in → real `uncage setup --no-daemon` approved on /device → real `uncage agent`
 *   (Claude Code only; tmp UNCAGE_HOME) → "做一个介绍 Uncage 的落地页并发布" → streaming → approval
 *   cards (Claude Code's writes + publish_asset) → create_asset + publish_asset → owner-only asset
 *   page → reload history → agent stopped → offline.
 *
 * Needs `pnpm build` (the demo's production build) and Docker. Run with
 * `UNCAGE_LIVE=1 pnpm --filter @uncage/e2e exec playwright test --project=connected-faas-live`.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { CONNECTED_PORTS } from '../playwright.config.ts';
import { connectedGoldenPath } from './golden-path.ts';
import { Stack, type Proc } from './stack.ts';

const stack = new Stack('faas-live');
test.afterAll(() => stack.cleanup());

test('FaaS mode with real Claude Code: connect → streaming → approval → site tool → publish → reload history → offline', async ({ page }) => {
  const started = Date.now();
  const { databaseUrl: DATABASE_URL } = await stack.dockerPostgres();
  const DEMO_SECRET = randomBytes(48).toString('base64');
  const demo = await stack.demoFaas(CONNECTED_PORTS.faasLive, { DATABASE_URL, DEMO_SECRET, UNCAGE_STREAM_MAX_MS: '15000', DEMO_PUBLIC: '1' });

  const info = (await (await page.request.get(`${demo.url}/api/uncage/agent/info`)).json()) as { transports: Array<{ kind: string }> };
  expect(info.transports.map((t) => t.kind)).toEqual(['http']);

  let agentProc!: Proc;
  let runStarted = 0;
  const result = await connectedGoldenPath({
    page,
    stack,
    url: demo.url,
    agent: async (home) => (agentProc = await stack.claudeAgent(home)),
    runTimeoutMs: 600_000,
    beforeSend: async (p) => {
      const claude = p.getByRole('radio', { name: /Claude Code/ });
      if (await claude.count()) await claude.check();
      runStarted = Date.now();
    },
  });
  // The golden path ends on the session page, agent stopped: history shown, computer offline.
  await page.screenshot({ path: stack.resultPath('history-offline.png'), fullPage: true });
  const rotations = stack.count(agentProc, /http stream rotated/);
  stack.log(`faas live: ${rotations} stream rotations; run+checks ${Date.now() - runStarted} ms; total ${Date.now() - started} ms; ${JSON.stringify(result)}`);
  expect(rotations).toBeGreaterThanOrEqual(2);

  // The published page is owner-only: another guest gets the same 404 as a stranger.
  const other = await page.context().browser()!.newContext();
  try {
    const guest = await other.newPage();
    await guest.goto(`${demo.url}/login`);
    await guest.getByRole('button', { name: '以访客身份进入' }).click();
    expect((await guest.request.get(`${demo.url}/asset-files/${result.assetId}/index.html`)).status()).toBe(404);
    expect((await guest.goto(`${demo.url}/assets/${result.assetId}`))?.status()).toBe(404);
  } finally {
    await other.close();
  }
  expect(existsSync(demo.dataDir), `${demo.dataDir} was created`).toBe(false);
});
