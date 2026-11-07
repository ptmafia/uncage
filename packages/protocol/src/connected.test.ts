import { describe, expect, it } from 'vitest';
import {
  CONNECTED_PROTOCOL, ERROR_CATALOG, MAX_FRAME_BYTES, ProtocolFrameError, SessionManifestSchema,
  SkillSpecSchema, ToolSpecSchema, RelativePathSchema, DeviceCodeResponseSchema, parseAgentFrame, parseHubFrame,
  HubCommandArgsSchemas, HubCommandOpSchema, HubCommandResultSchemas, MAX_READ_EVENTS,
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
    for (const n of ['Bash', 'mcp__x', 'foo__bar', 'a b', '1a', '', 'a'.repeat(49)]) {
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
  it('manifest caps tools and skills at 64 each', () => {
    const tools = (n: number) => Array.from({ length: n }, (_, i) => tool(`t${i}`));
    const skills = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `s${i}`, description: 'd', markdown: 'm' }));
    expect(SessionManifestSchema.safeParse({ tools: tools(64), skills: skills(64) }).success).toBe(true);
    expect(SessionManifestSchema.safeParse({ tools: tools(65), skills: [] }).success).toBe(false);
    expect(SessionManifestSchema.safeParse({ tools: [], skills: skills(65) }).success).toBe(false);
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

describe('hardening', () => {
  const rp = (p: string) => RelativePathSchema.safeParse(p).success;
  it('RelativePathSchema', () => {
    expect(rp('a/b.txt')).toBe(true);
    expect(rp('%2e%2e/x')).toBe(true); // literal name; nothing decodes
    for (const p of ['a\0b', 'a:b', 'a\x07', 'a\\b', '/a', 'C:/a', 'a//b', 'a/ /b', 'a/./b', 'a/..', 'a./b', 'a /b',
      'CON', 'a/nul.txt', 'Com1.x', 'lpt9', 'a/'.repeat(300)]) expect(rp(p), JSON.stringify(p)).toBe(false);
  });
  it('skill limits', () => {
    const sk = (files: Array<{ path: string; content: string }>) =>
      SkillSpecSchema.safeParse({ name: 'a', description: 'd', markdown: 'm', files }).success;
    expect(sk([{ path: 'A.md', content: '' }, { path: 'a.md', content: '' }])).toBe(false);
    expect(sk([{ path: 'a.md', content: 'x'.repeat(256 * 1024 + 1) }])).toBe(false);
    expect(SkillSpecSchema.safeParse({ name: 'a', description: 'd'.repeat(1001), markdown: 'm' }).success).toBe(false);
  });
  it('file frame limits', () => {
    const ok = { t: 'file_chunk', id: '1', path: 'a', seq: 0, data: 'aGk=', last: true };
    const bad = (o: object) => expect(() => parseAgentFrame(JSON.stringify({ ...ok, ...o }))).toThrow(ProtocolFrameError);
    bad({ data: '!!!' }); bad({ data: 'A'.repeat(349_532) }); bad({ seq: 100_001 }); bad({ seq: -1 }); bad({ path: '../x' });
    const pull = { t: 'file_pull', id: '1', sessionId: 's', path: 'a', maxBytes: 1 };
    expect(parseHubFrame(JSON.stringify(pull))).toEqual(pull);
    expect(() => parseHubFrame(JSON.stringify({ ...pull, maxBytes: 0 }))).toThrow();
    expect(() => parseHubFrame(JSON.stringify({ ...pull, maxBytes: 50 * 1024 * 1024 + 1 }))).toThrow();
    expect(() => parseAgentFrame(JSON.stringify({ t: 'file_done', id: '1', files: [{ path: 'a', size: 10 * 1024 * 1024 + 1 }] }))).toThrow();
  });
  it('drops forbidden keys at any depth and strips extras', () => {
    const f = parseAgentFrame('{"t":"result","id":"1","ok":true,"data":{"__proto__":{"x":1},"a":{"constructor":1,"prototype":2,"b":3}},"extra":1}');
    expect(f).toEqual({ t: 'result', id: '1', ok: true, data: { a: { b: 3 } } });
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
  it('rejects deep nesting, accepts 64', () => {
    const nest = (n: number) => '['.repeat(n) + ']'.repeat(n);
    expect(() => parseAgentFrame(`{"t":"result","id":"1","ok":true,"data":${nest(70)}}`)).toThrow(/deeply/);
    expect(parseAgentFrame(`{"t":"result","id":"1","ok":true,"data":${nest(60)}}`).t).toBe('result');
  });
  it('truncates echoed input', () => {
    try { parseAgentFrame(JSON.stringify({ t: 'x'.repeat(500) })); } catch (e) { expect((e as Error).message.length).toBeLessThan(250); }
  });
  it('device code and misc', () => {
    const dc = { deviceCode: 'd', userCode: 'ABCD-EFGH', verificationUri: 'https://x.io/c', intervalSec: 5, expiresInSec: 600 };
    expect(DeviceCodeResponseSchema.safeParse(dc).success).toBe(true);
    expect(DeviceCodeResponseSchema.safeParse({ ...dc, verificationUri: 'javascript:alert(1)' }).success).toBe(false);
    expect(DeviceCodeResponseSchema.safeParse({ ...dc, userCode: 'abcd-efgh' }).success).toBe(false);
    expect(() => parseAgentFrame(JSON.stringify({ ...agentFrames[0], protocol: 0 }))).toThrow();
    expect(ToolSpecSchema.safeParse({ name: 'a', description: 'd', inputSchema: { x: 'y'.repeat(70_000) }, requiresConfirmation: false }).success).toBe(false);
  });
});

describe('hub command args / results', () => {
  it('covers every op', () => {
    expect(Object.keys(HubCommandArgsSchemas).sort()).toEqual([...HubCommandOpSchema.options].sort());
    expect(Object.keys(HubCommandResultSchemas).sort()).toEqual([...HubCommandOpSchema.options].sort());
  });

  it('validates args', () => {
    expect(HubCommandArgsSchemas.createSession.safeParse({ runtime: 'claude-code' }).success).toBe(true);
    expect(HubCommandArgsSchemas.createSession.safeParse({ runtime: '' }).success).toBe(false);
    const startRun = { sessionId: 's', prompt: 'p', idempotencyKey: 'k', manifest: { tools: [], skills: [] } };
    expect(HubCommandArgsSchemas.startRun.safeParse(startRun).success).toBe(true);
    expect(HubCommandArgsSchemas.startRun.safeParse({ ...startRun, idempotencyKey: '' }).success).toBe(false);
    expect(HubCommandArgsSchemas.startRun.safeParse({ ...startRun, manifest: { tools: [{ name: 'Bash' }], skills: [] } }).success).toBe(false);
    expect(HubCommandArgsSchemas.readEvents.safeParse({ sessionId: 's', after: 0, limit: MAX_READ_EVENTS + 1 }).success).toBe(false);
    expect(HubCommandArgsSchemas.addAttachment.safeParse({ sessionId: 's', name: 'a', mime: 'text/plain', data: 'not base64!' }).success).toBe(false);
    expect(HubCommandArgsSchemas.updateSettings.safeParse({ sessionId: 's', patch: {} }).success).toBe(false);
  });
});
