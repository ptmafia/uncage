/**
 * A scripted ACP agent for tests, built on the official SDK's `agent()` app (stable ACP v1).
 * `server.ts` connects it to process stdio; tests may also connect it in-process.
 *
 * The scenario is picked by the first word of the prompt text:
 *   simple   one streamed message
 *   tools    a dropped thought, a message, an `execute` tool call with output, a plan, a usage update, a message
 *   approval an `execute` tool call (`npm test`) that asks `session/request_permission`; allow → completed, reject → failed
 *   edit     the same for an `edit` tool call writing `<cwd>/hello.txt`
 *   site-tool connects to the session's `site` MCP server (http or stdio), notes the listed tools, then for
 *            each listed tool (or the tools named after the word): a `mcp__site__<n>` tool call, a permission
 *            request, and on allow a `tools/call` with `{ text: 'hi' }`
 *   modes    answers "mode: <current mode id>" (see `modes` / `session/set_mode`)
 *   slow     50 chunks, 100 ms apart; honours `session/cancel` (stop reason `cancelled`) unless ignoreCancel
 *   crash    one chunk, then the process exits with code 1 (with writeRaw: the chunk and the exit in one tick)
 *   burst    one chunk, then (with writeRaw) two more chunks and the session/prompt result in a single
 *            stdout write, so the client reads the result right behind the last updates
 *   remember "remember <x>" stores x in the session; "recall" answers "remembered <x>"
 *   refusal  one chunk, then stop reason `refusal`
 *   anything else is echoed back as "echo: <prompt>"
 * A leading text block starting with `<uncage-skills>` (the skills preamble) is ignored for picking the scenario.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  agent,
  methods,
  PROTOCOL_VERSION,
  RequestError,
  type AgentApp,
  type AgentCapabilities,
  type AgentContext,
  type ContentBlock,
  type McpServer,
  type PermissionOption,
  type RequestPermissionResponse,
  type SessionUpdate,
  type StopReason,
  type ToolCallUpdate,
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
  /**
   * Writes raw JSON-RPC messages to the client in one synchronous write (bypassing the SDK's writer).
   * Used by `burst` and `crash` to put messages back to back on the wire; without it they fall back
   * to un-awaited SDK notifications.
   */
  writeRaw?(messages: object[]): void;
  /** Session mode ids offered by `session/new` / `load` / `resume` (current: the first). None by default. */
  modes?: string[];
  /** Records an observation (e.g. the tools listed by `site-tool`); the server appends it to the record file. */
  note?(entry: object): void;
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
  mcpServers: McpServer[];
  mode?: string;
  memory?: string;
  cancel?: () => void;
}

/** Every option kind, so tests can check that Uncage never picks an `*_always` one. */
export const FAKE_ACP_PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
  { optionId: 'reject-always', name: 'Always reject', kind: 'reject_always' },
];

const SKILLS_PREAMBLE = '<uncage-skills>';

/** An MCP client for the session's `site` server, over whichever transport it was declared with. */
async function connectSite(s: FakeSession): Promise<Client> {
  const decl = s.mcpServers.find((m) => m.name === 'site');
  if (!decl) throw new Error('no site MCP server');
  const mcp = new Client({ name: 'fake-acp', version: FAKE_ACP_VERSION });
  if ('type' in decl && decl.type === 'http') {
    const headers = Object.fromEntries(decl.headers.map((h) => [h.name, h.value]));
    await mcp.connect(new StreamableHTTPClientTransport(new URL(decl.url), { requestInit: { headers } }));
  } else if (!('type' in decl)) {
    const env = { ...getDefaultEnvironment(), ...Object.fromEntries(decl.env.map((e) => [e.name, e.value])) };
    await mcp.connect(new StdioClientTransport({ command: decl.command, args: decl.args, env, stderr: 'ignore' }));
  } else {
    throw new Error(`unsupported MCP transport ${decl.type}`);
  }
  return mcp;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function promptText(prompt: ContentBlock[]): string {
  return prompt.flatMap((b) => (b.type === 'text' && !b.text.startsWith(SKILLS_PREAMBLE) ? [b.text] : [])).join('\n');
}

/** A complete `session/update` notification carrying an `agent_message_chunk`, for writeRaw. */
const rawUpdate = (sessionId: string, t: string): object => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } } },
});

/** A text chunk in the shape of `agent_message_chunk` content. */
const text = (t: string): ContentBlock => ({ type: 'text', text: t });

export function createFakeAcpAgent(o: FakeAcpOptions): AgentApp {
  const sessions = new Map<string, FakeSession>();
  let seq = 0;

  const modeState = (s: FakeSession) =>
    o.modes?.length ? { modes: { currentModeId: s.mode ?? o.modes[0]!, availableModes: o.modes.map((id) => ({ id, name: id })) } } : {};

  const getSession = (id: string): FakeSession => {
    const s = sessions.get(id);
    if (!s) throw RequestError.resourceNotFound(id);
    return s;
  };

  /** `detached`: the prompt result was already written raw; the SDK handler must not answer. */
  async function runTurn(client: AgentContext, s: FakeSession, prompt: ContentBlock[], requestId: unknown): Promise<StopReason | 'detached'> {
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

    /** `session/request_permission` with every option kind; resolves to what the client chose. */
    const ask = async (toolCall: ToolCallUpdate): Promise<'allow' | 'reject' | 'cancelled'> => {
      const asked: Promise<RequestPermissionResponse> = client.request(methods.client.session.requestPermission, {
        sessionId: s.id,
        toolCall,
        options: FAKE_ACP_PERMISSION_OPTIONS,
      });
      const answer = await Promise.race([asked, cancelledPromise.then(() => undefined)]);
      if (cancelled || !answer || answer.outcome.outcome === 'cancelled') return 'cancelled';
      return answer.outcome.optionId.startsWith('allow') ? 'allow' : 'reject';
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
      case 'approval':
      case 'edit': {
        const path = `${s.cwd}/hello.txt`;
        const toolCall =
          word === 'approval'
            ? { toolCallId: 'call_ap', title: 'npm test', kind: 'execute' as const, rawInput: { command: 'npm test' } }
            : { toolCallId: 'call_edit', title: 'Write hello.txt', kind: 'edit' as const, rawInput: { path, content: 'hello' }, locations: [{ path }] };
        await send({ sessionUpdate: 'tool_call', status: 'pending', ...toolCall });
        const answer = await ask(toolCall);
        if (answer === 'cancelled') {
          stop = 'cancelled';
          break;
        }
        const allowed = answer === 'allow';
        const done = word === 'approval' ? '4 passed' : 'wrote hello.txt';
        await send({
          sessionUpdate: 'tool_call_update',
          toolCallId: toolCall.toolCallId,
          status: allowed ? 'completed' : 'failed',
          content: [{ type: 'content', content: text(allowed ? done : 'Permission denied') }],
        });
        await say(allowed ? 'Done.' : 'Okay, I will not do it.');
        break;
      }
      case 'site-tool': {
        const mcp = await connectSite(s);
        try {
          const listed = (await mcp.listTools()).tools.map((t) => t.name).sort();
          o.note?.({ fake: 'mcp', listedTools: listed });
          const names = rest.length ? rest : listed;
          for (const n of names) {
            const toolCall = { toolCallId: `call_site_${n}`, title: `mcp__site__${n}`, kind: 'other' as const, rawInput: { text: 'hi' } };
            await send({ sessionUpdate: 'tool_call', status: 'pending', ...toolCall });
            const answer = await ask(toolCall);
            if (answer === 'cancelled') {
              stop = 'cancelled';
              break;
            }
            if (answer === 'reject') {
              await send({ sessionUpdate: 'tool_call_update', toolCallId: toolCall.toolCallId, status: 'failed' });
              continue;
            }
            const r = (await mcp.callTool({ name: n, arguments: { text: 'hi' } })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
            const out = (r.content ?? []).map((c) => c.text ?? '').join('\n');
            o.note?.({ fake: 'mcp-call', name: n, isError: r.isError === true, text: out });
            await send({
              sessionUpdate: 'tool_call_update',
              toolCallId: toolCall.toolCallId,
              status: r.isError ? 'failed' : 'completed',
              content: [{ type: 'content', content: text(out) }],
            });
          }
        } finally {
          await mcp.close().catch(() => undefined);
        }
        if (stop !== 'cancelled') await say('Site tools done.');
        break;
      }
      case 'modes':
        await say(`mode: ${s.mode ?? 'none'}`);
        break;
      case 'slow':
        for (let i = 0; i < 50; i++) {
          if (cancelled) break;
          await say(`chunk ${i} `);
          await Promise.race([sleep(100), cancelledPromise]);
        }
        if (cancelled) stop = 'cancelled';
        break;
      case 'crash':
        if (o.writeRaw) {
          o.writeRaw([rawUpdate(s.id, 'about to crash')]);
          o.crash();
        }
        await say('about to crash');
        await sleep(20);
        o.crash();
        break;
      case 'burst': {
        await say('one ');
        if (!o.writeRaw) {
          void say('two ');
          void say('three');
          break;
        }
        // Let the SDK's own writes drain so the raw write cannot interleave with them.
        await sleep(20);
        o.writeRaw([rawUpdate(s.id, 'two '), rawUpdate(s.id, 'three'), { jsonrpc: '2.0', id: requestId, result: { stopReason: 'end_turn' } }]);
        s.history.push({ user: input, agent: 'one two three' });
        s.cancel = undefined;
        return 'detached';
      }
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
      const s: FakeSession = { id: `sess_${++seq}`, cwd: params.cwd, history: [], mcpServers: params.mcpServers, mode: o.modes?.[0] };
      sessions.set(s.id, s);
      return { sessionId: s.id, ...modeState(s) };
    })
    .onRequest(methods.agent.session.load, async ({ params, client }) => {
      const s = getSession(params.sessionId);
      s.cwd = params.cwd;
      s.mcpServers = params.mcpServers;
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
      return modeState(s);
    })
    .onRequest(methods.agent.session.resume, ({ params }) => {
      const s = getSession(params.sessionId);
      s.cwd = params.cwd;
      s.mcpServers = params.mcpServers ?? [];
      return modeState(s);
    })
    .onRequest(methods.agent.session.setMode, ({ params }) => {
      const s = getSession(params.sessionId);
      if (!o.modes?.includes(params.modeId)) throw RequestError.invalidParams(undefined, `unknown mode ${params.modeId}`);
      s.mode = params.modeId;
      return {};
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client, requestId }) => {
      const stopReason = await runTurn(client, getSession(params.sessionId), params.prompt, requestId);
      // Already answered on the wire: never answer again.
      if (stopReason === 'detached') return new Promise<never>(() => undefined);
      return { stopReason };
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      sessions.get(params.sessionId)?.cancel?.();
    });
}
