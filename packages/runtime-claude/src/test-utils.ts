import type { Options, PermissionResult, Query, SDKMessage, query } from '@anthropic-ai/claude-agent-sdk';
import authError from './fixtures/auth-error.json' with { type: 'json' };
import resumeMissing from './fixtures/resume-missing.json' with { type: 'json' };
import text from './fixtures/text.json' with { type: 'json' };
import toolWrite from './fixtures/tool-write.json' with { type: 'json' };

export const fixture = (json: unknown): SDKMessage[] => json as SDKMessage[];

export const FIXTURES = {
  text: fixture(text),
  toolWrite: fixture(toolWrite),
  authError: fixture(authError),
  /** Real SDK 0.3.318 output for `resume` pointing at a session Claude Code doesn't have. */
  resumeMissing: fixture(resumeMissing),
};

/** What the SDK throws right after the resumeMissing result message. */
export const RESUME_MISSING_ERROR =
  'Claude Code returned an error result: No conversation found with session ID: 00000000-0000-0000-0000-000000000000';

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/** Real CLI behaviour: a denied tool's tool_result carries the deny message as an error. */
function deniedResult(source: SDKMessage, message: string): SDKMessage {
  if (source.type !== 'user') return source;
  const content = source.message.content as ToolResultBlock[];
  return {
    ...source,
    message: { ...source.message, content: content.map((b) => ({ ...b, content: message, is_error: true })) },
  } as SDKMessage;
}

export interface ScriptedCall {
  prompt: string;
  options: Options;
  interrupted: boolean;
  permission?: PermissionResult;
}

/**
 * A stand-in for the SDK's `query()` that replays fixtures. The `approval`
 * prompt calls `canUseTool` for the Write tool_use before replaying its result,
 * the way the CLI asks for permission between the tool_use and tool_result.
 */
export function scriptedQuery(): { query: typeof query; calls: ScriptedCall[] } {
  const calls: ScriptedCall[] = [];

  const fn = ((params: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
    const options = params.options ?? {};
    const call: ScriptedCall = { prompt: String(params.prompt), options, interrupted: false };
    calls.push(call);
    const signal = options.abortController?.signal;

    async function* replay(): AsyncGenerator<SDKMessage, void> {
      const aborted = (): boolean => call.interrupted || signal?.aborted === true;
      if (call.prompt === 'crash') {
        for (const m of FIXTURES.text.slice(0, 6)) yield m; // init, then the start of a streamed message
        throw new Error('process exited');
      }
      if (call.prompt === 'linger') {
        // Delivers the result, then never exits until killed.
        for (const m of FIXTURES.text) yield m;
        await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
        return;
      }
      if (call.prompt === 'resume-missing') {
        for (const m of FIXTURES.resumeMissing) yield m;
        throw new Error(RESUME_MISSING_ERROR);
      }
      if (call.prompt === 'resume-missing-throw') throw new Error(RESUME_MISSING_ERROR);
      if (call.prompt === 'auth') {
        for (const m of FIXTURES.authError) yield m;
        return;
      }
      const script = call.prompt === 'approval' ? FIXTURES.toolWrite : FIXTURES.text;
      for (const m of script) {
        if (aborted()) return;
        if (m.type === 'user' && call.prompt === 'approval') {
          const toolUse = script.find((x) => x.type === 'assistant')!;
          if (toolUse.type !== 'assistant') throw new Error('fixture');
          const block = toolUse.message.content[0] as { id: string; name: string; input: Record<string, unknown> };
          const permission = await options.canUseTool!(block.name, block.input, {
            signal: signal ?? new AbortController().signal,
            toolUseID: block.id,
            requestId: 'req_1',
            title: 'Claude wants to write hello.txt',
          });
          if (!permission) throw new Error('canUseTool must decide');
          call.permission = permission;
          if (permission.behavior === 'deny') {
            yield deniedResult(m, permission.message);
            if (permission.interrupt) return;
            continue;
          }
        }
        yield m;
      }
    }

    const gen = replay();
    return Object.assign(gen, {
      interrupt: async () => {
        call.interrupted = true;
        return undefined;
      },
    }) as unknown as Query;
  }) as typeof query;

  return { query: fn, calls };
}
