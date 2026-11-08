/**
 * Connected Mode against REAL Claude Code — the proof: the website commands the user's local
 * Claude Code, Claude Code calls the website's tools, and the process and the assets stay on the
 * website.
 *
 *   connected-demo (single node) → real `uncage setup <url> --no-daemon`, approved on /device by
 *   Playwright → real `uncage agent` in the foreground → "做一个介绍 Uncage 的落地页并发布" →
 *   create_asset → approval card for publish_asset (plus Claude Code's own file-write cards) →
 *   allow → the asset is on /assets and its sandboxed iframe renders an <h1> → reload shows the
 *   process → agent stopped → reload: history still there, computer offline.
 *
 * UNCAGE_HOME is a tmp dir (agent.yaml, workspaces), HOME stays real so Claude Code keeps its login.
 * Run with `UNCAGE_LIVE=1 pnpm e2e:live` (or `--project=connected-live`). Uses real model turns.
 */
import { test } from '@playwright/test';
import { CONNECTED_PORTS } from '../playwright.config.ts';
import { connectedGoldenPath } from './golden-path.ts';
import { Stack } from './stack.ts';

const stack = new Stack('live');
test.afterAll(() => stack.cleanup());

test('real Claude Code builds and publishes a landing page through the website’s tools', async ({ page }) => {
  const demo = await stack.demo(CONNECTED_PORTS.live);
  const result = await connectedGoldenPath({
    page,
    stack,
    url: demo.url,
    agent: (home) => stack.realAgent(home),
    runTimeoutMs: 600_000,
    beforeSend: async (p) => {
      // The real agent offers Claude Code (and Codex if installed): run on Claude Code.
      const claude = p.getByRole('radio', { name: /Claude Code/ });
      if (await claude.count()) await claude.check();
    },
  });
  stack.log(`live result: ${JSON.stringify(result)}`);
});
