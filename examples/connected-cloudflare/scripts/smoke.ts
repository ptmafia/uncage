/**
 * End-to-end smoke test of a running Worker (`pnpm dev`, or a deployed URL):
 *
 *   UNCAGE_HOME=$(mktemp -d) node scripts/smoke.ts [--url http://localhost:8787] [--runtime claude-code|fake] [--user smoke]
 *
 * 1. `install.sh` is served and `GET /api/uncage/agent/info` offers only the `http` transport.
 * 2. Signs in (`/login`), connects a computer with the real `uncage setup <url> --no-daemon
 *    --no-browser` and approves its code on `/device`.
 * 3. Starts the agent: `--runtime claude-code` (default) runs the real `uncage agent` with your
 *    Claude Code; `--runtime fake` runs the agent in this process with a scripted runtime instead.
 * 4. Creates a session, starts a run asking it to call `save_note`, reads the session's SSE events
 *    to `run.completed` (approving any approval card), then checks `GET /notes` for the note.
 *
 * UNCAGE_HOME is required and must not be your real ~/.uncage: the smoke pairs a throwaway machine.
 * Needs the monorepo built (`pnpm build`, for packages/cli/dist).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  allowPositionals: true, // tolerate a stray `--` from `pnpm smoke -- …`
  options: {
    url: { type: 'string', default: 'http://localhost:8787' },
    runtime: { type: 'string', default: 'claude-code' },
    user: { type: 'string', default: `smoke-${Date.now().toString(36)}` },
    timeout: { type: 'string', default: '300' },
  },
});
const base = values.url.replace(/\/+$/, '');
const api = `${base}/api/uncage`;
const runtime = values.runtime;
const deadline = Date.now() + Number(values.timeout) * 1000;
const cliBin = join(dirname(fileURLToPath(import.meta.url)), '../../../packages/cli/dist/bin.js');

const home = process.env.UNCAGE_HOME;
if (!home || resolve(home) === resolve(homedir(), '.uncage')) {
  console.error('Set UNCAGE_HOME to a throwaway directory (e.g. UNCAGE_HOME=$(mktemp -d)); never your real ~/.uncage.');
  process.exit(2);
}

const step = (s: string) => console.log(`• ${s}`);
function check(ok: unknown, what: string): asserts ok {
  if (!ok) throw new Error(`smoke failed: ${what}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const children: ChildProcess[] = [];
let closeAgent: (() => Promise<void>) | undefined;

async function main(): Promise<void> {
  // 1. Installer and transports.
  const install = await fetch(`${api}/install.sh`);
  check(install.status === 200 && (await install.text()).includes('uncage'), `install.sh answered ${install.status}`);
  step('install.sh is served');
  const info = (await (await fetch(`${api}/agent/info`)).json()) as { transports: Array<{ kind: string }> };
  check(JSON.stringify(info.transports.map((t) => t.kind)) === '["http"]', `agent/info transports ${JSON.stringify(info.transports)}`);
  step('agent/info offers only http');

  // 2. Sign in, then connect a computer through the device flow.
  const login = await fetch(`${base}/login?user=${encodeURIComponent(values.user)}`, { redirect: 'manual' });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  check(login.status === 303 && cookie, `login answered ${login.status}`);
  step(`signed in as ${values.user}`);
  const as = (path: string, init: RequestInit = {}) =>
    fetch(`${api}${path}`, { ...init, headers: { cookie, origin: base, ...(init.headers as Record<string, string>) } });

  const setup = spawn(process.execPath, [cliBin, 'setup', base, '--no-daemon', '--no-browser'], { env: { ...process.env, UNCAGE_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(setup);
  let setupOut = '';
  setup.stdout.on('data', (c: Buffer) => (setupOut += c.toString()));
  setup.stderr.on('data', (c: Buffer) => (setupOut += c.toString()));
  const setupExit = new Promise<number | null>((r) => setup.once('exit', r));
  let code: string | undefined;
  while (!code) {
    check(Date.now() < deadline && setup.exitCode === null, `uncage setup printed no code:\n${setupOut}`);
    code = /confirm the code:\s+(\S+)/.exec(setupOut)?.[1];
    if (!code) await sleep(200);
  }
  const approve = await fetch(`${base}/device`, {
    method: 'POST',
    headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, decision: 'approve' }),
  });
  check(approve.status === 200, `approving ${code} answered ${approve.status}: ${await approve.text()}`);
  check((await setupExit) === 0, `uncage setup failed:\n${setupOut}`);
  step(`computer connected (code ${code})`);

  // 3. The agent.
  if (runtime === 'fake') closeAgent = await fakeAgent(home!);
  else {
    const agent = spawn(process.execPath, [cliBin, 'agent'], { env: { ...process.env, UNCAGE_HOME: home, UNCAGE_LOG_LEVEL: 'info' }, stdio: ['ignore', 'inherit', 'inherit'] });
    children.push(agent);
  }
  let machine: { online: boolean; transport: string | null; runtimes: Array<{ id: string; status: string }> } | undefined;
  for (;;) {
    machine = ((await (await as('/machines')).json()) as Array<NonNullable<typeof machine>>)[0];
    if (machine?.online && machine.runtimes.some((r) => r.id === runtime && r.status === 'available')) break;
    check(Date.now() < deadline, `machine never came online with runtime ${runtime}: ${JSON.stringify(machine)}`);
    await sleep(500);
  }
  check(machine.transport === 'http', `machine transport ${machine.transport}`);
  step(`agent online over ${machine.transport} with ${runtime}`);

  // 4. A run that calls the site tool.
  const nonce = `smoke-${Math.random().toString(36).slice(2, 10)}`;
  const created = await as('/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runtime, title: 'Cloudflare smoke' }) });
  check(created.status === 201, `create session answered ${created.status}: ${await created.clone().text()}`);
  const session = (await created.json()) as { id: string };
  const prompt = `Use the save_note tool of this website to save a note with the title "Cloudflare smoke" and the body "${nonce}". Do nothing else, then reply "done".`;
  const started = await as(`/sessions/${session.id}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({ prompt }),
  });
  check(started.status === 202, `start run answered ${started.status}: ${await started.clone().text()}`);
  const run = (await started.json()) as { id: string };
  step(`run ${run.id} started in session ${session.id}`);

  let lastEventId: string | undefined;
  let outcome: string | undefined;
  while (!outcome) {
    check(Date.now() < deadline, 'no run.completed before the timeout');
    const res = await as(`/sessions/${session.id}/events`, { headers: { accept: 'text/event-stream', ...(lastEventId ? { 'last-event-id': lastEventId } : {}) } });
    check(res.status === 200 && res.body, `events answered ${res.status}`);
    for await (const frame of sse(res)) {
      if (frame.id) lastEventId = frame.id;
      if (frame.event === 'reconnect') break; // the stream rotated: resume after lastEventId
      if (!frame.data) continue;
      const ev = JSON.parse(frame.data) as { type: string; runId?: string; payload: Record<string, unknown> };
      if (ev.type.startsWith('tool.') && ev.type !== 'tool.updated') console.log(`  ${ev.type} ${JSON.stringify(ev.payload).slice(0, 160)}`);
      if (ev.type === 'approval.requested') {
        const approval = ev.payload.approval as { id: string; title?: string };
        console.log(`  approving "${approval.title ?? approval.id}"`);
        await as(`/approvals/${approval.id}/decision`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ decision: 'allow', scope: 'once' }) });
      }
      if (ev.runId === run.id && ['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'].includes(ev.type)) {
        outcome = ev.type;
        if (ev.type !== 'run.completed') console.error(`  ${ev.type}: ${JSON.stringify(ev.payload)}`);
        break;
      }
    }
  }
  check(outcome === 'run.completed', `run ended with ${outcome}`);
  step('run.completed');

  const notes = (await (await fetch(`${base}/notes`, { headers: { cookie } })).json()) as Array<{ title: string; body: string }>;
  check(notes.some((n) => n.body.includes(nonce)), `/notes has no note with ${nonce}: ${JSON.stringify(notes)}`);
  step(`/notes has the note (${nonce})`);
  console.log('SMOKE OK');
}

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
        if (block.startsWith(':')) continue; // heartbeat
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

/** The real @uncage/agent in this process, with a scripted runtime that calls save_note. */
async function fakeAgent(uncageHome: string): Promise<() => Promise<void>> {
  const { createAgent, createAgentLogger, loadAgentConfig } = await import('@uncage/agent');
  const { createFakeAdapter } = await import('@uncage/testkit');
  const agent = await createAgent({
    config: await loadAgentConfig(uncageHome),
    home: uncageHome,
    logger: createAgentLogger(process.env.UNCAGE_LOG_LEVEL ?? 'info'),
    adapters: () => [
      createFakeAdapter({
        id: 'fake',
        displayName: 'Fake Runtime',
        script: (input) => {
          const body = /body "([^"]+)"/.exec(input.prompt)?.[1] ?? input.prompt;
          return [
            { text: 'Saving the note.' },
            { callTool: { name: 'save_note', args: { title: 'Cloudflare smoke', body } } },
            { text: 'done' },
          ];
        },
      }),
    ],
  });
  return () => agent.close();
}

try {
  await main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await closeAgent?.().catch(() => undefined);
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
}
