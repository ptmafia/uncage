import { expect, test } from './fixtures.ts';

test('approve', async ({ chat }) => {
  await chat.open();
  await chat.send('approval');

  await expect(chat.approvalCard).toBeVisible();
  await expect(chat.approvalCard).toContainText('echo hi');
  await chat.allow.click();

  await expect(chat.approvalCard).toHaveCount(0);
  await expect(chat.approvalLine).toHaveAttribute('data-state', 'approved');
  await expect(chat.approvalLine).toHaveText('已允许');
  await expect(chat.toolDone).toBeVisible();
  await chat.expectRunState('completed');
});
