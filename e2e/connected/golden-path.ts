/**
 * The connected golden path shared by the mock, multi-node and live specs:
 *
 *   sign in → ConnectMachine shows `uncage setup <url>` → real `uncage setup` approved on /device →
 *   agent starts → "已连接" → prompt → every approval card allowed (one is publish_asset) → run
 *   completed → the asset is published on /assets and its sandboxed iframe renders an <h1> →
 *   reload shows the history → agent stopped → reload still shows the history, computer offline.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { LANDING_PROMPT, login, type Proc, type Stack } from './stack.ts';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

export interface GoldenPathResult {
  sessionId: string;
  assetId: string;
  cards: string[];
}

/** Allows every approval card until the run is terminal; returns the final state and the cards' text. */
export async function driveRun(page: Page, timeoutMs: number): Promise<{ state: string; cards: string[] }> {
  const runStatus = page.locator('.uc-runstatus');
  const pending = page.locator('section.uc-approval[data-state="pending"]').first();
  const deadline = Date.now() + timeoutMs;
  const cards: string[] = [];
  for (;;) {
    const state = await runStatus.getAttribute('data-state', { timeout: 1_000 }).catch(() => null);
    if (state && TERMINAL.has(state) && (await pending.count()) === 0) return { state, cards };
    if (await pending.isVisible().catch(() => false)) {
      cards.push(await pending.innerText());
      await pending.getByRole('button', { name: '允许执行', exact: true }).click();
      await expect(pending).not.toHaveAttribute('data-state', 'pending').catch(() => undefined);
    }
    if (Date.now() > deadline) throw new Error(`run not terminal after ${timeoutMs} ms (state ${state}); cards: ${cards.join(' | ')}`);
    await page.waitForTimeout(300);
  }
}

export async function connectedGoldenPath(o: {
  page: Page;
  stack: Stack;
  url: string;
  agent(home: string): Promise<Proc>;
  runTimeoutMs: number;
  prompt?: string;
  /** Called with the chat page once the machine is online (e.g. to pick a runtime). */
  beforeSend?(page: Page): Promise<void>;
}): Promise<GoldenPathResult> {
  const { page, stack, url } = o;
  const user = 'alice';
  await login(page, url, user);

  // 1. No computer yet: the chat's empty state is ConnectMachine with this site's setup command.
  await page.goto(url);
  await expect(page.getByText('等待你的电脑上线…')).toBeVisible();
  await expect(page.getByText(`uncage setup ${url}`).first()).toBeVisible();

  // 2. `uncage setup` (real CLI) — approved on /device in a second tab of the same browser session.
  const home = stack.tmp('uncage-home');
  const approveTab = await page.context().newPage();
  await stack.setup(approveTab, url, home);
  await approveTab.close();

  // 3. The agent dials in; the chat (still open in the first tab) sees the computer come online
  // and swaps ConnectMachine for the composer.
  const agent = await o.agent(home);
  await expect(page.getByRole('button', { name: /^电脑：.+（在线）$/ })).toBeVisible({ timeout: 30_000 });
  const input = page.getByRole('textbox', { name: '消息' });
  await expect(input).toBeEnabled({ timeout: 30_000 });
  await o.beforeSend?.(page);

  // 4. Run: the machine works, the site's tools run on the website.
  const prompt = o.prompt ?? LANDING_PROMPT;
  await input.fill(prompt);
  await input.press('Enter');
  await expect(page).toHaveURL(/[?&]session=/);
  const sessionId = new URL(page.url()).searchParams.get('session')!;
  const { state, cards } = await driveRun(page, o.runTimeoutMs);
  stack.log(`run ${sessionId}: ${state}; cards:\n${cards.join('\n---\n')}`);
  expect(state).toBe('completed');
  expect(cards.some((c) => c.includes('publish_asset')), `approval cards: ${cards.join(' | ')}`).toBe(true);

  // 5. The asset is on the website, published, rendered from the site's own copy of the files.
  await page.goto(`${url}/assets`);
  const card = page.locator('[data-asset-id]').filter({ has: page.locator('[data-status="published"]') }).first();
  await expect(card).toBeVisible();
  const assetId = (await card.getAttribute('data-asset-id'))!;
  await card.getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/assets/${assetId}$`));
  // The asset belongs to this run's session (create_asset recorded ctx.sessionId).
  await expect(page.getByRole('link', { name: '查看生成过程' })).toHaveAttribute('href', `/?session=${encodeURIComponent(sessionId)}`);
  const frame: Locator = page.locator('iframe.demo-preview');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(page.frameLocator('iframe.demo-preview').locator('h1').first()).toBeVisible();
  // create_asset ran first: publish_asset was confirmed for the id it returned.
  expect(cards.some((c) => c.includes('publish_asset') && (c.includes(assetId) || !c.includes('assetId'))), cards.join(' | ')).toBe(true);
  await page.screenshot({ path: stack.resultPath('asset.png'), fullPage: true });
  const file = await page.request.get(`${url}/asset-files/${assetId}/index.html`);
  expect(file.status()).toBe(200);
  expect(file.headers()['content-security-policy']).toContain('sandbox allow-scripts');
  expect(file.headers()['content-security-policy']).toContain("default-src 'none'");

  // 6. Reload: the conversation (the process) is on the website.
  const sessionUrl = `${url}/?session=${encodeURIComponent(sessionId)}`;
  const userBubble = page.locator('.uc-user-bubble', { hasText: prompt });
  await page.goto(sessionUrl);
  await expect(userBubble).toBeVisible();
  await expect(page.locator('.uc-assistant').first()).toBeVisible();

  // 7. Stop the agent: the history is still there (site replica), the computer shows offline.
  await agent.stop();
  await page.goto(sessionUrl);
  await expect(userBubble).toBeVisible();
  await expect(page.locator('.uc-assistant').first()).toBeVisible();
  await expect(page.getByText('你的电脑离线了，等待重新连接…')).toBeVisible({ timeout: 40_000 });
  await expect(page.getByRole('textbox', { name: '消息' })).toBeDisabled();
  return { sessionId, assetId, cards };
}
