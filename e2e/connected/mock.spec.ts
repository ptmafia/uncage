/**
 * Connected Mode, end to end, with the fake runtime: the connected-demo website (real hub, single
 * node), the real `uncage setup` device flow approved in the browser on /device, and the real
 * @uncage/agent with the testkit fake adapter. The run calls the site's tools: create_asset, then
 * publish_asset after the approval card is allowed; the page lands on the website's /assets and
 * the history stays readable after the agent stops (`sessionStorage: 'site'`).
 */
import { expect, test } from '@playwright/test';
import { CONNECTED_PORTS } from '../playwright.config.ts';
import { connectedGoldenPath } from './golden-path.ts';
import { Stack } from './stack.ts';

test.describe.configure({ mode: 'serial' });

const stack = new Stack('mock');
test.afterAll(() => stack.cleanup());

test('website commands the machine; tools run on the website; history survives the agent stopping', async ({ page }) => {
  test.setTimeout(180_000);
  const demo = await stack.demo(CONNECTED_PORTS.mock);
  const { assetId } = await connectedGoldenPath({ page, stack, url: demo.url, agent: (home) => stack.fakeAgent(home), runTimeoutMs: 30_000 });
  // The page's own css/app.css (a same-asset sub-resource) loads under the asset CSP...
  await page.goto(`${demo.url}/assets/${assetId}`);
  const h1 = page.frameLocator('iframe.demo-preview').locator('h1');
  await expect(h1).toHaveCSS('color', 'rgb(1, 2, 3)');
  // ...while nothing outside the asset's own folder is allowed.
  const csp = (await page.request.get(`${demo.url}/asset-files/${assetId}/css/app.css`)).headers()['content-security-policy'];
  expect(csp).toContain(`${demo.url}/asset-files/${assetId}/`);
  expect(csp).toContain("connect-src 'none'");
});

test('the device page refuses a bad code and cross-site sign-in posts', async ({ page, request }) => {
  const url = `http://localhost:${CONNECTED_PORTS.mock}`;
  const cross = await request.post(`${url}/auth/login`, { form: { username: 'mallory' }, headers: { origin: 'https://evil.example' }, maxRedirects: 0 });
  expect(cross.status()).toBe(403);
  await page.goto(`${url}/login`);
  await page.getByLabel('用户名').fill('bob');
  await page.getByRole('button', { name: '登录' }).click();
  await page.goto(`${url}/device?code=ZZZZ-ZZZZ`);
  await expect(page.getByRole('button', { name: '批准', exact: true })).toHaveCount(0);
  // bob sees none of alice's assets.
  await page.goto(`${url}/assets`);
  await expect(page.getByTestId('assets-empty')).toBeVisible();
});
