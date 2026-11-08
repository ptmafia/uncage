/**
 * Traditional-mode regression on the Railway shape: the demo's container image
 * (examples/connected-demo/Dockerfile — Next.js + hub + the machines' WebSocket on one port, PGlite
 * in the container's /data) with the real `uncage setup` and the real agent on the fake runtime,
 * through the whole connected golden path. Builds the image (`uncage-connected-demo:e2e`, docker's
 * cache makes rebuilds quick) when it is missing. Runs only with UNCAGE_DOCKER_TESTS=1 (project
 * `connected-container`); otherwise reported as skipped with the reason.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { CONNECTED_PORTS } from '../playwright.config.ts';
import { connectedGoldenPath } from './golden-path.ts';
import { repo, Stack, type Proc } from './stack.ts';

const SKIP_REASON = 'needs Docker (builds examples/connected-demo/Dockerfile): set UNCAGE_DOCKER_TESTS=1 to run';
test.skip(process.env.UNCAGE_DOCKER_TESTS !== '1', SKIP_REASON);
if (process.env.UNCAGE_DOCKER_TESTS !== '1') console.log(`connected-container skipped: ${SKIP_REASON}`);

const IMAGE = 'uncage-connected-demo:e2e';
const execFileP = promisify(execFile);
const stack = new Stack('container');
test.afterAll(() => stack.cleanup());

test('Railway shape (demo container, WebSocket): connect, run, approve, publish, reload history, offline', async ({ page }) => {
  test.setTimeout(900_000);
  const present = await execFileP('docker', ['image', 'inspect', IMAGE]).then(
    () => true,
    () => false,
  );
  if (!present) {
    stack.log(`building ${IMAGE}`);
    await execFileP('docker', ['build', '-f', 'examples/connected-demo/Dockerfile', '-t', IMAGE, '.'], { cwd: repo, timeout: 840_000, maxBuffer: 64 * 1024 * 1024 });
  }
  const demo = await stack.demoContainer(CONNECTED_PORTS.container, IMAGE);
  const info = (await (await page.request.get(`${demo.url}/api/uncage/agent/info`)).json()) as { transports: Array<{ kind: string }> };
  expect(info.transports.map((t) => t.kind)).toContain('ws');

  let agentProc!: Proc;
  await connectedGoldenPath({
    page,
    stack,
    url: demo.url,
    agent: async (home) => (agentProc = await stack.fakeAgent(home, { UNCAGE_LOG_LEVEL: 'info' })),
    runTimeoutMs: 60_000,
  });
  // The machine used the WebSocket transport (the agent logs it on connect).
  expect(agentProc.output()).toMatch(/"transport":"ws"/);
});
