// Manual smoke test against Claude Code's real ACP adapter (spends tokens), outside the browser.
// Run: pnpm --filter @uncage/runtime-acp smoke   (or `node packages/runtime-acp/scripts/smoke.ts` after a build)
//
//   1. initialize (raw): prints agentInfo, agentCapabilities and authMethods for docs/compatibility.md
//   2. run 1 (session/new): writes hello.txt (exactly one native approval, auto-allowed), then calls
//      the site tool stamp_note (requiresConfirmation → exactly one site approval; the agent's own
//      permission request for it is auto-allowed, no second card) → run.completed
//   3. run 2 (resume with the native session ref, the site MCP server declared again): the agent
//      remembers run 1 and calls echo_text (no confirmation) on the re-declared server
//
// The agent is `@agentclientprotocol/claude-agent-acp`, resolved from the e2e package's pinned
// devDependency (or CLAUDE_AGENT_ACP=<path to dist/index.js>) and started as `node <dist/index.js>`.
// It uses the existing Claude Code login under the real HOME. The raw ACP traffic (both
// directions) is recorded to <tmp>/acp-traffic.jsonl (mode 0600) by re-running this file as a tee,
// redacted as it is written (`redactAcpTraffic`: MCP bearer tokens, the agent's `_auth/status_update`
// account details, e-mail addresses). The script deletes the log when it ends; pass
// `--keep-traffic` to keep it for inspection (then delete it yourself when done).
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { AdapterRunInput, NativeApprovalInput, RunTool, RuntimeEvent } from '@uncage/protocol';

// Tee mode: `smoke.ts --tee <log> <cmd...>` relays stdio to <cmd> and logs every NDJSON line.
type Mod = typeof import('../src/index.js');
const loadDist = async (): Promise<Mod> => (await import(new URL('../dist/index.js', import.meta.url).href)) as Mod;

if (process.argv[2] === '--tee') {
  const [log, cmd, ...rest] = process.argv.slice(3) as [string, string, ...string[]];
  const { redactAcpTraffic } = await loadDist();
  const child = spawn(cmd, rest, { stdio: ['pipe', 'pipe', 'inherit'] });
  const tap = (dir: string) => (line: string) => appendFileSync(log, `${JSON.stringify({ t: Date.now(), dir, msg: redactAcpTraffic(safeParse(line)) })}\n`, { mode: 0o600 });
  createInterface({ input: process.stdin }).on('line', (l) => {
    tap('client→agent')(l);
    child.stdin.write(`${l}\n`);
  });
  process.stdin.on('end', () => child.stdin.end());
  createInterface({ input: child.stdout }).on('line', (l) => {
    tap('agent→client')(l);
    process.stdout.write(`${l}\n`);
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
} else {
  await main();
}

function safeParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return line;
  }
}

async function main(): Promise<void> {
  const { acpAdapter, startAcpProcess } = await loadDist();
  const keepTraffic = process.argv.includes('--keep-traffic');

  const here = dirname(fileURLToPath(import.meta.url));
  const repo = join(here, '../../..');
  const agentJs = process.env.CLAUDE_AGENT_ACP ?? join(repo, 'e2e/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js');
  if (!existsSync(agentJs)) throw new Error(`claude-agent-acp not found at ${agentJs} (pnpm install, or set CLAUDE_AGENT_ACP)`);
  const version = (JSON.parse(readFileSync(join(dirname(agentJs), '../package.json'), 'utf8')) as { version: string }).version;

  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'uncage-acp-smoke-')));
  const traffic = join(cwd, 'acp-traffic.jsonl');
  writeFileSync(traffic, '', { mode: 0o600 });
  try {
    const command = [process.execPath, fileURLToPath(import.meta.url), '--tee', traffic, process.execPath, agentJs];
    console.log(`claude-agent-acp ${version} (${agentJs})\ncwd ${cwd}`);

    // 1. The raw initialize result.
    const t0 = Date.now();
    const raw = await startAcpProcess({
      command,
      env: process.env,
      initTimeoutMs: 30_000,
      handlers: { onUpdate: () => undefined, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) },
    });
    console.log(`initialize (${Date.now() - t0} ms):`, JSON.stringify({ protocolVersion: raw.init.protocolVersion, agentInfo: raw.init.agentInfo, agentCapabilities: raw.init.agentCapabilities, authMethods: raw.init.authMethods }, null, 1));
    raw.kill();
    await raw.exited;

    const adapter = acpAdapter({ id: 'acp-claude', displayName: 'Claude Code (ACP)', command, initTimeoutMs: 30_000 });
    console.log('probe', await adapter.probe());
    const caps = await adapter.refreshCapabilities!();
    console.log('capabilities', JSON.stringify(caps));

    const calls: Array<{ name: string; args: unknown }> = [];
    const tools: RunTool[] = [
      {
        name: 'echo_text',
        description: 'Echo the given text back, prefixed with a server-side marker.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        requiresConfirmation: false,
        call: async (a) => {
          calls.push({ name: 'echo_text', args: a });
          return { content: [{ type: 'text', text: `ECHO-7731: ${(a as { text: string }).text}` }] };
        },
      },
      {
        name: 'stamp_note',
        description: 'Stamp a note on the website (the user confirms first).',
        inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
        requiresConfirmation: true,
        call: async (a) => {
          calls.push({ name: 'stamp_note', args: a });
          return { content: [{ type: 'json', json: { stamped: true, id: 'STAMP-5150' } }] };
        },
      },
    ];

    async function runOnce(prompt: string, nativeSessionRef?: string) {
      const events: RuntimeEvent[] = [];
      const approvals: NativeApprovalInput[] = [];
      let answer = '';
      let ref: string | undefined;
      const started = Date.now();
      let firstDelta: number | undefined;
      const input: AdapterRunInput = {
        runId: `run_smoke_${Date.now()}`,
        prompt,
        cwd,
        settings: { permissionMode: 'default' },
        attachments: [],
        tools,
        ...(nativeSessionRef ? { nativeSessionRef } : {}),
      };
      for await (const e of adapter.run(input, {
        signal: AbortSignal.timeout(300_000),
        requestApproval: async (req) => {
          approvals.push(req);
          console.log('approval requested (auto-allow):', JSON.stringify({ category: req.category, title: req.title, target: req.target }));
          return { decision: 'allow' };
        },
      })) {
        events.push(e);
        if (e.type === 'message.delta') firstDelta ??= Date.now() - started;
        if (e.type === 'message.completed') answer += e.text;
        if (e.type === 'native.session') ref = e.ref;
        if (e.type !== 'message.delta') console.log(e.type, JSON.stringify(e).slice(0, 400));
      }
      const ms = Date.now() - started;
      console.log(`run took ${ms} ms (first text after ${firstDelta ?? '-'} ms)`);
      return { events, approvals, answer, ref, completed: events.at(-1)?.type === 'run.completed' };
    }

    const r1 = await runOnce(
      'Do exactly two things, in order. 1) Create a file hello.txt containing the word hi, using your Write tool. ' +
        '2) Call the stamp_note tool with the note "smoke". Then reply with the id stamp_note returned.',
    );
    const siteApprovals = r1.approvals.filter((a) => a.target?.command?.startsWith('stamp_note('));
    const r2 = await runOnce('What id did stamp_note return earlier in this conversation? Then call the echo_text tool with the text "again" and reply with both results.', r1.ref);

    // How claude-agent-acp names MCP tool calls (matters for the site-tool auto-allow).
    const lines = readFileSync(traffic, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { dir: string; msg: { method?: string; params?: { update?: Record<string, unknown>; toolCall?: Record<string, unknown> }; result?: unknown; id?: unknown } });
    const toolCalls = lines.filter((l) => l.msg.params?.update?.sessionUpdate === 'tool_call').map((l) => l.msg.params!.update!);
    const permissionRequests = lines.filter((l) => l.msg.method === 'session/request_permission').map((l) => l.msg.params!.toolCall!);
    const pick = (u: Record<string, unknown>) => ({ title: u.title, name: u.name, kind: u.kind, _meta: u._meta });
    console.log('tool_call (title/name/kind/_meta):', JSON.stringify(toolCalls.map(pick), null, 1));
    console.log('request_permission toolCall:', JSON.stringify(permissionRequests.map(pick), null, 1));
    const resumeMethod = lines.find((l) => l.dir === 'client→agent' && (l.msg.method === 'session/resume' || l.msg.method === 'session/load'))?.msg.method;
    console.log('resume used:', resumeMethod ?? '(none)');

    const checks: Record<string, boolean> = {
      run1Completed: r1.completed,
      helloExists: existsSync(join(cwd, 'hello.txt')),
      nativeApprovalOnce: r1.approvals.filter((a) => !a.target?.command?.startsWith('stamp_note(')).length === 1,
      siteApprovalOnce: siteApprovals.length === 1,
      stampCalled: calls.some((c) => c.name === 'stamp_note'),
      stampResultUsed: r1.answer.includes('STAMP-5150'),
      resumed: r2.ref === r1.ref && !r2.events.some((e) => e.type === 'warning' && e.code === 'acp_resume_unsupported'),
      run2Completed: r2.completed,
      resumeRemembers: r2.answer.includes('STAMP-5150'),
      echoOnRedeclaredServer: calls.some((c) => c.name === 'echo_text') && r2.answer.includes('ECHO-7731'),
    };
    await adapter.dispose?.();
    console.log('calls', JSON.stringify(calls));
    console.log('answers', JSON.stringify([r1.answer, r2.answer]));
    console.log('checks', checks);
    process.exitCode = Object.values(checks).every(Boolean) ? 0 : 1;
  } finally {
    if (keepTraffic) console.log('raw traffic (redacted, kept):', traffic);
    else rmSync(traffic, { force: true });
  }
  process.exit();
}
