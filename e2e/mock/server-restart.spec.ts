import { CONTROL_URL, expect, test } from './fixtures.ts';

test('server restart', async ({ page, chat, request }) => {
  await chat.open();
  await chat.send('approval');
  await expect(chat.approvalCard).toBeVisible();
  await chat.sessionUrl();

  // SIGKILL the daemon and start it again on the same data dir.
  const res = await request.post(`${CONTROL_URL}/restart`);
  expect(res.ok()).toBe(true);
  await page.reload();

  await chat.expectRunState('interrupted');
  await expect(chat.approvalLine).toHaveAttribute('data-state', 'expired');
  await expect(chat.approvalLine).toHaveText('确认已过期');
  await expect(page.getByRole('button', { name: '允许执行', disabled: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '拒绝', exact: true, disabled: false })).toHaveCount(0);
  await expect(chat.input).toBeEnabled();
});
