import { expect, test, type Page } from '@playwright/test';

/** Collects console errors and uncaught exceptions for the page's lifetime. */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

/** No empty cell in the feature grids: every row is full, and the two wide cards share the last row. */
async function assertFeatureRows(page: Page) {
  const grid = (await page.locator('#features ul.now').boundingBox())!;
  const wide = await page.locator('#features li.feat.wide').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
  expect(wide).toHaveLength(2);
  const [a, b] = wide as [DOMRect, DOMRect];
  const oneColumn = a.width > grid.width - 6;
  if (oneColumn) expect(b.width).toBeGreaterThan(grid.width - 6);
  else {
    expect(Math.abs(a.top - b.top)).toBeLessThan(2);
    expect(a.width + b.width).toBeGreaterThan(grid.width - 6);
  }
  // Every card of the 3×2 part is in a full row too: the cards per row times the card width fill the grid.
  const cards = await page.locator('#features li.feat:not(.soon):not(.wide)').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
  const perRow = Math.round(grid.width / cards[0]!);
  expect(cards.length % perRow).toBe(0);
  const later = (await page.locator('#features ul.later').boundingBox())!;
  const soon = await page.locator('#features li.feat.soon').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
  if (oneColumn) for (const w of soon) expect(w).toBeGreaterThan(later.width - 6);
  else expect(soon.reduce((x, y) => x + y, 0)).toBeGreaterThan(later.width - 6);
}

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

test('English homepage: language, headline, navigation, CTAs, Coming soon, hreflang, no errors', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');

  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('h1')).toHaveText('Run your coding agent everywhere.');
  await expect(page.locator('a[data-nav="nav-docs"]')).toHaveAttribute('href', '/docs/');
  await expect(page.locator('[data-cta="secondary"]')).toHaveText('Integrate in minutes');

  // Every "Try the demo" CTA goes to the help site's Try-the-demo page.
  for (const sel of ['header a.cta', '[data-cta="primary"]', '[data-cta="final"]']) {
    await expect(page.locator(sel)).toHaveAttribute('href', '/docs/start/try-the-demo/');
  }

  // Two Coming soon features, each badged (the group heading "Coming soon" is separate).
  await expect(page.locator('[data-soon-badge]')).toHaveCount(2);
  await expect(page.locator('[data-soon-badge]', { hasText: /^Coming soon$/ })).toHaveCount(2);
  await expect(page.locator('#features li.feat:not(.soon)')).toHaveCount(8);
  // The 7th and 8th cards (any ACP agent; macOS, Windows and Linux) share one row under the 3×2 grid.
  await assertFeatureRows(page);
  await expect(page.locator('#features li.feat.wide h4')).toHaveText(['Any ACP agent', 'macOS, Windows and Linux']);
  await expect(page.locator('#hero-title ~ .install [data-install-cmd]:visible')).toContainText('curl -fsSL https://your.site/api/uncage/install.sh | bash');

  await expect(page.locator('link[rel="alternate"][hreflang="zh-CN"]')).toHaveAttribute('href', /\/zh\/$/);
  await expect(page.locator('link[rel="alternate"][hreflang="ja"]')).toHaveAttribute('href', /\/ja\/$/);
  await expect(page.locator('link[rel="alternate"][hreflang="x-default"]')).toHaveCount(1);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/$/);
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /\/og\/og-en\.png$/);

  await page.waitForLoadState('networkidle');
  expect(errors).toEqual([]);
});

test('no horizontal scroll on phones (375, 360, 320) in every locale', async ({ page }) => {
  for (const width of [375, 360, 320]) {
    await page.setViewportSize({ width, height: 800 });
    for (const path of ['/', '/zh/', '/ja/']) {
      await page.goto(path);
      const { scrollWidth, innerWidth, h1Right } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        h1Right: Math.max(...[...document.querySelectorAll('h1, h1 *')].map((el) => el.getBoundingClientRect().right)),
      }));
      expect(scrollWidth, `${path} at ${width}`).toBeLessThanOrEqual(innerWidth);
      expect(h1Right, `${path} h1 at ${width}`).toBeLessThanOrEqual(innerWidth);
    }
  }
});

test('zh and ja homepages: language, translated copy, docs links, switcher, OG image', async ({ page }) => {
  const errors = trackErrors(page);
  for (const c of [
    { path: '/zh/', lang: 'zh-CN', docs: '/docs/zh-cn/', og: 'zh', h1: '你的 coding agent，无处不在。', secondary: '几分钟完成接入', soon: '即将推出', installLabel: '一条命令，一次批准' },
    { path: '/ja/', lang: 'ja', docs: '/docs/ja/', og: 'ja', h1: 'あなたのコーディングエージェントを、どこでも。', secondary: '数分で導入', soon: '近日公開', installLabel: 'コマンド1つ、承認1回' },
  ] as const) {
    await page.goto(c.path);
    await expect(page.locator('html')).toHaveAttribute('lang', c.lang);
    await expect(page.locator('h1')).toHaveText(c.h1);
    await expect(page.locator('[data-cta="secondary"]')).toHaveText(c.secondary);
    await expect(page.locator('a[data-nav="nav-docs"]')).toHaveAttribute('href', c.docs);
    for (const sel of ['header a.cta', '[data-cta="primary"]', '[data-cta="final"]']) {
      await expect(page.locator(sel)).toHaveAttribute('href', `${c.docs}start/try-the-demo/`);
    }
    await expect(page.locator('[data-soon-badge]', { hasText: new RegExp(`^${c.soon}$`) })).toHaveCount(2);
    await expect(page.locator('#features li.feat:not(.soon)')).toHaveCount(8);
    await expect(page.locator('.install-label')).toHaveText(c.installLabel);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', new RegExp(`${c.path}$`));
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', new RegExp(`/og/og-${c.og}\\.png$`));
    await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute('content', new RegExp(`/og/og-${c.og}\\.png$`));
    const og = await page.request.get(`/og/og-${c.og}.png`);
    expect(og.status()).toBe(200);
    expect(og.headers()['content-type']).toContain('image/png');
  }

  // The language switcher on /ja/ offers English (/) and Chinese (/zh/), and marks Japanese as current.
  await page.goto('/ja/');
  const picks = page.locator('header [data-lang-pick]');
  await expect(picks.and(page.locator('[data-lang-pick="en"]'))).toHaveAttribute('href', '/');
  await expect(picks.and(page.locator('[data-lang-pick="zh"]'))).toHaveAttribute('href', '/zh/');
  await expect(picks.and(page.locator('[data-lang-pick="ja"]'))).toHaveAttribute('aria-current', 'true');

  await page.waitForLoadState('networkidle');
  expect(errors).toEqual([]);
});

test('copy buttons copy the install command of the chosen OS', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  let btn = page.locator('.install [data-install-cmd]:visible button.copy');
  await btn.click();
  await expect(btn).toHaveAttribute('data-copied', '');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('curl -fsSL https://your.site/api/uncage/install.sh | bash');
  await page.getByRole('tab', { name: 'Windows' }).click();
  btn = page.locator('.install [data-install-cmd]:visible button.copy');
  await btn.click();
  await expect(btn).toHaveAttribute('data-copied', '');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('irm https://your.site/api/uncage/install.ps1 | iex');
});

test('install command follows the visitor OS and can be switched (mouse and keyboard)', async ({ browser }) => {
  // Windows: the UA plus navigator.platform / userAgentData.platform, as a real Windows Chrome reports them.
  const win = await browser.newContext({ userAgent: WINDOWS_UA });
  await win.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Win32' });
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => ({ platform: 'Windows', mobile: false, brands: [] }) });
  });
  const wp = await win.newPage();
  await wp.goto('/');
  await expect(wp.locator('.install [data-install-cmd]:visible')).toHaveCount(1);
  await expect(wp.locator('.install [data-install-cmd]:visible')).toContainText('irm https://your.site/api/uncage/install.ps1 | iex');
  await expect(wp.getByRole('tab', { name: 'Windows' })).toHaveAttribute('aria-selected', 'true');
  await expect(wp.locator('#how .step').first().locator('code .line:visible')).toHaveText('irm https://your.site/api/uncage/install.ps1 | iex');
  await win.close();

  // macOS (the default context): curl; the Windows tab switches; arrow keys switch back.
  const mac = await browser.newContext();
  await mac.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' });
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => ({ platform: 'macOS', mobile: false, brands: [] }) });
  });
  const page = await mac.newPage();
  await page.goto('/');
  const visible = page.locator('.install [data-install-cmd]:visible');
  await expect(visible).toHaveCount(1);
  await expect(visible).toContainText('curl -fsSL');
  await expect(page.getByRole('tablist')).toHaveAttribute('aria-label', 'Operating system');
  const unix = page.getByRole('tab', { name: 'macOS / Linux' });
  const windows = page.getByRole('tab', { name: 'Windows' });
  await expect(unix).toHaveAttribute('aria-selected', 'true');
  await windows.click();
  await expect(visible).toContainText('irm ');
  await expect(windows).toHaveAttribute('aria-selected', 'true');
  await expect(unix).toHaveAttribute('tabindex', '-1');
  await expect(page.locator('#how .step').first().locator('code .line:visible')).toHaveText('irm https://your.site/api/uncage/install.ps1 | iex');
  await windows.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(unix).toBeFocused();
  await expect(unix).toHaveAttribute('aria-selected', 'true');
  await expect(visible).toContainText('curl -fsSL');
  await expect(page.locator('[data-soon-badge]')).toHaveCount(2);
  await expect(page.locator('#features li.feat:not(.soon)')).toHaveCount(8);
  await mac.close();
});

test('feature grids have no empty cell at desktop, tablet and phone widths', async ({ page }) => {
  for (const width of [1440, 960, 800, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await assertFeatureRows(page);
  }
});

test('reduced motion: the flow diagram is fully visible at once', async ({ browser }) => {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  await page.goto('/');
  const opacity = await page.locator('.flow .term p').last().evaluate((el) => getComputedStyle(el).opacity);
  expect(opacity).toBe('1');
  expect(await page.locator('.flow .r').first().evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  await page.close();
});

test('robots.txt, sitemap and 404', async ({ request, page }) => {
  const robots = await request.get('/robots.txt');
  expect(await robots.text()).toContain('Sitemap: ');
  const sitemap = await request.get('/sitemap-0.xml');
  const xml = await sitemap.text();
  expect(xml).toContain('/zh/');
  expect(xml).toContain('hreflang="ja"');
  await page.goto('/404/');
  await expect(page.locator('h1')).toHaveText('Page not found');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
});

test('the language hint offers Japanese to a Japanese browser, and remembers dismissal', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'ja-JP' });
  const page = await context.newPage();
  await page.goto('/');
  const hint = page.locator('[data-lang-hint="ja"]');
  await expect(hint).toBeVisible();
  await expect(hint.locator('a')).toHaveAttribute('href', '/ja/');
  await hint.locator('[data-lang-dismiss]').click();
  await expect(hint).toBeHidden();
  await page.reload();
  await expect(hint).toBeHidden();
  await context.close();
});
