import { expect, test } from './fixtures.ts';

test('deny', async ({ chat }) => {
  await chat.open();
  await chat.send('approval');

  await expect(chat.approvalCard).toBeVisible();
  await chat.deny.click();

  await expect(chat.approvalLine).toHaveAttribute('data-state', 'denied');
  await expect(chat.approvalLine).toContainText('你拒绝了');
  // onDeny: 'continue' — the run goes on and completes.
  await chat.expectRunState('completed');
  await expect(chat.assistant.last()).toContainText('All done.');
});
