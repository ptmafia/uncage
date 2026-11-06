import { expect, test } from './fixtures.ts';

test('reload restores', async ({ page, chat }) => {
  await chat.open();
  await chat.send('approval');
  await expect(chat.approvalCard).toBeVisible();
  await chat.sessionUrl();

  await page.reload();

  await expect(chat.approvalCard).toBeVisible();
  await expect(chat.approvalCard).toContainText('echo hi');
  await expect(chat.userBubbles).toHaveCount(1);
  await chat.allow.click();

  await expect(chat.approvalLine).toHaveAttribute('data-state', 'approved');
  await chat.expectRunState('completed');
});
