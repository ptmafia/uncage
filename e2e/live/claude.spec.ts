/**
 * Live golden path against REAL Claude Code: real `uncage serve` (live-supervisor.ts) on a tmp
 * copy of fixture-repo, driven through the nextjs-default-chat example (and, for the golden path,
 * react-headless-chat) in system Chrome.
 * Run with `UNCAGE_LIVE=1 pnpm e2e:live`. Assertions are on states, not on model text (except the
 * "42" continuity check). Model behaviour varies, so every run is driven by `drive()`, which
 * answers each approval card that appears until the run is terminal.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, type Page, type Route } from '@playwright/test';
import { LIVE_PORTS } from '../playwright.config.ts';
import { chatFor, menuLabels, pickMenu, test, type Chat } from '../mock/fixtures.ts';

const run = promisify(execFile);
const RUN_TIMEOUT = 180_000;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

interface Stack {
  workspace: string;
  tokenFile: string;
  daemonUrl: string;
}
interface Info extends Stack {
  /** The second `uncage serve`, with UNCAGE_ALLOW_BYPASS=1 (nextjs-default-chat on LIVE_PORTS.bypassApp). */
  bypass: Stack;
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

// ---- Composer controls on the real runtime (each in a new session, via nextjs-default-chat). ----

const OK_PROMPT = 'Reply with just the word OK. Do not use any tools.';
const WRITE_A = 'Use your Write tool to create the file a.txt in the current directory with the content hello. Do not use Bash.';

interface SessionSnapshot {
  session: { id: string; settings: { model?: string; effort?: string; permissionMode: string } };
  runs: { id: string; state: string; error?: { code: string; message: string } }[];
}
interface RuntimeRow {
  id: string;
  capabilities?: { models: { id: string; label: string }[]; modelsAuthoritative?: boolean; permissionModes: string[] };
}

/** GET on a live daemon with its token. */
async function api<T>(stack: Stack, path: string): Promise<T> {
  const token = readFileSync(stack.tokenFile, 'utf8').trim();
  const res = await fetch(`${stack.daemonUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return (await res.json()) as T;
}

/** The open session's server-side snapshot (settings + runs). */
async function snapshotOf(chat: Chat, stack: Stack = info): Promise<SessionSnapshot> {
  const id = new URL(await chat.sessionUrl()).searchParams.get('session');
  return api<SessionSnapshot>(stack, `/v1/sessions/${id}`);
}

/** Facts the docs record (live/results/composer-live.json). */
const facts: Record<string, unknown> = {};
test.afterAll(() => {
  if (Object.keys(facts).length === 0) return;
  writeFileSync(join(import.meta.dirname, 'results/composer-live.json'), `${JSON.stringify(facts, null, 2)}\n`);
});

test('model: the menu lists supportedModels(); a non-default model is stored and its run completes', async ({ page }) => {
  // The model list is read from Claude Code in the background after startup.
  await expect
    .poll(async () => (await api<RuntimeRow[]>(info, '/v1/runtimes')).find((r) => r.id === 'claude')?.capabilities?.modelsAuthoritative, {
      timeout: 60_000,
    })
    .toBe(true);
  const models = (await api<RuntimeRow[]>(info, '/v1/runtimes')).find((r) => r.id === 'claude')!.capabilities!.models;
  const listed = models.filter((m) => m.id !== 'default');
  expect(listed.length).toBeGreaterThanOrEqual(1);

  const chat = chatFor(page, 'default');
  await chat.open();
  expect(await menuLabels(page, '模型')).toEqual(models.map((m) => m.label));
  // Prefer the fastest model for cost; any non-default one proves the point.
  const pick = listed.find((m) => /haiku/i.test(`${m.id} ${m.label}`)) ?? listed[0]!;
  facts.models = models.map((m) => m.id);
  facts.pickedModel = pick.id;
  await pickMenu(page, '模型', pick.label);
  await chat.send(OK_PROMPT);
  expect((await drive(chat, 'deny')).state).toBe('completed');
  const snap = await snapshotOf(chat);
  expect(snap.session.settings.model).toBe(pick.id);
  expect(snap.runs.at(-1)?.state).toBe('completed');
});

test('effort low: stored, and the run completes', async ({ page }) => {
  const chat = chatFor(page, 'default');
  await chat.open();
  await pickMenu(page, '推理强度', '低');
  await chat.send(OK_PROMPT);
  expect((await drive(chat, 'deny')).state).toBe('completed');
  expect((await snapshotOf(chat)).session.settings.effort).toBe('low');
});

test('acceptEdits: a file edit needs no approval and the file is written', async ({ page }) => {
  rmSync(join(info.workspace, 'a.txt'), { force: true });
  const chat = chatFor(page, 'default');
  await chat.open();
  // allowBypass is off on this server: bypass is not offered.
  expect(await menuLabels(page, '权限')).toEqual(['每次询问', '自动接受编辑', '计划模式', '自动模式']);
  await pickMenu(page, '权限', '自动接受编辑');
  await chat.send(WRITE_A);
  const { state, cards } = await drive(chat, 'deny');
  expect(state).toBe('completed');
  expect(cards, `approval cards: ${cards.join(' | ')}`).toEqual([]);
  expect(readFileSync(join(info.workspace, 'a.txt'), 'utf8')).toContain('hello');
});

test('plan: the same prompt creates no file and the run completes', async ({ page }) => {
  rmSync(join(info.workspace, 'a.txt'), { force: true });
  const chat = chatFor(page, 'default');
  await chat.open();
  await pickMenu(page, '权限', '计划模式');
  await chat.send(WRITE_A);
  // Claude may offer to leave plan mode (ExitPlanMode → an approval card): decline it.
  const { state, cards } = await drive(chat, 'deny');
  facts.planCards = cards;
  expect(state).toBe('completed');
  expect(existsSync(join(info.workspace, 'a.txt'))).toBe(false);
  expect((await snapshotOf(chat)).session.settings.permissionMode).toBe('plan');
});

test('default mode: a Bash command still asks for approval', async ({ page }) => {
  const chat = chatFor(page, 'default');
  await chat.open();
  await expect(page.getByRole('button', { name: '权限：每次询问' })).toBeVisible();
  await chat.send(NPM_TEST);
  await expect(pendingCard(chat)).toBeVisible({ timeout: RUN_TIMEOUT });
  await expect(pendingCard(chat)).toContainText('npm test');
  expect((await drive(chat, 'allow')).state).toBe('completed');
});

test('image attachment: Claude reads the text in uncage-42.png', async ({ page }) => {
  const chat = chatFor(page, 'default');
  await chat.open();
  await page.locator('input.uc-file-input').setInputFiles(join(import.meta.dirname, '../fixtures/uncage-42.png'));
  await expect(page.locator('.uc-attachments .uc-attachment')).toHaveCount(1);
  await chat.send('What text is in the image? Answer with the text only.');
  expect((await drive(chat, 'deny')).state).toBe('completed');
  await expect(page.locator('.uc-user-thumb img')).toHaveAttribute('alt', 'uncage-42.png');
  await expect(chat.assistant.last()).toContainText('UNCAGE-42');
});

test('file attachment: Claude reads the secret word from the attached notes.md', async ({ page }) => {
  // The attachment must be the only copy Claude can find.
  rmSync(join(info.workspace, 'notes.md'), { force: true });
  const chat = chatFor(page, 'default');
  await chat.open();
  await page.locator('input.uc-file-input').setInputFiles(join(import.meta.dirname, 'fixture-repo/notes.md'));
  await expect(page.locator('.uc-attachments .uc-attachment')).toHaveCount(1);
  await chat.send('What is the secret word in the attached file?');
  expect((await drive(chat, 'allow')).state).toBe('completed');
  await expect(page.locator('.uc-user-attachments .uc-file-chip')).toContainText('notes.md');
  await expect(chat.assistant.last()).toContainText('marmalade');
});

test('auto: the run completes, or fails with unsupported_capability', async ({ page }) => {
  const chat = chatFor(page, 'default');
  await chat.open();
  await pickMenu(page, '权限', '自动模式');
  await chat.send(OK_PROMPT);
  const { state } = await drive(chat, 'deny');
  const run = (await snapshotOf(chat)).runs.at(-1);
  facts.auto = { state, error: run?.error ?? null };
  if (state === 'failed') expect(run?.error?.code).toBe('unsupported_capability');
  else expect(state).toBe('completed');
});

test('running chip: 1 while a run waits in another session; it jumps back to that session', async ({ page }) => {
  const chat = chatFor(page, 'default');
  await chat.open();
  await chat.send(NPM_TEST);
  await expect(pendingCard(chat)).toBeVisible({ timeout: RUN_TIMEOUT });
  const sessionId = new URL(await chat.sessionUrl()).searchParams.get('session');

  await page.getByRole('button', { name: '新建会话' }).first().click();
  await expect(chat.userBubbles).toHaveCount(0);
  const chip = page.locator('.uc-running-chip');
  await expect(chip).toHaveText('1 个运行中');
  await chip.click();
  await page.getByRole('menuitem').first().click();
  await expect(page).toHaveURL(new RegExp(`session=${sessionId}`));
  await expect(pendingCard(chat)).toBeVisible();
  expect((await drive(chat, 'allow')).state).toBe('completed');
  await expect(chip).toHaveCount(0, { timeout: 10_000 });
});

test('bypassPermissions (UNCAGE_ALLOW_BYPASS=1 server): confirm, banner, Bash runs without approval', async ({ page }) => {
  const target = join(info.bypass.workspace, 'bypass.txt');
  rmSync(target, { force: true });
  const chat = chatFor(page, 'default');
  await chat.open(`http://localhost:${LIVE_PORTS.bypassApp}/`);
  expect(await menuLabels(page, '权限')).toContain('完全放行');
  await pickMenu(page, '权限', '完全放行');
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Agent 将不经询问执行任何命令');
  await dialog.getByRole('button', { name: '开启' }).click();
  await expect(page.getByRole('button', { name: '权限：完全放行' })).toBeVisible();

  // Harmless, and confined to the bypass server's tmp copy of the fixture repo.
  await chat.send('用 Bash 工具运行 `echo bypass-ok > bypass.txt`，然后说完成');
  const { state, cards } = await drive(chat, 'deny');
  expect(state).toBe('completed');
  expect(cards, `approval cards: ${cards.join(' | ')}`).toEqual([]);
  await expect(page.locator('.uc-bypass-banner')).toBeVisible();
  expect(readFileSync(target, 'utf8').trim()).toBe('bypass-ok');
  expect((await snapshotOf(chat, info.bypass)).session.settings.permissionMode).toBe('bypassPermissions');
});
