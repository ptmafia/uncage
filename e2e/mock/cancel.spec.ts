import { expect, test } from './fixtures.ts';

test('cancel', async ({ chat }) => {
  await chat.open();
  await chat.send('slow');

  await chat.expectRunState('running');
  await chat.stop.click();

  await chat.expectRunState('cancelled', { timeout: 5_000 });
  await expect(chat.stop).toHaveCount(0);
  await expect(chat.input).toBeEnabled();
});
