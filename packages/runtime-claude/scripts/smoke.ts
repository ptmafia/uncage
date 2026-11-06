// Manual smoke test against real Claude Code (spends tokens). Run: pnpm --filter @uncage/runtime-claude smoke
// Raw SDK messages are recorded to <tmp>/sdk-messages.jsonl for checking fixture shapes.
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { RuntimeEvent } from '@uncage/protocol';

type Mod = typeof import('../src/index.js');
const { claudeAdapter } = (await import(new URL('../dist/index.js', import.meta.url).href)) as Mod;

const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'uncage-claude-smoke-')));
const record = join(cwd, 'sdk-messages.jsonl');

const recordingQuery: typeof query = (params) => {
  const q = query(params);
  const next = q.next.bind(q);
  q.next = async (...args) => {
    const r = await next(...args);
    if (!r.done) appendFileSync(record, JSON.stringify(r.value) + '\n');
    return r;
  };
  return q;
};

const adapter = claudeAdapter({ query: recordingQuery });
console.log('probe', await adapter.probe());
console.log('cwd', cwd);

const events: RuntimeEvent[] = [];
let approvals = 0;
for await (const e of adapter.run(
  { runId: 'run_smoke', prompt: 'Create a file hello.txt containing hi using the Write tool', cwd },
  {
    signal: AbortSignal.timeout(180_000),
    requestApproval: async (req) => {
      approvals++;
      console.log('approval requested (auto-allow):', JSON.stringify(req));
      return { decision: 'allow' };
    },
  },
)) {
  events.push(e);
  if (e.type !== 'message.delta') console.log(e.type, JSON.stringify(e));
}

const file = join(cwd, 'hello.txt');
const checks = {
  oneApproval: approvals === 1,
  toolCompleted: events.some((e) => e.type === 'tool.completed'),
  runCompleted: events.at(-1)?.type === 'run.completed',
  helloExists: existsSync(file),
};
console.log('hello.txt:', existsSync(file) ? JSON.stringify(readFileSync(file, 'utf8')) : '(missing)');
console.log('raw messages:', record);
console.log('checks', checks);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
