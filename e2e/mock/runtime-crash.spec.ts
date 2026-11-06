import { expect, test } from './fixtures.ts';

test('runtime crash', async ({ chat }) => {
  await chat.open();
  await chat.send('crash');

  await chat.expectRunState('interrupted');
  await expect(chat.input).toBeEnabled();
  await expect(chat.stop).toHaveCount(0);

  // The composer really works again: the next prompt runs to completion in the same session.
  await chat.send('simple');
  await chat.expectRunState('completed');
  await expect(chat.userBubbles).toHaveCount(2);
});
