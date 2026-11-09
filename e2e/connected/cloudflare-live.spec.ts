/**
 * The Cloudflare shape against REAL Claude Code: examples/connected-cloudflare under `wrangler dev`
 * (workerd, local mode) on a throwaway docker Postgres (Hyperdrive's local connection string).
 *
 *   sign in on /login (the example's demo form) → real `uncage setup --no-daemon` → its code
 *   approved on /device in the browser → real `uncage agent` (Claude Code only; tmp UNCAGE_HOME)
 *   online over HTTP streaming → one run through the browser API asking Claude Code to call the
 *   site tool `save_note` (approval cards allowed) → run.completed → the note is on /notes.
 *
 * Needs `pnpm build` (packages/cli/dist) and Docker. Run with
 * `UNCAGE_LIVE=1 pnpm --filter @uncage/e2e exec playwright test --project=connected-cloudflare-live`.
 */
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { CONNECTED_PORTS } from '../playwright.config.ts';
import { cliBin, Stack, until, type Proc } from './stack.ts';

const stack = new Stack('cloudflare-live');
test.afterAll(() => stack.cleanup());

interface Machine {
  online: boolean;
  transport: string | null;
  runtimes: Array<{ id: string; status: string }>;
}

test('Cloudflare Workers with real Claude Code: connect → one run calling save_note → note visible', async ({ page }) => {
  const t0 = Date.now();
  const { databaseUrl } = await stack.dockerPostgres();
  const { url } = await stack.wrangler(CONNECTED_PORTS.cloudflareLive, { databaseUrl });
  const api = `${url}/api/uncage`;

  const info = (await (await page.request.get(`${api}/agent/info`)).json()) as { transports: Array<{ kind: string }> };
  expect(info.transports.map((t) => t.kind)).toEqual(['http']);
  expect((await page.request.get(`${api}/install.sh`)).status()).toBe(200);

  // 1. Sign in through the example's (demo) form.
  await page.goto(`${url}/login`);
  await page.getByLabel('User name').fill('cfuser');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Signed in as')).toBeVisible();

  // 2. Real `uncage setup`, its code approved on /device.
  const home = stack.tmp('uncage-home');
  const setup = await stack.spawn('setup', [cliBin, 'setup', url, '--no-daemon', '--no-browser'], { env: { UNCAGE_HOME: home }, marker: 'Waiting for approval' });
  const link = /(https?:\/\/\S+\/device\?code=\S+)/.exec(setup.output())?.[1];
  expect(link, setup.output()).toBeTruthy();
  await page.goto(link!);
  await expect(page.getByText(/Computer: /)).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.locator('[data-result="ok"]')).toBeVisible();
  const exit = await new Promise<number | null>((resolve) => (setup.proc.exitCode !== null ? resolve(setup.proc.exitCode) : setup.proc.once('exit', resolve)));
  expect(exit, setup.output()).toBe(0);
  const tConnected = Date.now();

  // 3. The real agent comes online over HTTP streaming with Claude Code.
  const agent: Proc = await stack.claudeAgent(home);
  let machine: Machine | undefined;
  await until(
    async () => {
      machine = ((await (await page.request.get(`${api}/machines`)).json()) as Machine[])[0];
      return !!machine?.online && machine.runtimes.some((r) => r.id === 'claude' && r.status === 'available');
    },
    90_000,
    'machine online with claude',
  );
  expect(machine!.transport).toBe('http');

  // 4. One run that calls the site tool, approving any card, read from the session's SSE stream.
  const cookie = (await page.context().cookies(url)).map((c) => `${c.name}=${c.value}`).join('; ');
  const as = (path: string, init: RequestInit = {}) => fetch(`${api}${path}`, { ...init, headers: { cookie, origin: url, ...(init.headers as Record<string, string>) } });
  const created = await as('/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runtime: 'claude', title: 'Cloudflare live' }) });
  expect(created.status).toBe(201);
  const session = (await created.json()) as { id: string };
  const nonce = `cf-live-${Math.random().toString(36).slice(2, 10)}`;
  const prompt = `Use the save_note tool of this website to save a note with the title "Cloudflare live" and the body "${nonce}". Do nothing else, then reply "done".`;
  const tRun = Date.now();
  const startedRun = await as(`/sessions/${session.id}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ prompt }),
  });
  expect(startedRun.status).toBe(202);
  const run = (await startedRun.json()) as { id: string };

  const tools: string[] = [];
  const approvals: string[] = [];
  let deltas = 0;
  let lastEventId: string | undefined;
  let outcome: string | undefined;
  const deadline = Date.now() + 600_000;
  while (!outcome) {
    expect(Date.now() < deadline, 'run.completed before the timeout').toBe(true);
    const res = await as(`/sessions/${session.id}/events`, { headers: { accept: 'text/event-stream', ...(lastEventId ? { 'last-event-id': lastEventId } : {}) } });
    expect(res.status).toBe(200);
    for await (const frame of sse(res)) {
      if (frame.id) lastEventId = frame.id;
      if (frame.event === 'reconnect') break;
      if (!frame.data) continue;
      const ev = JSON.parse(frame.data) as { type: string; runId?: string; payload: Record<string, unknown> };
      if (ev.type === 'message.delta') deltas++;
      if (ev.type === 'tool.started') tools.push(JSON.stringify(ev.payload).slice(0, 200));
      if (ev.type === 'approval.requested') {
        const approval = ev.payload.approval as { id: string; title?: string };
        approvals.push(approval.title ?? approval.id);
        await as(`/approvals/${approval.id}/decision`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
          body: JSON.stringify({ decision: 'allow', scope: 'once' }),
        });
      }
      if (ev.runId === run.id && ['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'].includes(ev.type)) {
        outcome = ev.type;
        if (ev.type !== 'run.completed') stack.log(`${ev.type}: ${JSON.stringify(ev.payload)}`);
        break;
      }
    }
  }
  const tDone = Date.now();
  stack.log(`cloudflare live: outcome ${outcome}; tools ${tools.join(' | ')}; approvals ${approvals.join(' | ')}; deltas ${deltas}`);
  expect(outcome).toBe('run.completed');
  expect(tools.some((t) => t.includes('save_note')), tools.join(' | ')).toBe(true);

  // 5. The note is on the website.
  await page.goto(`${url}/notes`);
  await expect(page.getByText(nonce)).toBeVisible();
  await page.screenshot({ path: stack.resultPath('notes.png'), fullPage: true });
  stack.log(`cloudflare live timings: connect ${tConnected - t0} ms, run ${tDone - tRun} ms, total ${Date.now() - t0} ms; rotations ${stack.count(agent, /http stream rotated/)}`);
  await agent.stop();
});

/** Server-sent events of a response, one frame at a time. */
async function* sse(res: Response): AsyncGenerator<{ id?: string; event?: string; data: string }> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += value;
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (block.startsWith(':')) continue;
        const frame: { id?: string; event?: string; data: string } = { data: '' };
        for (const line of block.split('\n')) {
          const at = line.indexOf(':');
          const k = line.slice(0, at);
          const v = line.slice(at + 1).replace(/^ /, '');
          if (k === 'id') frame.id = v;
          else if (k === 'event') frame.event = v;
          else if (k === 'data') frame.data += v;
        }
        yield frame;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
