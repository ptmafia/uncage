import { expect, test } from './fixtures.ts';

test('send and stream', async ({ chat }) => {
  await chat.open();
  await chat.send('simple');

  await expect(chat.assistant.last()).toContainText('你好，我是模拟运行时。Streaming works end to end.');
  await chat.expectRunState('completed');
  await expect(chat.userBubbles).toHaveCount(1);
  await expect(chat.userBubbles.first()).toHaveText('simple');
  await expect(chat.input).toHaveValue('');
});
