import { defineConfig } from '@playwright/test';
import type { ExampleOptions } from './mock/fixtures.ts';

/** Fixed ports so the examples' proxy can be pointed at the mock daemon. */
export const PORTS = { daemon: 4793, control: 4794, defaultChat: 3100, headlessChat: 3101, bypassDaemon: 4797, bypassChat: 3104 } as const;
/** The live stack (live-supervisor.ts): real `uncage serve` + both examples. */
export const LIVE_PORTS = { daemon: 4795, control: 4796, app: 3102, headlessApp: 3103, bypassDaemon: 4798, bypassApp: 3105 } as const;

/** Connected Mode (e2e/connected): the connected-demo website, started by the specs themselves. */
export const CONNECTED_PORTS = { mock: 3210, multinode: 3220, live: 3230, faas: 3240, acpLive: 3250, faasLive: 3260, cloudflareLive: 3270, container: 3280 } as const;

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
  // Local runs use the system Chrome; CI installs Playwright's bundled Chromium.
  use: { ...(process.env.CI ? {} : { channel: 'chrome' as const }), headless: true, trace: live ? 'on' : 'retain-on-failure' },
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
    {
      // Connected Mode with the fake runtime: demo site + real hub + real `uncage setup` + real agent.
      name: 'connected-mock',
      testDir: './connected',
      testMatch: 'mock.spec.ts',
    },
    {
      // Two hub nodes on real Redis + Postgres (docker) behind the demo's round-robin proxy. The
      // spec skips itself (with the reason) unless UNCAGE_DOCKER_TESTS=1.
      name: 'connected-multinode',
      testDir: './connected',
      testMatch: 'multinode.spec.ts',
    },
    {
      // FaaS mode: the demo under `next start` (no custom server, HTTP streaming, Postgres in
      // docker, public mode). The spec skips itself (with the reason) unless UNCAGE_DOCKER_TESTS=1.
      name: 'connected-faas-mock',
      testDir: './connected',
      testMatch: 'faas.spec.ts',
    },
    {
      // Connected Mode with REAL Claude Code (`uncage setup` + `uncage agent`). UNCAGE_LIVE=1 only.
      name: 'connected-live',
      testDir: './connected',
      testMatch: 'live.spec.ts',
      timeout: 900_000,
      ...(live ? {} : { testIgnore: '**' }),
    },
    {
      // Connected Mode with REAL Claude Code over ACP (the pinned @agentclientprotocol/claude-agent-acp
      // adapter, configured in agent.yaml `runtimes.acp`). UNCAGE_LIVE=1 only.
      name: 'connected-acp-live',
      testDir: './connected',
      testMatch: 'acp-live.spec.ts',
      timeout: 900_000,
      ...(live ? {} : { testIgnore: '**' }),
    },
    {
      // The Vercel shape with REAL Claude Code: `next start` (no custom server), docker Postgres,
      // 15 s stream rotation, public mode. UNCAGE_LIVE=1 only (and Docker).
      name: 'connected-faas-live',
      testDir: './connected',
      testMatch: 'faas-live.spec.ts',
      timeout: 900_000,
      ...(live ? {} : { testIgnore: '**' }),
    },
    {
      // The Cloudflare shape with REAL Claude Code: examples/connected-cloudflare under `wrangler dev`
      // (workerd) + docker Postgres through Hyperdrive's local connection string. UNCAGE_LIVE=1 only.
      name: 'connected-cloudflare-live',
      testDir: './connected',
      testMatch: 'cloudflare-live.spec.ts',
      timeout: 900_000,
      ...(live ? {} : { testIgnore: '**' }),
    },
    {
      // The Railway shape: the demo's container image (WebSocket + PGlite) with the fake runtime.
      // Skips itself (with the reason) unless UNCAGE_DOCKER_TESTS=1.
      name: 'connected-container',
      testDir: './connected',
      testMatch: 'container.spec.ts',
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
