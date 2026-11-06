import { defineConfig } from '@playwright/test';
import type { ExampleOptions } from './mock/fixtures.ts';

/** Fixed ports so the examples' proxy can be pointed at the mock daemon. */
export const PORTS = { daemon: 4793, control: 4794, defaultChat: 3100, headlessChat: 3101 } as const;

const live = process.env.UNCAGE_LIVE === '1';
const exampleEnv = { UNCAGE_URL: `http://127.0.0.1:${PORTS.daemon}`, UNCAGE_TOKEN: 'test-token' };
// Next builds route-handler `req.url` with host `localhost`; loopback.spec.ts covers browsing
// via 127.0.0.1 (the proxy treats loopback names on the same port as one origin).
const nextStart = (dir: string, port: number) => ({
  command: `pnpm --dir ../examples/${dir} exec next start -p ${port}`,
  url: `http://localhost:${port}`,
  env: exampleEnv,
  reuseExistingServer: false,
  timeout: 60_000,
});

export default defineConfig<ExampleOptions>({
  testDir: '.',
  // One mock daemon is shared (and restarted by a spec), so everything runs serially.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: { channel: 'chrome', headless: true, trace: 'retain-on-failure' },
  projects: [
    {
      name: 'mock-default',
      testDir: './mock',
      use: { example: 'default', baseURL: `http://localhost:${PORTS.defaultChat}` },
    },
    {
      name: 'mock-headless',
      testDir: './mock',
      use: { example: 'headless', baseURL: `http://localhost:${PORTS.headlessChat}` },
    },
    {
      // Real Claude Code via a real `uncage serve` (Task 13). Skipped unless UNCAGE_LIVE=1.
      name: 'live-claude',
      testDir: './live',
      ...(live ? {} : { testIgnore: '**' }),
    },
  ],
  webServer: live
    ? []
    : [
        {
          command: `node mock-supervisor.ts`,
          url: `http://127.0.0.1:${PORTS.control}/ready`,
          env: { MOCK_PORT: String(PORTS.daemon), MOCK_CONTROL_PORT: String(PORTS.control) },
          reuseExistingServer: false,
          timeout: 30_000,
          // Playwright SIGKILLs web servers by default; SIGTERM lets the supervisor remove its tmp dir.
          gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
        },
        nextStart('nextjs-default-chat', PORTS.defaultChat),
        nextStart('react-headless-chat', PORTS.headlessChat),
      ],
});
