import { chatFor, expect, test } from './fixtures.ts';

test('browsing via 127.0.0.1 works through the proxy', async ({ page, example, baseURL }) => {
  const url = new URL(baseURL!);
  url.hostname = '127.0.0.1';
  const chat = chatFor(page, example);
  await chat.open(url.href);
  await chat.send('simple');

  await chat.expectRunState('completed');
  await expect(chat.alert).toHaveCount(0);
});
