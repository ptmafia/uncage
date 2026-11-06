/**
 * Scripted turns for the fake `codex app-server`. Shapes mirror
 * packages/runtime-codex/src/protocol.ts (the official app-server v2 schema); keep them in sync.
 */

export interface TurnApi {
  readonly threadId: string;
  readonly turnId: string;
  readonly cwd: string;
  /** The text of the turn's input. */
  readonly prompt: string;
  /** Prompts of earlier turns in this thread, oldest first. */
  readonly history: readonly string[];
  notify(method: string, params: Record<string, unknown>): void;
  /** Sends a server → client request and resolves with its result. */
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  /** Resolves when the client sends `turn/interrupt` for this turn. */
  readonly interrupted: Promise<void>;
  isInterrupted(): boolean;
  /** Ends the process abruptly (the `crash` scenario). */
  crash(): never;
}

export type TurnOutcome = { status: 'completed' } | { status: 'interrupted' } | { status: 'failed'; message: string };
export type Scenario = (t: TurnApi) => Promise<TurnOutcome>;

let itemSeq = 0;
const itemId = (): string => `item_${++itemSeq}`;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

const ids = (t: TurnApi) => ({ threadId: t.threadId, turnId: t.turnId });

function itemStarted(t: TurnApi, item: Record<string, unknown>): void {
  t.notify('item/started', { ...ids(t), item, startedAtMs: Date.now() });
}
function itemCompleted(t: TurnApi, item: Record<string, unknown>): void {
  t.notify('item/completed', { ...ids(t), item, completedAtMs: Date.now() });
}

/** Streams an agent message in the given chunks. */
async function agentMessage(t: TurnApi, chunks: string[]): Promise<void> {
  const id = itemId();
  itemStarted(t, { type: 'agentMessage', id, text: '' });
  for (const delta of chunks) {
    await tick();
    t.notify('item/agentMessage/delta', { ...ids(t), itemId: id, delta });
  }
  itemCompleted(t, { type: 'agentMessage', id, text: chunks.join('') });
}

const accepted = (result: unknown): boolean => {
  const d = (result as { decision?: unknown } | undefined)?.decision;
  return d === 'accept' || d === 'acceptForSession';
};
const cancelled = (result: unknown): boolean => (result as { decision?: unknown } | undefined)?.decision === 'cancel';

const simple: Scenario = async (t) => {
  await agentMessage(t, ['Hello', ' from', ' fake Codex.']);
  return { status: 'completed' };
};

const recall: Scenario = async (t) => {
  const previous = t.history.at(-1);
  await agentMessage(t, previous === undefined ? ['I have no earlier prompt.'] : ['You said: ', previous]);
  return { status: 'completed' };
};

const approval: Scenario = async (t) => {
  const command = 'echo hello';
  const base = { type: 'commandExecution', id: itemId(), command, cwd: t.cwd, processId: null, commandActions: [] };
  itemStarted(t, { ...base, status: 'inProgress', aggregatedOutput: null, exitCode: null, durationMs: null });
  const result = await Promise.race([
    t.request('item/commandExecution/requestApproval', {
      ...ids(t),
      itemId: base.id,
      startedAtMs: Date.now(),
      command,
      cwd: t.cwd,
      reason: 'Run a harmless command',
    }),
    t.interrupted.then(() => undefined),
  ]);
  if (t.isInterrupted()) return { status: 'interrupted' };
  if (!accepted(result)) {
    itemCompleted(t, { ...base, status: 'declined', aggregatedOutput: null, exitCode: null, durationMs: null });
    if (cancelled(result)) return { status: 'interrupted' };
    await agentMessage(t, ['Okay, I did not run it.']);
    return { status: 'completed' };
  }
  t.notify('item/commandExecution/outputDelta', { ...ids(t), itemId: base.id, delta: 'hello\n' });
  await tick();
  itemCompleted(t, { ...base, status: 'completed', aggregatedOutput: 'hello\n', exitCode: 0, durationMs: 3 });
  await agentMessage(t, ['Ran it.']);
  return { status: 'completed' };
};

const file: Scenario = async (t) => {
  const base = { type: 'fileChange', id: itemId(), changes: [{ path: 'hello.txt', kind: { type: 'add' }, diff: 'hi\n' }] };
  itemStarted(t, { ...base, status: 'inProgress' });
  const result = await t.request('item/fileChange/requestApproval', {
    ...ids(t),
    itemId: base.id,
    startedAtMs: Date.now(),
    reason: 'Create hello.txt',
  });
  itemCompleted(t, { ...base, status: accepted(result) ? 'completed' : 'declined' });
  if (cancelled(result)) return { status: 'interrupted' };
  return { status: 'completed' };
};

const crash: Scenario = async (t) => {
  const id = itemId();
  itemStarted(t, { type: 'agentMessage', id, text: '' });
  t.notify('item/agentMessage/delta', { ...ids(t), itemId: id, delta: 'About to' });
  await tick();
  return t.crash();
};

const slow: Scenario = async (t) => {
  const id = itemId();
  itemStarted(t, { type: 'agentMessage', id, text: '' });
  t.notify('item/agentMessage/delta', { ...ids(t), itemId: id, delta: 'Thinking' });
  await t.interrupted;
  return { status: 'interrupted' };
};

export const SCENARIOS: Record<string, Scenario> = { simple, recall, approval, file, crash, slow };

/** `FAKE_CODEX_SCENARIO`, else the first word of the prompt; unknown names fall back to `simple`. */
export function pickScenario(prompt: string, env: NodeJS.ProcessEnv = process.env): Scenario {
  const name = env.FAKE_CODEX_SCENARIO || prompt.trim().split(/\s+/)[0] || 'simple';
  return SCENARIOS[name] ?? simple;
}
