/**
 * examples/connected-extension against the mock connected stack: the connected-demo website (real
 * hub, started with TRUSTED_ORIGINS for the extension's fixed origin), the real `uncage setup`
 * device flow and the real @uncage/agent with the testkit fake adapter. The unpacked extension is
 * loaded into a Chromium with the user signed in on the site; its side panel page
 * (chrome-extension://<id>/panel.html, opened in a tab: Playwright cannot drive the real side
 * panel UI) must list the user's computer and run a session through the hub with the site's
 * cookies (`credentials: 'include'` + host permission) and the hub's trustedOrigins.
 *
 * Which browser: Chrome 137+ (branded) ignores --load-extension, so a system Chrome usually cannot
 * run this. Order: UNCAGE_EXTENSION_CHROME=<executable> (Chrome for Testing / Chromium), else
 * Playwright's bundled Chromium when installed (CI), else system Chrome. If the extension does not
 * load, the test skips and says why. No display needed (new headless). Nothing is downloaded.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { chromium, expect, test } from '@playwright/test';
import { CONNECTED_PORTS } from '../playwright.config.ts';
import { connectMachine } from './golden-path.ts';
import { repo, Stack } from './stack.ts';

test.describe.configure({ mode: 'serial' });

/** Derived from the throwaway public `key` in examples/connected-extension/manifest.json. */
const EXTENSION_ID = 'bocaoaanfikfdhmnhipmjpkcepaioapj';
const extDir = join(repo, 'examples/connected-extension');

const stack = new Stack('extension');
test.afterAll(() => stack.cleanup());

test('side panel lists the signed-in user\'s computer and runs a session through the hub', async (_fixtures, testInfo) => {
  test.setTimeout(180_000);
  const url = `http://localhost:${CONNECTED_PORTS.extension}`;

  // The extension, built for this stack's hub origin (host_permissions come from HUB_ORIGIN).
  const outDir = stack.tmp('extension-dist');
  await promisify(execFile)(process.execPath, [join(extDir, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', outDir, '--emptyOutDir'], { cwd: extDir, env: { ...process.env, HUB_ORIGIN: url } });

  const bundled = chromium.executablePath();
  const executablePath = process.env.UNCAGE_EXTENSION_CHROME || (existsSync(bundled) ? bundled : undefined);
  const context = await chromium.launchPersistentContext(stack.tmp('chrome-profile'), {
    ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    headless: true,
    args: [`--disable-extensions-except=${outDir}`, `--load-extension=${outDir}`, '--disable-features=DisableLoadExtensionCommandLineSwitch'],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 8_000 }).catch(() => undefined));
    test.skip(!worker, `this browser did not load the unpacked extension (${executablePath ?? 'system Chrome'}); Chrome 137+ ignores --load-extension. Set UNCAGE_EXTENSION_CHROME to a Chromium / Chrome for Testing binary.`);
    expect(new URL(worker!.url()).host).toBe(EXTENSION_ID);

    const demo = await stack.demo(CONNECTED_PORTS.extension, { TRUSTED_ORIGINS: `chrome-extension://${EXTENSION_ID}` });
    expect(demo.url).toBe(url);
    const page = await context.newPage();
    // Sign in on the site, connect a computer (real `uncage setup`) and start the fake agent.
    const { input } = await connectMachine({ page, stack, url, agent: (home) => stack.fakeAgent(home) });
    await expect(input).toBeEnabled();

    // The panel: no sign-in UI of its own; the site's cookie authenticates it.
    const panel = await context.newPage();
    const errors: string[] = [];
    panel.on('pageerror', (e) => errors.push(e.message));
    await panel.goto(`chrome-extension://${EXTENSION_ID}/panel.html`);
    await expect(panel.getByRole('button', { name: /^Computer: .+ \(online\)$/ })).toBeVisible({ timeout: 30_000 });
    const box = panel.getByRole('textbox', { name: 'Message' });
    await expect(box).toBeEnabled({ timeout: 30_000 });
    await box.fill('hello from the side panel');
    await box.press('Enter');
    await expect(panel.locator('.uc-user-bubble', { hasText: 'hello from the side panel' })).toBeVisible();
    await expect(panel.locator('.uc-assistant', { hasText: 'fake: hello from the side panel' })).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator('.uc-runstatus')).toHaveAttribute('data-state', 'completed', { timeout: 30_000 });
    await panel.screenshot({ path: testInfo.outputPath('panel.png') });
    expect(errors).toEqual([]);

    // An extension the hub does not trust is refused (403), cookie or not; the trusted one is not.
    const post = (origin: string) => context.request.post(`${url}/api/uncage/sessions`, { data: {}, headers: { origin }, failOnStatusCode: false });
    expect((await post('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).status()).toBe(403);
    expect((await post(`chrome-extension://${EXTENSION_ID}`)).status()).not.toBe(403);
  } finally {
    await context.close();
  }
});
