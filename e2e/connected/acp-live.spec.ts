/**
 * Connected Mode against REAL Claude Code over the Agent Client Protocol: the generic ACP runtime
 * (`@uncage/runtime-acp`) drives Claude Code's ACP adapter, `@agentclientprotocol/claude-agent-acp`
 * (pinned in e2e/package.json, started as `node <pkg>/dist/index.js`).
 *
 *   connected-demo → real `uncage setup` approved on /device → agent.yaml gets
 *   `runtimes.acp = { presets: 'off', autoDetect: false, agents: [claude] }` → real `uncage agent` →
 *   pick "Claude Code (ACP)" → "做一个介绍 Uncage 的落地页并发布" → streaming → approval cards (Claude
 *   Code's own writes + exactly one publish_asset card from the site's MCP tool) → published asset →
 *   reload shows the history → agent stopped, history still there.
 *   Stop: a long command over ACP is cancelled within 10 s and its process is gone.
 *
 * UNCAGE_HOME is a tmp dir, HOME stays real so Claude Code keeps its login. Only the pinned adapter
 * runs: no presets from PATH, no registry detection, no registry download.
 * Run with `UNCAGE_LIVE=1 pnpm --filter @uncage/e2e exec playwright test --project=connected-acp-live`.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { CONNECTED_PORTS } from '../playwright.config.ts';
import { connectedGoldenPath, connectMachine, pickRuntime } from './golden-path.ts';
import { repo, Stack, type AcpTestAgent } from './stack.ts';

test.describe.configure({ mode: 'serial' });

const ACP_NAME = 'Claude Code (ACP)';
const adapterJs = join(repo, 'e2e/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js');
const agents: AcpTestAgent[] = [{ id: 'claude', preset: 'claude', command: [process.execPath, adapterJs] }];

const stack = new Stack('acp-live');
let demoUrl: string | undefined;
test.beforeAll(async () => {
  expect(existsSync(adapterJs), `${adapterJs} (pnpm install)`).toBe(true);
  demoUrl = (await stack.demo(CONNECTED_PORTS.acpLive)).url;
});
test.afterAll(() => stack.cleanup());

const acpAgent = async (home: string) => {
  stack.writeAcpRuntimes(home, agents);
  return stack.realAgent(home);
};

test(`Claude Code over ACP: connect → pick "${ACP_NAME}" → streaming → approval → site tool → publish → reload history`, async ({ page }) => {
  const started = Date.now();
  const result = await connectedGoldenPath({
    page,
    stack,
    url: demoUrl!,
    runTimeoutMs: 600_000,
    agent: acpAgent,
    beforeSend: (p) => pickRuntime(p, ACP_NAME),
  });
  // The site tool that requires confirmation produced exactly one card (the site MCP handler's),
  // not a second one for the agent's own permission request.
  const publishCards = result.cards.filter((c) => c.includes('publish_asset'));
  expect(publishCards, result.cards.join(' | ')).toHaveLength(1);
  // The session ran on the ACP runtime.
  await page.goto(`${demoUrl}/?session=${encodeURIComponent(result.sessionId)}`);
  await expect(page.locator('.uc-header .uc-pill').first()).toContainText(/ACP|acp-claude/);
  await page.screenshot({ path: stack.resultPath('history.png'), fullPage: true });
  stack.log(`acp live result (${Date.now() - started} ms): ${JSON.stringify(result)}`);
});

const execFileP = promisify(execFile);
// A python sleep needs an approval in `default` mode (Claude Code blocks long foreground `sleep`s).
// 61.5 s: unique enough that `pgrep -f` only matches this run's process.
const SLEEP = 'time.sleep(61.5)';
const SLEEP_PATTERN = SLEEP.replace(/[.()]/g, '\\$&');
const sleeping = async (): Promise<string> => (await execFileP('pgrep', ['-f', SLEEP_PATTERN]).catch(() => ({ stdout: '' }))).stdout.trim();

test('Stop during a run over ACP: run cancelled within 10 s', async ({ page }) => {
  await connectMachine({ page, stack, url: demoUrl!, user: 'bob', agent: acpAgent, beforeSend: (p) => pickRuntime(p, ACP_NAME) });
  const input = page.getByRole('textbox', { name: '消息' });
  await input.fill(`用 Bash 工具在前台运行 \`python3 -c "import time; ${SLEEP}"\`（不要用后台运行），然后告诉我结果`);
  await input.press('Enter');

  const card = page.locator('section.uc-approval[data-state="pending"]').first();
  await expect(card).toBeVisible({ timeout: 300_000 });
  await expect(card).toContainText(SLEEP);
  await card.getByRole('button', { name: '允许执行', exact: true }).click();
  // The command is really running before we stop it.
  await expect.poll(sleeping, { timeout: 60_000 }).not.toBe('');

  const t0 = Date.now();
  await page.getByRole('button', { name: '停止' }).click();
  await expect(page.locator('.uc-runstatus')).toHaveAttribute('data-state', 'cancelled', { timeout: 10_000 });
  stack.log(`stop → cancelled in ${Date.now() - t0} ms`);
  await expect.poll(sleeping, { timeout: 15_000 }).toBe('');
  stack.log(`stop → process gone after ${Date.now() - t0} ms`);
  await expect(input).toBeEnabled();
  await page.screenshot({ path: stack.resultPath('stopped.png'), fullPage: true });
});
