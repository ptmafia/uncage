import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ERROR_CATALOG, type ApprovalCategory, type ErrorCode, type RuntimeEvent } from '@uncage/protocol';

/** Deny messages the adapter sends back through `canUseTool`. */
export const DENIED_MESSAGE = 'The user denied this action.';
export const EXPIRED_MESSAGE = 'The approval request expired.';
export const CANCELLED_MESSAGE = 'Run cancelled.';
const OUR_DENY_MESSAGES = [DENIED_MESSAGE, EXPIRED_MESSAGE, CANCELLED_MESSAGE];

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch']);
const AUTH_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed']);

export function categorize(toolName: string): ApprovalCategory {
  if (toolName === 'Bash') return 'shell';
  if (FILE_TOOLS.has(toolName)) return 'file';
  if (NETWORK_TOOLS.has(toolName)) return 'network';
  if (toolName.startsWith('mcp__')) return 'mcp';
  return 'other';
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

function toolTitle(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  if (name === 'Bash') return str(i.command)?.slice(0, 80) ?? name;
  if (name === 'Read' || name === 'Write' || name === 'Edit') return str(i.file_path) ?? name;
  return name;
}

/** tool_result content is a string or an array of content blocks; keep the text parts. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((b: { type?: unknown; text?: unknown }) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
    .join('\n');
}

function runFailed(code: ErrorCode, message: string | undefined): RuntimeEvent {
  const entry = ERROR_CATALOG[code];
  return {
    type: 'run.failed',
    error: {
      code,
      message: message || entry.message,
      hint: code === 'auth_required' ? 'Run `claude` and log in' : entry.hint,
      retryable: entry.retryable,
    },
  };
}

/**
 * Builds a stateful SDKMessage → RuntimeEvent mapper for one run.
 * `denials` holds the deny message the adapter sent per toolUseID, so a
 * user-supplied deny reason is still recognised as a declined tool.
 */
export function createMapper(denials: ReadonlyMap<string, string> = new Map()): (m: SDKMessage) => RuntimeEvent[] {
  let sessionEmitted = false;
  let current: { id: string; text: string } | undefined;
  const seenMessages = new Set<string>();
  const toolStarts = new Map<string, number>();
  let assistantError: string | undefined;

  return (m) => {
    switch (m.type) {
      case 'system': {
        if (m.subtype !== 'init' || sessionEmitted) return [];
        sessionEmitted = true;
        return [{ type: 'native.session', ref: m.session_id }];
      }

      case 'stream_event': {
        // Subagent streams would interleave with the main message; their tool calls still arrive as assistant/user messages.
        if (m.parent_tool_use_id !== null) return [];
        const e = m.event;
        if (e.type === 'message_start') {
          current = { id: e.message.id, text: '' };
          seenMessages.add(e.message.id);
          return [{ type: 'message.started', messageId: e.message.id }];
        }
        if (e.type === 'content_block_delta' && e.delta.type === 'text_delta' && current) {
          current.text += e.delta.text;
          return [{ type: 'message.delta', messageId: current.id, text: e.delta.text }];
        }
        if (e.type === 'message_stop' && current) {
          const { id, text } = current;
          current = undefined;
          return text === '' ? [] : [{ type: 'message.completed', messageId: id, text }];
        }
        return [];
      }

      case 'assistant': {
        if (m.error) assistantError = m.error;
        const out: RuntimeEvent[] = [];
        const id = m.message.id;
        // Synthetic messages (e.g. "Not logged in") are never streamed; surface their text once.
        if (m.parent_tool_use_id === null && !seenMessages.has(id)) {
          seenMessages.add(id);
          const text = m.message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
          if (text !== '') out.push({ type: 'message.started', messageId: id }, { type: 'message.completed', messageId: id, text });
        }
        for (const b of m.message.content) {
          if (b.type !== 'tool_use') continue;
          toolStarts.set(b.id, Date.now());
          out.push({
            type: 'tool.started',
            toolId: b.id,
            name: b.name,
            title: toolTitle(b.name, b.input),
            category: categorize(b.name),
            input: b.input,
          });
        }
        return out;
      }

      case 'user': {
        const content = m.message.content;
        if (typeof content === 'string') return [];
        const out: RuntimeEvent[] = [];
        for (const b of content) {
          if (b.type !== 'tool_result') continue;
          const toolId = b.tool_use_id;
          const output = resultText(b.content);
          const started = toolStarts.get(toolId);
          toolStarts.delete(toolId);
          if (b.is_error) {
            const sent = denials.get(toolId);
            const declined = (sent !== undefined && output.includes(sent)) || OUR_DENY_MESSAGES.some((d) => output.includes(d));
            out.push({ type: 'tool.failed', toolId, error: output, ...(declined ? { declined: true } : {}) });
          } else {
            out.push({
              type: 'tool.completed',
              toolId,
              ...(output !== '' ? { output } : {}),
              ...(started !== undefined ? { durationMs: Date.now() - started } : {}),
            });
          }
        }
        return out;
      }

      case 'result': {
        if (m.subtype === 'success' && !m.is_error) return [{ type: 'run.completed' }];
        const code: ErrorCode = assistantError && AUTH_ERRORS.has(assistantError) ? 'auth_required' : 'internal_error';
        const message = m.subtype === 'success' ? m.result : m.errors.join('; ');
        return [runFailed(code, message)];
      }

      default:
        return [];
    }
  };
}
