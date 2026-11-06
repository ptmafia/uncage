#!/usr/bin/env node
/**
 * A fake `codex app-server` for tests: JSONL over stdio, JSON-RPC shapes without the "jsonrpc" field.
 * Speaks the subset in packages/runtime-codex/src/protocol.ts. Env:
 *   FAKE_CODEX_SCENARIO  force a scenario (else the first word of the turn text picks it)
 *   FAKE_CODEX_AUTH=none `account/read` reports no account
 *   FAKE_CODEX_TRACE     append every received line to this file (lets tests inspect the client's wire output,
 *                       including turn/start's model, effort, approvalPolicy, sandboxPolicy and localImage inputs)
 */
import { appendFileSync } from 'node:fs';
import { pickScenario, type TurnApi, type TurnOutcome } from './scenarios.js';

type Id = number | string;
type Message = { id?: Id; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };

interface Thread {
  id: string;
  cwd: string;
  history: string[];
  /** Interrupts the active turn, if any. */
  interrupt?: (turnId: string) => boolean;
}

const send = (m: Message): void => void process.stdout.write(`${JSON.stringify(m)}\n`);
const notify = (method: string, params: Record<string, unknown>): void => send({ method, params });

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const threads = new Map<string, Thread>();
const waiting = new Map<Id, (result: unknown) => void>();
let initialized = false;
let seq = 0;
let serverRequestSeq = 0;

function request(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = `srv_${++serverRequestSeq}`;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    send({ id, method, params });
  });
}

const threadJson = (t: Thread) => ({ id: t.id, cwd: t.cwd, preview: '', turns: [] });
const threadResult = (t: Thread) => ({
  thread: threadJson(t),
  model: 'fake-model',
  modelProvider: 'fake',
  serviceTier: null,
  cwd: t.cwd,
  approvalPolicy: 'on-request',
  sandbox: { type: 'workspaceWrite' },
  reasoningEffort: null,
});
const turnJson = (id: string, status: string, error: { message: string } | null = null) => ({
  id,
  items: [],
  status,
  error: error && { message: error.message, codexErrorInfo: null, additionalDetails: null },
});

function getThread(params: Record<string, unknown>): Thread {
  const thread = threads.get(String(params.threadId));
  if (!thread) throw new RpcError(-32600, `thread not found: ${String(params.threadId)}`);
  return thread;
}

function startTurn(thread: Thread, prompt: string): { turn: ReturnType<typeof turnJson> } {
  const turnId = `turn_${++seq}`;
  let interrupted = false;
  let onInterrupt!: () => void;
  const interruptedPromise = new Promise<void>((r) => (onInterrupt = r));
  thread.interrupt = (id) => {
    if (id !== turnId || interrupted) return false;
    interrupted = true;
    onInterrupt();
    return true;
  };
  const api: TurnApi = {
    threadId: thread.id,
    turnId,
    cwd: thread.cwd,
    prompt,
    history: [...thread.history],
    notify,
    request,
    interrupted: interruptedPromise,
    isInterrupted: () => interrupted,
    crash: () => process.exit(1),
  };
  thread.history.push(prompt);
  const scenario = pickScenario(prompt);
  setImmediate(() => {
    notify('turn/started', { threadId: thread.id, turn: turnJson(turnId, 'inProgress') });
    void scenario(api)
      .catch((err: unknown): TurnOutcome => ({ status: 'failed', message: String(err) }))
      .then((outcome) => {
        thread.interrupt = undefined;
        const status = interrupted ? 'interrupted' : outcome.status;
        const error = outcome.status === 'failed' ? { message: outcome.message } : null;
        notify('turn/completed', { threadId: thread.id, turn: turnJson(turnId, status, error) });
      });
  });
  return { turn: turnJson(turnId, 'inProgress') };
}

function handle(method: string, params: Record<string, unknown>): unknown {
  if (method === 'initialize') {
    initialized = true;
    return { userAgent: 'fake-codex/0.0.0', codexHome: '/tmp/fake-codex', platformFamily: 'unix', platformOs: 'macos' };
  }
  if (!initialized) throw new RpcError(-32600, 'Not initialized');
  switch (method) {
    case 'account/read':
      return process.env.FAKE_CODEX_AUTH === 'none'
        ? { account: null, requiresOpenaiAuth: true }
        : { account: { type: 'chatgpt', email: 'fake@example.com', planType: 'plus', workspaceName: null }, requiresOpenaiAuth: true };
    case 'thread/start': {
      const thread: Thread = { id: `thr_${++seq}`, cwd: String(params.cwd ?? process.cwd()), history: [] };
      threads.set(thread.id, thread);
      notify('thread/started', { thread: threadJson(thread) });
      return threadResult(thread);
    }
    case 'thread/resume': {
      const thread = getThread(params);
      if (typeof params.cwd === 'string') thread.cwd = params.cwd;
      return threadResult(thread);
    }
    case 'model/list':
      return {
        data: [
          { id: 'fake-model', model: 'fake-model', displayName: 'Fake Model', description: 'The fake default', hidden: false, isDefault: true },
          { id: 'fake-hidden', model: 'fake-hidden', displayName: 'Hidden', description: '', hidden: true, isDefault: false },
        ],
        nextCursor: null,
      };
    case 'turn/start': {
      const thread = getThread(params);
      const input = (params.input ?? []) as Array<{ type?: string; text?: string }>;
      const prompt = input.flatMap((i) => (i.type === 'text' && typeof i.text === 'string' ? [i.text] : [])).join('\n');
      return startTurn(thread, prompt);
    }
    case 'turn/interrupt': {
      getThread(params).interrupt?.(String(params.turnId));
      return {};
    }
    default:
      throw new RpcError(-32601, `method not found: ${method}`);
  }
}

function dispatch(m: Message): void {
  if (m.method === undefined) {
    // A response to one of our requests.
    const resolve = m.id === undefined ? undefined : waiting.get(m.id);
    if (resolve && m.id !== undefined) {
      waiting.delete(m.id);
      resolve(m.result);
    }
    return;
  }
  if (m.id === undefined) return; // Notifications (`initialized`) need no answer.
  try {
    send({ id: m.id, result: handle(m.method, m.params ?? {}) });
  } catch (err) {
    const code = err instanceof RpcError ? err.code : -32603;
    send({ id: m.id, error: { code, message: err instanceof Error ? err.message : String(err) } });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line === '') continue;
    if (process.env.FAKE_CODEX_TRACE) appendFileSync(process.env.FAKE_CODEX_TRACE, `${line}\n`);
    dispatch(JSON.parse(line) as Message);
  }
});
process.stdin.on('end', () => process.exit(0));
