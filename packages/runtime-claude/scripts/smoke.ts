// Manual smoke test against real Claude Code (spends tokens). Run: pnpm --filter @uncage/runtime-claude smoke [flags]
//   (no flags)                    write hello.txt in `default` mode → exactly one approval
//   --permission-mode <mode>      run the write in that mode (`acceptEdits` → no approval requested)
//   --image <png>                 send the image; the answer must contain UNCAGE-42; then resume the
//                                 session with an attached .md file (streaming input + resume)
//   --model <id> --effort <level> session settings for every run
//   --site                        connected-mode site tools + skills: echo_text (no confirmation) is called
//                                 and its result used; stamp_note (requiresConfirmation) raises exactly one
//                                 approval (auto-allowed); a skill makes every answer end with KUMQUAT
// Always checks that refreshCapabilities() reads ≥1 model from supportedModels().
// Raw SDK messages are recorded to <tmp>/sdk-messages.jsonl for checking fixture shapes.
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AdapterRunInput, EffortLevel, NativeApprovalInput, PermissionMode, ResolvedAttachment, RunTool, RuntimeEvent, SkillSpec } from '@uncage/protocol';

type Mod = typeof import('../src/index.js');
const { claudeAdapter, CLAUDE_FALLBACK_MODELS } = (await import(new URL('../dist/index.js', import.meta.url).href)) as Mod;

const { values: args } = parseArgs({
  // `pnpm smoke -- --flag` forwards the `--`.
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    image: { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string' },
    'permission-mode': { type: 'string', default: 'default' },
    site: { type: 'boolean', default: false },
  },
});
const permissionMode = args['permission-mode'] as PermissionMode;
const settings: AdapterRunInput['settings'] = {
  permissionMode,
  ...(args.model ? { model: args.model } : {}),
  ...(args.effort ? { effort: args.effort as EffortLevel } : {}),
};

const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'uncage-claude-smoke-')));
const record = join(cwd, 'sdk-messages.jsonl');

const recordingQuery: typeof query = (params) => {
  const q = query(params);
  const next = q.next.bind(q);
  q.next = async (...a) => {
    const r = await next(...a);
    if (!r.done) appendFileSync(record, JSON.stringify(r.value) + '\n');
    return r;
  };
  return q;
};

const adapter = claudeAdapter({ query: recordingQuery, allowBypass: permissionMode === 'bypassPermissions' });
console.log('probe', await adapter.probe());
console.log('cwd', cwd, 'settings', settings);

const caps = await adapter.refreshCapabilities!();
console.log('models', caps.models.map((m) => m.id).join(', '));
const checks: Record<string, boolean> = {
  supportedModels: caps.models !== CLAUDE_FALLBACK_MODELS && caps.models.length >= 1,
};

function attachment(absPath: string, kind: 'image' | 'file', mime: string): ResolvedAttachment {
  const bytes = readFileSync(absPath);
  return {
    id: `att_${basename(absPath)}`, sessionId: 'smoke', name: basename(absPath), mime, size: statSync(absPath).size, kind,
    sha256: createHash('sha256').update(bytes).digest('hex'), createdAt: new Date().toISOString(), absPath,
  };
}

async function runOnce(
  prompt: string,
  attachments: ResolvedAttachment[],
  nativeSessionRef?: string,
  extra: Pick<AdapterRunInput, 'tools' | 'skills'> = {},
) {
  const events: RuntimeEvent[] = [];
  const approvalRequests: NativeApprovalInput[] = [];
  let approvals = 0;
  let answer = '';
  let ref: string | undefined;
  for await (const e of adapter.run(
    { runId: `run_smoke_${Date.now()}`, prompt, cwd, settings, attachments, ...(nativeSessionRef ? { nativeSessionRef } : {}), ...extra },
    {
      signal: AbortSignal.timeout(180_000),
      requestApproval: async (req) => {
        approvals++;
        approvalRequests.push(req);
        console.log('approval requested (auto-allow):', JSON.stringify(req));
        return { decision: 'allow' };
      },
    },
  )) {
    events.push(e);
    if (e.type === 'message.completed') answer += e.text;
    if (e.type === 'native.session') ref = e.ref;
    if (e.type !== 'message.delta') console.log(e.type, JSON.stringify(e));
  }
  return { events, approvals, approvalRequests, answer, ref, completed: events.at(-1)?.type === 'run.completed' };
}

if (args.site) {
  const calls: Array<{ name: string; args: unknown }> = [];
  const tools: RunTool[] = [
    {
      name: 'echo_text',
      description: 'Echo the given text back, prefixed with a server-side marker.',
      inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Text to echo' } }, required: ['text'] },
      requiresConfirmation: false,
      call: async (a) => {
        calls.push({ name: 'echo_text', args: a });
        return { content: [{ type: 'text', text: `ECHO-7731: ${(a as { text: string }).text}` }] };
      },
    },
    {
      name: 'stamp_note',
      description: 'Stamp a note on the website (needs the user to confirm).',
      inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
      requiresConfirmation: true,
      call: async (a) => {
        calls.push({ name: 'stamp_note', args: a });
        return { content: [{ type: 'json', json: { stamped: true, id: 'STAMP-5150' } }] };
      },
    },
  ];
  const skills: SkillSpec[] = [
    {
      name: 'kumquat-signoff',
      description: 'House style for every answer in this workspace. Always apply it.',
      markdown: 'Always end every answer with the single word KUMQUAT as the very last word.\n',
    },
  ];
  // Put the skill rule in front of the model the way a site would: it is in .claude/skills and discoverable.
  const r = await runOnce(
    'Use the echo_text tool with the text "hello uncage" and tell me exactly what it returned. ' +
      'Then use the stamp_note tool with the note "smoke" and tell me the id it returned. ' +
      'Before answering, check the available skills and follow any that apply.',
    [],
    undefined,
    { tools, skills },
  );
  console.log('answer:', JSON.stringify(r.answer), 'calls:', JSON.stringify(calls));
  console.log('skill file:', existsSync(join(cwd, '.claude', 'skills', 'kumquat-signoff', 'SKILL.md')));
  checks.runCompleted = r.completed;
  checks.echoCalled = calls.some((c) => c.name === 'echo_text');
  checks.echoResultUsed = r.answer.includes('ECHO-7731');
  checks.stampApprovalOnce = r.approvalRequests.filter((q) => q.category === 'mcp' && q.target?.command?.startsWith('stamp_note(')).length === 1;
  checks.noEchoApproval = !r.approvalRequests.some((q) => q.target?.command?.startsWith('echo_text('));
  checks.stampResultUsed = r.answer.includes('STAMP-5150');
  checks.skillFollowed = /KUMQUAT\W*$/.test(r.answer.trim());
} else if (args.image) {
  const png = join(cwd, 'uncage-42.png');
  copyFileSync(resolve(args.image), png);
  const first = await runOnce('What text is shown in this image? Reply with the text only.', [attachment(png, 'image', 'image/png')]);
  console.log('answer 1:', JSON.stringify(first.answer));
  checks.imageCompleted = first.completed;
  checks.imageAnswer = first.answer.includes('UNCAGE-42');

  // Resume the same Claude session with streaming input again (a file attachment this time).
  const md = join(cwd, 'note.md');
  writeFileSync(md, 'The secret word is ZEBRA-9.\n');
  const second = await runOnce(
    'Reply with two things on one line: the text from the image I sent earlier, and the secret word in the attached file.',
    [attachment(md, 'file', 'text/markdown')],
    first.ref,
  );
  console.log('answer 2:', JSON.stringify(second.answer));
  checks.resumeCompleted = second.completed;
  checks.resumeRemembersImage = second.answer.includes('UNCAGE-42');
  checks.resumeReadsFile = second.answer.includes('ZEBRA-9');
} else {
  const r = await runOnce('Create a file hello.txt containing hi using the Write tool', []);
  const file = join(cwd, 'hello.txt');
  console.log('hello.txt:', existsSync(file) ? JSON.stringify(readFileSync(file, 'utf8')) : '(missing)');
  checks.approvals = permissionMode === 'default' ? r.approvals === 1 : r.approvals === 0;
  checks.toolCompleted = r.events.some((e) => e.type === 'tool.completed');
  checks.runCompleted = r.completed;
  checks.helloExists = existsSync(file);
}

const init = readFileSync(record, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { type: string; subtype?: string; model?: string; permissionMode?: string })
  .find((m) => m.type === 'system' && m.subtype === 'init');
console.log('init model:', init?.model, 'permissionMode:', init?.permissionMode);
console.log('raw messages:', record);
console.log('checks', checks);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
