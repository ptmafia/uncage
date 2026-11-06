import { describe, expect, it } from 'vitest';
import { UncageEventSchema, formatEventId, newId, parseEventId } from './index.js';

const base = {
  eventId: 'evt_0000000001',
  sequence: 1,
  sessionId: 'ses_1',
  runId: 'run_1',
  type: 'message.delta',
  occurredAt: '2026-11-06T00:00:00.000Z',
  schemaVersion: '1.0',
};

describe('UncageEventSchema', () => {
  it('accepts a valid message.delta envelope', () => {
    const parsed = UncageEventSchema.parse({
      ...base,
      payload: { messageId: 'msg_1', chunkIndex: 0, text: 'hi' },
    });
    expect(parsed.type).toBe('message.delta');
  });

  it('rejects a message.delta payload without chunkIndex', () => {
    const result = UncageEventSchema.safeParse({
      ...base,
      payload: { messageId: 'msg_1', text: 'hi' },
    });
    expect(result.success).toBe(false);
  });

  it('passes unknown extensions keys through', () => {
    const parsed = UncageEventSchema.parse({
      ...base,
      payload: { messageId: 'msg_1', chunkIndex: 0, text: 'hi' },
      extensions: { 'x-vendor': { a: 1 } },
    });
    expect(parsed.extensions).toEqual({ 'x-vendor': { a: 1 } });
  });
});

describe('event ids', () => {
  it('formats and parses event ids', () => {
    expect(formatEventId(123)).toBe('evt_0000000123');
    expect(parseEventId('evt_0000000123')).toBe(123);
    expect(parseEventId('x')).toBeNull();
  });

  it('generates prefixed ids', () => {
    expect(newId('ses')).toMatch(/^ses_[0-9a-f]{32}$/);
  });
});
