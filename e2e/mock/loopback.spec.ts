import { request as httpRequest } from 'node:http';
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

/** Raw HTTP GET with an explicit Host header (browsers and fetch won't let us forge it). */
function getWithHost(url: URL, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers: { host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('DNS rebinding: a foreign Host header gets 403 from the proxy, loopback Hosts pass', async ({ baseURL }) => {
  const url = new URL('/api/uncage/runtimes', baseURL!);
  const rebound = await getWithHost(url, `evil.com:${url.port}`);
  expect(rebound.status).toBe(403);
  expect((JSON.parse(rebound.body) as { error: { code: string } }).error.code).toBe('forbidden_origin');
  expect((await getWithHost(url, `127.0.0.1:${url.port}`)).status).toBe(200);
  expect((await getWithHost(url, `localhost:${url.port}`)).status).toBe(200);
});
