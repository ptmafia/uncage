import { defineConfig } from '@playwright/test';
import type { ExampleOptions } from './mock/fixtures.ts';

/** Fixed ports so the examples' proxy can be pointed at the mock daemon. */
export const PORTS = { daemon: 4793, control: 4794, defaultChat: 3100, headlessChat: 3101, bypassDaemon: 4797, bypassChat: 3104 } as const;
/** The live stack (live-supervisor.ts): real `uncage serve` + both examples. */
export const LIVE_PORTS = { daemon: 4795, control: 4796, app: 3102, headlessApp: 3103, bypassDaemon: 4798, bypassApp: 3105 } as const;

const live = process.env.UNCAGE_LIVE === '1';
const exampleEnv = (daemonPort: number) => ({ UNCAGE_URL: `http://127.0.0.1:${daemonPort}`, UNCAGE_TOKEN: 'test-token' });
// Next builds route-handler `req.url` with host `localhost`; loopback.spec.ts covers browsing
// via 127.0.0.1 (the proxy treats loopback names on the same port as one origin).
const nextStart = (dir: string, port: number, daemonPort: number = PORTS.daemon) => ({
  command: `pnpm --dir ../examples/${dir} exec next start -p ${port}`,
  url: `http://localhost:${port}`,
  env: exampleEnv(daemonPort),
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
  reporter: live
    ? [['list'], ['html', { outputFolder: 'live/results/report', open: 'never' }]]
    : 'list',
  ...(live ? { outputDir: 'live/results/artifacts' } : {}),
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: { channel: 'chrome', headless: true, trace: live ? 'on' : 'retain-on-failure' },
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
      // Real model turns: minutes per spec, not seconds.
      timeout: 600_000,
      use: { example: 'default', baseURL: `http://localhost:${LIVE_PORTS.app}` },
      ...(live ? {} : { testIgnore: '**' }),
    },
  ],
  webServer: live
    ? [
        {
          command: 'node live-supervisor.ts',
          url: `http://127.0.0.1:${LIVE_PORTS.control}/ready`,
          env: {
            LIVE_DAEMON_PORT: String(LIVE_PORTS.daemon),
            LIVE_CONTROL_PORT: String(LIVE_PORTS.control),
            LIVE_APP_PORT: String(LIVE_PORTS.app),
            LIVE_HEADLESS_PORT: String(LIVE_PORTS.headlessApp),
            LIVE_BYPASS_DAEMON_PORT: String(LIVE_PORTS.bypassDaemon),
            LIVE_BYPASS_APP_PORT: String(LIVE_PORTS.bypassApp),
          },
          reuseExistingServer: false,
          timeout: 120_000,
          stdout: 'ignore',
          // SIGTERM lets the supervisor stop uncage serve gracefully and remove its tmp dir.
          gracefulShutdown: { signal: 'SIGTERM', timeout: 20_000 },
        },
      ]
    : [
        {
          command: `node mock-supervisor.ts`,
          url: `http://127.0.0.1:${PORTS.control}/ready`,
          env: {
            MOCK_PORT: String(PORTS.daemon),
            MOCK_CONTROL_PORT: String(PORTS.control),
            MOCK_BYPASS_PORT: String(PORTS.bypassDaemon),
          },
          reuseExistingServer: false,
          timeout: 30_000,
          // Playwright SIGKILLs web servers by default; SIGTERM lets the supervisor remove its tmp dir.
          gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
        },
        nextStart('nextjs-default-chat', PORTS.defaultChat),
        nextStart('react-headless-chat', PORTS.headlessChat),
        // The default chat again, over the allowBypass mock daemon (composer.spec.ts).
        nextStart('nextjs-default-chat', PORTS.bypassChat, PORTS.bypassDaemon),
      ],
});
