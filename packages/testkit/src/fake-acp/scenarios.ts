/**
 * A scripted ACP agent for tests, built on the official SDK's `agent()` app (stable ACP v1).
 * `server.ts` connects it to process stdio; tests may also connect it in-process.
 *
 * The scenario is picked by the first word of the prompt text:
 *   simple   one streamed message
 *   tools    a dropped thought, a message, an `execute` tool call with output, a plan, a usage update, a message
 *   approval an `edit` tool call that asks `session/request_permission`; allow → completed, reject → failed
 *   slow     50 chunks, 100 ms apart; honours `session/cancel` (stop reason `cancelled`) unless ignoreCancel
 *   crash    one chunk, then the process exits with code 1
 *   remember "remember <x>" stores x in the session; "recall" answers "remembered <x>"
 *   refusal  one chunk, then stop reason `refusal`
 *   anything else is echoed back as "echo: <prompt>"
 */
import {
  agent,
  methods,
  PROTOCOL_VERSION,
  RequestError,
  type AgentApp,
  type AgentCapabilities,
  type AgentContext,
  type ContentBlock,
  type RequestPermissionResponse,
  type SessionUpdate,
  type StopReason,
} from '@agentclientprotocol/sdk';

export interface FakeAcpOptions {
  /** `agentCapabilities` returned by `initialize`. Defaults to `{ loadSession: true }`. */
  caps?: AgentCapabilities;
  /** `protocolVersion` returned by `initialize`. Defaults to the SDK's (1). */
  protocolVersion?: number;
  /** Ignore `session/cancel` (the turn keeps running). */
  ignoreCancel?: boolean;
  /** `session/new` fails with -32000 (auth required). */
  authRequired?: boolean;
  /** Called by the `crash` scenario; must not return. */
  crash(): never;
}

export const FAKE_ACP_VERSION = '1.0.0';
export const FAKE_ACP_AUTH_METHODS = [{ id: 'fake-login', name: 'Fake login', description: 'Run `fake-acp login`.' }];

interface Turn {
  user: string;
  agent: string;
}

interface FakeSession {
  id: string;
  cwd: string;
  history: Turn[];
  memory?: string;
  cancel?: () => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function promptText(prompt: ContentBlock[]): string {
  return prompt.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
}

/** A text chunk in the shape of `agent_message_chunk` content. */
const text = (t: string): ContentBlock => ({ type: 'text', text: t });

export function createFakeAcpAgent(o: FakeAcpOptions): AgentApp {
  const sessions = new Map<string, FakeSession>();
  let seq = 0;

  const getSession = (id: string): FakeSession => {
    const s = sessions.get(id);
    if (!s) throw RequestError.resourceNotFound(id);
    return s;
  };

  async function runTurn(client: AgentContext, s: FakeSession, prompt: ContentBlock[]): Promise<StopReason> {
    const send = (update: SessionUpdate): Promise<void> =>
      client.notify(methods.client.session.update, { sessionId: s.id, update });
    let reply = '';
    const say = async (t: string, messageId?: string): Promise<void> => {
      reply += t;
      await send({ sessionUpdate: 'agent_message_chunk', content: text(t), ...(messageId ? { messageId } : {}) });
    };
    let cancelled = false;
    let onCancel!: () => void;
    const cancelledPromise = new Promise<void>((r) => (onCancel = r));
    s.cancel = () => {
      if (o.ignoreCancel) return;
      cancelled = true;
      onCancel();
    };

    const input = promptText(prompt);
    const [word = '', ...rest] = input.trim().split(/\s+/);
    const attachments = prompt.filter((b) => b.type !== 'text');
    let stop: StopReason = 'end_turn';
    switch (word) {
      case 'simple':
        await say('Hello');
        await say(' from fake ACP');
        break;
      case 'tools':
        await send({ sessionUpdate: 'agent_thought_chunk', content: text('Let me think about the tests.') });
        await say('Running tests.', 'msg_a');
        await send({
          sessionUpdate: 'tool_call',
          toolCallId: 'call_1',
          title: 'npm test',
          kind: 'execute',
          status: 'pending',
          rawInput: { command: 'npm test' },
        });
        await send({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call_1',
          status: 'in_progress',
          content: [{ type: 'content', content: text('4 passed') }],
        });
        await send({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed' });
        await send({
          sessionUpdate: 'plan',
          entries: [
            { content: 'read', priority: 'high', status: 'completed' },
            { content: 'write', priority: 'medium', status: 'pending' },
          ],
        });
        await send({ sessionUpdate: 'usage_update', used: 1200, size: 200000 });
        await say('All tests pass.', 'msg_b');
        break;
      case 'approval': {
        const path = `${s.cwd}/hello.txt`;
        const toolCall = {
          toolCallId: 'call_ap',
          title: 'Write hello.txt',
          kind: 'edit' as const,
          status: 'pending' as const,
          rawInput: { path, content: 'hello' },
          locations: [{ path }],
        };
        await send({ sessionUpdate: 'tool_call', ...toolCall });
        const asked: Promise<RequestPermissionResponse> = client.request(methods.client.session.requestPermission, {
          sessionId: s.id,
          toolCall: { toolCallId: toolCall.toolCallId, title: toolCall.title, kind: toolCall.kind, rawInput: toolCall.rawInput, locations: toolCall.locations },
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
            { optionId: 'never', name: 'Always reject', kind: 'reject_always' },
          ],
        });
        const answer = await Promise.race([asked, cancelledPromise.then(() => undefined)]);
        if (cancelled || !answer || answer.outcome.outcome === 'cancelled') {
          stop = 'cancelled';
          break;
        }
        const allowed = answer.outcome.optionId === 'allow' || answer.outcome.optionId === 'always';
        await send({
          sessionUpdate: 'tool_call_update',
          toolCallId: toolCall.toolCallId,
          status: allowed ? 'completed' : 'failed',
          content: [{ type: 'content', content: text(allowed ? 'wrote hello.txt' : 'Permission denied') }],
        });
        await say(allowed ? 'Done.' : 'Okay, I will not write it.');
        break;
      }
      case 'slow':
        for (let i = 0; i < 50; i++) {
          if (cancelled) break;
          await say(`chunk ${i} `);
          await Promise.race([sleep(100), cancelledPromise]);
        }
        if (cancelled) stop = 'cancelled';
        break;
      case 'crash':
        await say('about to crash');
        await sleep(20);
        o.crash();
        break;
      case 'remember':
        s.memory = rest.join(' ');
        await say('Noted.');
        break;
      case 'recall':
        await say(`remembered ${s.memory ?? 'nothing'}`);
        break;
      case 'refusal':
        await say('I cannot help with that.');
        stop = 'refusal';
        break;
      default: {
        const names = attachments.map((b) => (b.type === 'resource_link' ? b.uri : b.type === 'image' ? `image:${b.mimeType}` : b.type));
        await say(`echo: ${input}${names.length ? ` [${names.join(', ')}]` : ''}`);
      }
    }
    s.cancel = undefined;
    s.history.push({ user: input, agent: reply });
    return stop;
  }

  return agent({ name: 'fake-acp' })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: o.protocolVersion ?? PROTOCOL_VERSION,
      agentCapabilities: o.caps ?? { loadSession: true },
      authMethods: FAKE_ACP_AUTH_METHODS,
      agentInfo: { name: 'fake-acp', version: FAKE_ACP_VERSION },
    }))
    .onRequest(methods.agent.authenticate, () => ({}))
    .onRequest(methods.agent.session.new, ({ params }) => {
      if (o.authRequired) throw RequestError.authRequired(undefined, 'Log in first');
      const s: FakeSession = { id: `sess_${++seq}`, cwd: params.cwd, history: [] };
      sessions.set(s.id, s);
      return { sessionId: s.id };
    })
    .onRequest(methods.agent.session.load, async ({ params, client }) => {
      const s = getSession(params.sessionId);
      s.cwd = params.cwd;
      // Replay the conversation before answering, as the protocol requires.
      for (const turn of s.history) {
        await client.notify(methods.client.session.update, {
          sessionId: s.id,
          update: { sessionUpdate: 'user_message_chunk', content: text(turn.user) },
        });
        await client.notify(methods.client.session.update, {
          sessionId: s.id,
          update: { sessionUpdate: 'agent_message_chunk', content: text(turn.agent) },
        });
      }
      return {};
    })
    .onRequest(methods.agent.session.resume, ({ params }) => {
      getSession(params.sessionId).cwd = params.cwd;
      return {};
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
      const stopReason = await runTurn(client, getSession(params.sessionId), params.prompt);
      return { stopReason };
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      sessions.get(params.sessionId)?.cancel?.();
    });
}
