/**
 * Live golden path against REAL Claude Code: real `uncage serve` (live-supervisor.ts) on a tmp
 * copy of fixture-repo, driven through the nextjs-default-chat example (and, for the golden path,
 * react-headless-chat) in system Chrome.
 * Run with `UNCAGE_LIVE=1 pnpm e2e:live`. Assertions are on states, not on model text (except the
 * "42" continuity check). Model behaviour varies, so every run is driven by `drive()`, which
 * answers each approval card that appears until the run is terminal.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, type Page, type Route } from '@playwright/test';
import { LIVE_PORTS } from '../playwright.config.ts';
import { chatFor, test, type Chat } from '../mock/fixtures.ts';

const run = promisify(execFile);
const RUN_TIMEOUT = 180_000;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

interface Info {
  workspace: string;
  tokenFile: string;
  daemonUrl: string;
}
let info: Info;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  info = (await (await fetch(`http://127.0.0.1:${LIVE_PORTS.control}/info`)).json()) as Info;
});

const pendingCard = (chat: Chat) => chat.approvalCard.and(chat.page.locator('[data-state="pending"]')).first();

/** Approves (or denies) every approval card until the run is terminal; returns the cards' text. */
async function drive(chat: Chat, decision: 'allow' | 'deny', timeout = RUN_TIMEOUT): Promise<{ state: string; cards: string[] }> {
  const deadline = Date.now() + timeout;
  const cards: string[] = [];
  for (;;) {
    const state = await chat.runStatus.getAttribute('data-state', { timeout: 1_000 }).catch(() => null);
    if (state && TERMINAL.has(state) && (await pendingCard(chat).count()) === 0) return { state, cards };
    const card = pendingCard(chat);
    if (await card.isVisible()) {
      cards.push(await card.innerText());
      await card.getByRole('button', { name: decision === 'allow' ? '允许执行' : '拒绝', exact: true }).click();
      await expect(card).not.toHaveAttribute('data-state', 'pending').catch(() => undefined);
    }
    if (Date.now() > deadline) throw new Error(`run not terminal after ${timeout} ms (state ${state}); cards: ${cards.join(' | ')}`);
    await chat.page.waitForTimeout(300);
  }
}

/** Opens every collapsed step list so per-step states are in the DOM. */
async function expandSteps(page: Page): Promise<void> {
  const collapsed = page.locator('.uc-steps-toggle[aria-expanded="false"]');
  while ((await collapsed.count()) > 0) await collapsed.first().click();
}

async function sleepProcesses(pattern: string): Promise<string> {
  try {
    return (await run('pgrep', ['-f', pattern])).stdout.trim();
  } catch {
    return ''; // pgrep exits 1 when nothing matches
  }
}

test('runtime selector: Claude Code available, Codex not installed with the npm hint', async ({ page }) => {
  const chat = chatFor(page, 'default');
  await chat.open();
  const claude = page.locator('.uc-runtime', { hasText: 'Claude Code' });
  await expect(claude.locator('.uc-pill')).toHaveText('可用');
  await expect(claude.locator('input[type=radio]')).toBeChecked();
  const codex = page.locator('.uc-runtime', { hasText: 'Codex' });
  await expect(codex.locator('.uc-pill')).toHaveText('未安装');
  await expect(codex).toContainText('npm i -g @openai/codex && codex login');
  await expect(codex.locator('input[type=radio]')).toBeDisabled();
});

test('scan + npm test: tool steps complete, Bash approval shows the command, run completes', async ({ page }) => {
  const chat = chatFor(page, 'default');
  await chat.open();
  await chat.send('扫描这个仓库的结构，然后运行 npm test');

  const { state, cards } = await drive(chat, 'allow');
  expect(state).toBe('completed');
  expect(cards.some((c) => c.includes('npm test')), `approval cards: ${cards.join(' | ')}`).toBe(true);
  await expect(chat.approvalLine.first()).toHaveAttribute('data-state', 'approved');
  await expandSteps(page);
  expect(await page.locator('.uc-step[data-status="completed"]').count()).toBeGreaterThanOrEqual(1);
  await expect(chat.alert).toHaveCount(0);
});

test('deny: the tool is declined, the run completes, and no file is written', async ({ page }) => {
  const chat = chatFor(page, 'default');
  await chat.open();
  await chat.send('在根目录创建 deny-me.txt');

  const { state, cards } = await drive(chat, 'deny');
  expect(state).toBe('completed');
  expect(cards.length).toBeGreaterThanOrEqual(1);
  expect(cards.some((c) => c.includes('deny-me.txt')), `approval cards: ${cards.join(' | ')}`).toBe(true);
  await expect(chat.approvalLine.first()).toHaveAttribute('data-state', 'denied');
  await expect(chat.approvalLine.first()).toContainText('你拒绝了');
  await expandSteps(page);
  expect(await page.locator('.uc-step[data-status="declined"]').count()).toBeGreaterThanOrEqual(1);
  expect(existsSync(join(info.workspace, 'deny-me.txt'))).toBe(false);
});

test('stop: cancels within 10 s and really kills the sleep child', async ({ page }) => {
  const chat = chatFor(page, 'default');
  await chat.open();
  // Claude Code 2.1 auto-allows a bare `sleep` and blocks long foreground sleeps in its Bash tool, so
  // the fixture wraps it: `npm run wait61` runs `sleep 61` and needs approval. (61, not 60: other
  // software on a dev machine may run its own `sleep 60`, which `pgrep -f` would also match.)
  await chat.send('用 Bash 工具在前台运行 `npm run wait61`（不要用后台运行），然后告诉我结果');

  await expect(pendingCard(chat)).toBeVisible({ timeout: RUN_TIMEOUT });
  await expect(pendingCard(chat)).toContainText('npm run wait61');
  await chat.allow.click();
  // The command is really running before we stop it.
  await expect.poll(() => sleepProcesses('sleep 61'), { timeout: 30_000 }).not.toBe('');

  await chat.stop.click();
  await chat.expectRunState('cancelled', { timeout: 10_000 });
  await expect.poll(() => sleepProcesses('sleep 61'), { timeout: 10_000 }).toBe('');
});

test('reload mid-run: history is not duplicated and the run finishes', async ({ page }) => {
  const chat = chatFor(page, 'default');
  await chat.open();
  await chat.send('用 Bash 工具在前台运行 `npm run wait21`（不要用后台运行），然后说完成');

  await expect(pendingCard(chat)).toBeVisible({ timeout: RUN_TIMEOUT });
  await chat.allow.click();
  await expect.poll(() => sleepProcesses('sleep 21'), { timeout: 30_000 }).not.toBe('');
  await chat.sessionUrl();

  await page.reload();
  await expect(chat.userBubbles).toHaveCount(1);
  const { state, cards } = await drive(chat, 'allow');
  expect(['completed', 'interrupted']).toContain(state);
  await expect(chat.userBubbles).toHaveCount(1);
  // One resolved line per approval: the reload replayed history once, not twice.
  await expect(chat.approvalLine).toHaveCount(1 + cards.length);
});

test('context continuity: the next run remembers the previous one', async ({ page }) => {
  const chat = chatFor(page, 'default');
  await chat.open();
  await chat.send('记住数字 42');
  expect((await drive(chat, 'allow')).state).toBe('completed');

  await chat.send('我让你记住的数字是多少？');
  await expect(chat.userBubbles).toHaveCount(2);
  await expect(chat.runStatus).not.toHaveAttribute('data-state', 'completed', { timeout: 30_000 });
  expect((await drive(chat, 'allow')).state).toBe('completed');
  await expect(chat.assistant.last()).toContainText('42');
});

/** A prompt that reliably needs one Bash approval and finishes quickly. */
const NPM_TEST = '用 Bash 工具运行 `npm test`，然后用一句话告诉我结果';

test('F5 while an approval is pending: the card is still pending after reload, and Allow completes the run', async ({ page }) => {
  const chat = chatFor(page, 'default');
  await chat.open();
  await chat.send(NPM_TEST);
  await expect(pendingCard(chat)).toBeVisible({ timeout: RUN_TIMEOUT });
  await expect(pendingCard(chat)).toContainText('npm test');
  await chat.sessionUrl();

  await page.reload();
  await expect(pendingCard(chat)).toBeVisible();
  await expect(pendingCard(chat)).toContainText('npm test');
  await expect(chat.userBubbles).toHaveCount(1);
  await expect(chat.runStatus).toHaveAttribute('data-state', 'waiting_approval');

  const { state } = await drive(chat, 'allow');
  expect(state).toBe('completed');
  await expect(chat.approvalLine.first()).toHaveAttribute('data-state', 'approved');
  await expect(chat.alert).toHaveCount(0);
});

test('two tabs both click Allow: one 200, one 409, both converge to approved + completed', async ({ browser, page }) => {
  const chat = chatFor(page, 'default');
  await chat.open();
  await chat.send(NPM_TEST);
  await expect(pendingCard(chat)).toBeVisible({ timeout: RUN_TIMEOUT });
  const url = await chat.sessionUrl();

  const other = await browser.newContext();
  try {
    const page2 = await other.newPage();
    const chat2 = chatFor(page2, 'default');
    await page2.goto(url);
    await expect(pendingCard(chat2)).toBeVisible();

    // Hold both decision requests until both tabs have clicked, so they race at the daemon.
    let release!: () => void;
    const bothSent = new Promise<void>((resolve) => (release = resolve));
    let arrived = 0;
    const hold = async (route: Route) => {
      if (++arrived === 2) release();
      await bothSent;
      await route.continue();
    };
    await page.route('**/api/uncage/approvals/*/decision', hold);
    await page2.route('**/api/uncage/approvals/*/decision', hold);
    const decision = (p: Page) => p.waitForResponse((r) => r.url().endsWith('/decision'));
    const responses = Promise.all([decision(page), decision(page2)]);
    await pendingCard(chat).getByRole('button', { name: '允许执行', exact: true }).click();
    await pendingCard(chat2).getByRole('button', { name: '允许执行', exact: true }).click();
    expect((await responses).map((r) => r.status()).sort()).toEqual([200, 409]);
    await page.unrouteAll();
    await page2.unrouteAll();

    // Further approvals (if the model asks for more) are answered in the first tab.
    expect((await drive(chat, 'allow')).state).toBe('completed');
    for (const c of [chat, chat2]) {
      await expect(c.approvalLine.first()).toHaveAttribute('data-state', 'approved');
      await c.expectRunState('completed', { timeout: 30_000 });
      await expect(c.alert).toHaveCount(0);
    }
  } finally {
    await other.close();
  }
});

test('headless example golden path: prompt → approval → Allow → completed', async ({ page }) => {
  const chat = chatFor(page, 'headless');
  await chat.open(`http://localhost:${LIVE_PORTS.headlessApp}/`);
  await chat.send(NPM_TEST);

  const { state, cards } = await drive(chat, 'allow');
  expect(state).toBe('completed');
  expect(cards.some((c) => c.includes('npm test')), `approval cards: ${cards.join(' | ')}`).toBe(true);
  await expect(chat.approvalLine.first()).toHaveAttribute('data-state', 'approved');
  await expect(chat.assistant.last()).not.toBeEmpty();
  await expect(chat.alert).toHaveCount(0);
});

test('daemon auth: no token → 401, foreign Origin → 403 (daemon and proxy)', async () => {
  const token = readFileSync(info.tokenFile, 'utf8').trim();
  const status = async (url: string, ...headers: string[]) =>
    (await run('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', ...headers.flatMap((h) => ['-H', h]), url])).stdout;

  const runtimes = `${info.daemonUrl}/v1/runtimes`;
  expect(await status(runtimes)).toBe('401');
  expect(await status(runtimes, `Authorization: Bearer ${token}`)).toBe('200');
  expect(await status(runtimes, `Authorization: Bearer ${token}`, 'Origin: http://evil.test')).toBe('403');
  expect(await status(`http://localhost:${LIVE_PORTS.app}/api/uncage/runtimes`, 'Origin: http://evil.test')).toBe('403');
});
