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

  // Four Coming soon features, each badged (the group heading "Coming soon" is separate).
  await expect(page.locator('[data-soon-badge]')).toHaveCount(4);
  await expect(page.locator('[data-soon-badge]', { hasText: /^Coming soon$/ })).toHaveCount(4);
  await expect(page.locator('#features li.feat:not(.soon)')).toHaveCount(6);

  await expect(page.locator('link[rel="alternate"][hreflang="zh-CN"]')).toHaveAttribute('href', /\/zh\/$/);
  await expect(page.locator('link[rel="alternate"][hreflang="ja"]')).toHaveAttribute('href', /\/ja\/$/);
  await expect(page.locator('link[rel="alternate"][hreflang="x-default"]')).toHaveCount(1);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/$/);
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /\/og\/og-en\.png$/);

  await page.waitForLoadState('networkidle');
  expect(errors).toEqual([]);
});

test('no horizontal scroll at 375x812', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
});

test('zh and ja homepages: language, translated copy, docs links, switcher, OG image', async ({ page }) => {
  const errors = trackErrors(page);
  for (const c of [
    { path: '/zh/', lang: 'zh-CN', docs: '/docs/zh-cn/', og: 'zh', h1: '你的 coding agent，无处不在。', secondary: '几分钟完成接入', soon: '即将推出' },
    { path: '/ja/', lang: 'ja', docs: '/docs/ja/', og: 'ja', h1: 'あなたのコーディングエージェントを、どこでも。', secondary: '数分で組み込み', soon: '近日公開' },
  ] as const) {
    await page.goto(c.path);
    await expect(page.locator('html')).toHaveAttribute('lang', c.lang);
    await expect(page.locator('h1')).toHaveText(c.h1);
    await expect(page.locator('[data-cta="secondary"]')).toHaveText(c.secondary);
    await expect(page.locator('a[data-nav="nav-docs"]')).toHaveAttribute('href', c.docs);
    for (const sel of ['header a.cta', '[data-cta="primary"]', '[data-cta="final"]']) {
      await expect(page.locator(sel)).toHaveAttribute('href', `${c.docs}start/try-the-demo/`);
    }
    await expect(page.locator('[data-soon-badge]', { hasText: new RegExp(`^${c.soon}$`) })).toHaveCount(4);
    await expect(page.locator('#features li.feat:not(.soon)')).toHaveCount(6);
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

test('copy button copies the setup command', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  const btn = page.locator('.install button.copy');
  await btn.click();
  await expect(btn).toHaveAttribute('data-copied', '');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('npx uncage setup https://your.site');
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
