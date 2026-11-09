/**
 * `uncage dashboard` in system Chrome: the connected-demo website (real hub) on a random port, the
 * real `uncage setup` device flow and the fake agent under a temp UNCAGE_HOME, then the real
 * built CLI's `uncage dashboard --no-browser` against that same temp home (never ~/.uncage, no
 * background service: UNCAGE_HOME leaves the service alone). The page must show the connected site
 * (domain, online with its transport, machine id, activity) and disconnect it: revoked on the hub (the
 * site's machine list empties) and removed from agent.yaml.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { connectMachine } from './connected/golden-path.ts';
import { cliBin, Stack, until } from './connected/stack.ts';

test.describe.configure({ mode: 'serial' });

const stack = new Stack('dashboard');
test.afterAll(() => stack.cleanup());

/** A free loopback port (the demo's PUBLIC_URL needs it up front). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

test('dashboard shows the connected test site and disconnects it', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const { url } = await stack.demo(await freePort());
  const { home } = await connectMachine({ page, stack, url, agent: (h) => stack.fakeAgent(h) });
  const siteId = /id: (\S+)/.exec(readFileSync(join(home, '.uncage/agent.yaml'), 'utf8'))?.[1];
  expect(siteId).toBeTruthy();

  const dash = await stack.spawn('dashboard', [cliBin, 'dashboard', '--no-browser'], {
    env: { UNCAGE_HOME: home, LC_ALL: 'en_US.UTF-8' },
    marker: 'Uncage dashboard: ',
  });
  const link = /Uncage dashboard: (\S+)/.exec(dash.output())?.[1];
  // The one-time token is in the fragment: browsers never send it (no request line, log or Referer).
  expect(link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#t=[A-Za-z0-9_-]{43}$/);
  const dashOrigin = new URL(link!).origin;
  const linkToken = new URL(link!).hash.slice('#t='.length);

  // Another origin (the website itself, open in the browser) cannot read the dashboard.
  const crossSite = await page.evaluate(async (u) => {
    try {
      return (await fetch(`${u}/api/sites`, { credentials: 'include' })).status;
    } catch {
      return 'blocked';
    }
  }, dashOrigin);
  expect(crossSite).toBe('blocked');

  const tab = await page.context().newPage();
  const problems: string[] = [];
  tab.on('pageerror', (e) => problems.push(e.message));
  tab.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  await tab.goto(link!);
  // The page script trades the token for an API token (sessionStorage, no cookie) and drops it
  // from the address bar.
  await expect(tab).toHaveURL(`${dashOrigin}/`);
  await expect(tab.getByRole('heading', { name: 'Connected websites' })).toBeVisible();

  const card = tab.locator(`article[data-site="${siteId}"]`);
  await expect(card).toBeVisible();
  await expect(card.locator('.domain')).toContainText('localhost');
  // The transport the agent actually uses (WebSocket, or HTTP streaming after a fallback).
  await expect(card.getByTestId('site-state')).toHaveText(/^Online · (WebSocket|HTTP streaming)$/, { timeout: 15_000 });
  await expect(card).toContainText('Machine');
  await expect(card).toContainText('Claude Code');
  await card.locator('summary').click();
  await expect(card.locator('ol.activity li').first()).toContainText(/connected (ws|http)/);
  await expect(tab.getByRole('region', { name: 'Agents on this computer' })).toContainText('Gemini CLI (ACP)');
  await expect(tab.getByRole('region', { name: 'Local policy' })).toContainText('Not allowed');
  expect(await tab.context().cookies(dashOrigin)).toEqual([]);
  // The link works once: trading its token again (another browser, a leaked shell history) gets nothing.
  const again = await page.request.post(`${dashOrigin}/api/session`, { headers: { origin: dashOrigin, 'x-uncage-link': linkToken }, failOnStatusCode: false });
  expect(again.status()).toBe(403);
  // A reload keeps the session (the API token is in this tab's sessionStorage).
  await tab.reload();
  await expect(card).toBeVisible();

  // A transient server error is shown, and the page keeps refreshing (it is not "stopped").
  expect(problems).toEqual([]);
  let failOnce = true;
  await tab.route('**/api/sites', async (route) => {
    if (!failOnce) return route.continue();
    failOnce = false;
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: 'boom' } }) });
  });
  await expect(tab.locator('#notice')).toContainText('Could not refresh (boom)', { timeout: 15_000 });
  await expect(tab.locator('#notice')).toBeHidden({ timeout: 15_000 });
  await tab.unroute('**/api/sites');
  problems.length = 0; // the 500 above is logged by Chrome on purpose
  await tab.screenshot({ path: testInfo.outputPath('dashboard.png'), fullPage: true });
  await tab.screenshot({ path: stack.resultPath('dashboard.png'), fullPage: true });

  // Disconnect: confirmed in the browser's dialog, revoked on the hub, removed locally.
  tab.once('dialog', (d) => {
    expect(d.message()).toContain('localhost');
    void d.accept();
  });
  await card.getByRole('button', { name: 'Disconnect' }).click();
  await expect(tab.locator('#notice')).toContainText('Revoked this computer on the website.');
  await expect(card).toHaveCount(0);
  await expect(tab.getByText('No connected websites.')).toBeVisible();
  expect(readFileSync(join(home, '.uncage/agent.yaml'), 'utf8')).not.toContain(siteId!);
  await until(async () => {
    const res = await page.request.get(`${url}/api/uncage/machines`);
    return res.ok() && ((await res.json()) as unknown[]).length === 0;
  }, 15_000, 'the machine to be revoked on the hub');
  expect(problems).toEqual([]);

  // Closing the page stops the dashboard (after its short grace period for reloads).
  await tab.close();
  await until(async () => dash.proc.exitCode !== null, 20_000, 'the dashboard to exit after the page closed');
  expect(dash.proc.exitCode).toBe(0);
});
