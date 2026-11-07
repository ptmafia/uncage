import { describe, expect, it } from 'vitest';
import {
  CONNECTED_PROTOCOL, ERROR_CATALOG, MAX_FRAME_BYTES, ProtocolFrameError, SessionManifestSchema,
  SkillSpecSchema, ToolSpecSchema, parseAgentFrame, parseHubFrame,
} from './index.js';

const err = { code: 'tool_failed', message: 'x', retryable: true };
const agentFrames = [
  { t: 'hello', protocol: 1, agentVersion: '0.2.0', machine: { name: 'mac', os: 'darwin', runtimes: [{ id: 'claude-code', displayName: 'CC', status: 'available' }] } },
  { t: 'result', id: '1', ok: true, data: { a: 1 } },
  { t: 'result', id: '1', ok: false, error: err },
  { t: 'events', sessionId: 's', events: [] },
  { t: 'tool_call', id: '1', sessionId: 's', runId: 'r', tool: 'search_x', args: {} },
  { t: 'file_chunk', id: '1', path: 'a/b.txt', seq: 0, data: 'aGk=', last: true },
  { t: 'file_done', id: '1', files: [{ path: 'a', size: 2 }] },
  { t: 'pong', at: 1 },
];
const hubFrames = [
  { t: 'welcome', machineId: 'm', protocol: 1, minAgentVersion: '0.2.0' },
  { t: 'upgrade_required', minAgentVersion: '0.2.0' },
  { t: 'command', id: '1', op: 'startRun', args: {} },
  { t: 'ack', sessionId: 's', sequence: 3 },
  { t: 'tool_result', id: '1', ok: true, result: { content: [{ type: 'text', text: 'hi' }, { type: 'json', json: [1] }] } },
  { t: 'tool_result', id: '1', ok: false, error: err },
  { t: 'file_pull', id: '1', sessionId: 's', path: 'a', maxBytes: 10 },
  { t: 'ping', at: 1 },
];

describe('connected frames', () => {
  it('has constants', () => {
    expect(CONNECTED_PROTOCOL).toBe(1);
    expect(MAX_FRAME_BYTES).toBe(1_048_576);
  });
  it.each(agentFrames)('agent frame round-trips: $t', (f) => {
    expect(parseAgentFrame(JSON.stringify(f))).toEqual(f);
  });
  it.each(hubFrames)('hub frame round-trips: $t', (f) => {
    expect(parseHubFrame(JSON.stringify(f))).toEqual(f);
  });
  it('rejects unknown t, bad json, wrong direction', () => {
    for (const raw of ['{"t":"nope"}', 'not json', '[]', JSON.stringify(hubFrames[0])]) {
      expect(() => parseAgentFrame(raw)).toThrow(ProtocolFrameError);
    }
    try { parseAgentFrame('{"t":"nope"}'); } catch (e) { expect((e as ProtocolFrameError).code).toBe('invalid_request'); }
    expect(() => parseHubFrame(JSON.stringify(agentFrames[0]))).toThrow(ProtocolFrameError);
  });
  it('rejects unknown command op', () => {
    expect(() => parseHubFrame(JSON.stringify({ t: 'command', id: '1', op: 'rm', args: {} }))).toThrow(ProtocolFrameError);
  });
  it('enforces byte limit before parsing (UTF-8 bytes)', () => {
    const big = JSON.stringify({ t: 'pong', at: 1, pad: 'x'.repeat(MAX_FRAME_BYTES) });
    expect(() => parseAgentFrame(big)).toThrow(/too large/);
    // 3-byte chars: under 1M chars but over 1M bytes
    const multi = '"' + '€'.repeat(400_000) + '"';
    expect(multi.length).toBeLessThan(MAX_FRAME_BYTES);
    expect(() => parseHubFrame(multi)).toThrow(/too large/);
  });
});

describe('tool and skill specs', () => {
  const tool = (name: string) => ({ name, description: 'd', inputSchema: {}, requiresConfirmation: false });
  it('accepts valid tool names, rejects invalid', () => {
    expect(ToolSpecSchema.safeParse(tool('search_orders')).success).toBe(true);
    for (const n of ['Bash', 'mcp__x', 'a b', '1a', '', 'a'.repeat(49)]) {
      expect(ToolSpecSchema.safeParse(tool(n)).success, n).toBe(false);
    }
  });
  it('accepts valid skill names, rejects invalid', () => {
    expect(SkillSpecSchema.safeParse({ name: 'seo-audit', description: 'd', markdown: 'm' }).success).toBe(true);
    for (const n of ['Seo', 'a_b', 'a b', '-a', 'mcp__x']) {
      expect(SkillSpecSchema.safeParse({ name: n, description: 'd', markdown: 'm' }).success, n).toBe(false);
    }
  });
  it('rejects unsafe skill file paths', () => {
    const mk = (path: string) => SkillSpecSchema.safeParse({ name: 'a', description: 'd', markdown: 'm', files: [{ path, content: 'c' }] }).success;
    expect(mk('refs/a.md')).toBe(true);
    for (const p of ['../a', 'a/../b', '/etc/passwd', 'a\\b', 'C:\\x', '', 'a/']) expect(mk(p), p).toBe(false);
  });
  it('manifest parses', () => {
    expect(SessionManifestSchema.parse({ tools: [tool('a')], skills: [] }).tools).toHaveLength(1);
  });
});

describe('new error codes', () => {
  it('have catalog statuses', () => {
    expect(ERROR_CATALOG.machine_offline.status).toBe(409);
    expect(ERROR_CATALOG.machine_not_found.status).toBe(404);
    expect(ERROR_CATALOG.upgrade_required.status).toBe(426);
    expect(ERROR_CATALOG.tool_failed.status).toBe(502);
    expect(ERROR_CATALOG.device_code_expired.status).toBe(410);
  });
});
