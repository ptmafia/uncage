import type { Route } from '@playwright/test';
import { chatFor, expect, test } from './fixtures.ts';

test('two tabs approve', async ({ browser, page, chat, example }) => {
  await chat.open();
  await chat.send('approval');
  await expect(chat.approvalCard).toBeVisible();
  const url = await chat.sessionUrl();

  const other = await browser.newContext();
  try {
    const page2 = await other.newPage();
    const chat2 = chatFor(page2, example);
    await page2.goto(url);
    await expect(chat2.approvalCard).toBeVisible();

    // Hold both decision requests until both tabs have clicked, so they race at the server.
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

    const decision = (p: typeof page) => p.waitForResponse((r) => r.url().endsWith('/decision'));
    const responses = Promise.all([decision(page), decision(page2)]);
    await chat.allow.click();
    await chat2.allow.click();
    // One wins; the loser gets 409 approval_already_resolved, which the store treats as no error.
    const statuses = (await responses).map((r) => r.status()).sort();
    expect(statuses).toEqual([200, 409]);

    for (const c of [chat, chat2]) {
      await expect(c.approvalLine).toHaveAttribute('data-state', 'approved');
      await expect(c.approvalLine).toHaveText('已允许');
      await c.expectRunState('completed');
      await expect(c.alert).toHaveCount(0);
    }
    expect(arrived).toBe(2);
  } finally {
    await other.close();
  }
});
