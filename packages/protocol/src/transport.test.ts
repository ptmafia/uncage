import { describe, expect, it } from 'vitest';
import {
  HTTP_STREAM_CONTENT_TYPE, HttpConnectResponseSchema, HttpEventsResponseSchema, MAX_HTTP_BODY_BYTES, ProtocolFrameError,
  UPSTREAM_ID, UpstreamMessageSchema, parseHttpEventsRequest, parseStreamLine,
} from './index.js';

const linkId = 'lnk_' + '0'.repeat(24);
const upId = 'up_' + 'a'.repeat(22);
const hello = { t: 'hello', protocol: 2, agentVersion: '0.3.0', transport: 'http', machine: { name: 'mac', os: 'darwin', runtimes: [] } };

describe('http transport wire', () => {
  it('has constants', () => {
    expect(MAX_HTTP_BODY_BYTES).toBe(1_048_576);
    expect(HTTP_STREAM_CONTENT_TYPE).toBe('application/x-ndjson; charset=utf-8');
    expect(UPSTREAM_ID.test(upId)).toBe(true);
    expect(UPSTREAM_ID.test('up_short')).toBe(false);
    expect(UPSTREAM_ID.test('xx_' + 'a'.repeat(22))).toBe(false);
  });
  it('accepts a full events batch and rejects a body over MAX_HTTP_BODY_BYTES', () => {
    expect(parseHttpEventsRequest(JSON.stringify({ linkId, busy: false, msgs: [{ id: upId, msg: { t: 'events', sessionId: 's', events: [] } }] })).msgs).toHaveLength(1);
    expect(() => parseHttpEventsRequest('x'.repeat(1_048_577))).toThrow(ProtocolFrameError);
    expect(() => parseHttpEventsRequest('x'.repeat(1_048_577))).toThrow(/too large/);
  });
  it('accepts an optional ack and rejects bad shapes, bad JSON and deep nesting', () => {
    expect(parseHttpEventsRequest(JSON.stringify({ linkId, ack: 7, busy: true, msgs: [] })).ack).toBe(7);
    for (const raw of [
      'not json',
      JSON.stringify({ linkId, busy: false }),
      JSON.stringify({ linkId: 'lnk_x', busy: false, msgs: [] }),
      JSON.stringify({ linkId, ack: -1, busy: false, msgs: [] }),
      JSON.stringify({ linkId, busy: false, msgs: [{ id: 'bad', msg: { t: 'pong', at: 1 } }] }),
      JSON.stringify({ linkId, busy: false, msgs: Array.from({ length: 501 }, () => ({ id: upId, msg: { t: 'events', sessionId: 's', events: [] } })) }),
      '['.repeat(100) + ']'.repeat(100),
    ]) expect(() => parseHttpEventsRequest(raw)).toThrow(ProtocolFrameError);
  });
  it('refuses hello and pong upstream', () => {
    for (const msg of [hello, { t: 'pong', at: 1 }]) {
      expect(UpstreamMessageSchema.safeParse({ id: upId, msg }).success).toBe(false);
      expect(() => parseHttpEventsRequest(JSON.stringify({ linkId, busy: false, msgs: [{ id: upId, msg }] }))).toThrow(ProtocolFrameError);
    }
    expect(UpstreamMessageSchema.safeParse({ id: upId, msg: { t: 'tool_call', id: '1', sessionId: 's', runId: 'r', tool: 'x', args: {} } }).success).toBe(true);
  });
  it('parses outbox and control lines', () => {
    expect(parseStreamLine('{"seq":3,"msg":{"t":"ping","at":1}}')).toEqual({ seq: 3, msg: { t: 'ping', at: 1 } });
    expect(parseStreamLine('{"ctl":"rotate"}')).toEqual({ ctl: 'rotate' });
    expect(parseStreamLine('{"ctl":"ping","at":5}')).toEqual({ ctl: 'ping', at: 5 });
    expect(() => parseStreamLine('{"seq":0,"msg":{"t":"ping","at":1}}')).toThrow(); // seq starts at 1
    expect(() => parseStreamLine('{"ctl":"bye"}')).toThrow(ProtocolFrameError);
    expect(() => parseStreamLine('{"seq":1,"msg":{"t":"hello"}}')).toThrow(ProtocolFrameError);
    expect(() => parseStreamLine(JSON.stringify({ ctl: 'ping', pad: 'x'.repeat(1_048_577) }))).toThrow(/too large/);
  });
  it('connect response: welcome with link + cursor, or upgrade_required', () => {
    const welcome = { t: 'welcome', machineId: 'm', protocol: 2, minAgentVersion: '0.3.0', linkId, cursor: 0, replies: [{ t: 'ping', at: 1 }] };
    expect(HttpConnectResponseSchema.parse(welcome)).toEqual(welcome);
    expect(HttpConnectResponseSchema.safeParse({ ...welcome, linkId: 'lnk_x' }).success).toBe(false);
    expect(HttpConnectResponseSchema.safeParse({ ...welcome, cursor: -1 }).success).toBe(false);
    expect(HttpConnectResponseSchema.parse({ t: 'upgrade_required', minAgentVersion: '0.3.0' })).toEqual({ t: 'upgrade_required', minAgentVersion: '0.3.0' });
  });
  it('events response lists processed / retry ids and replies', () => {
    expect(HttpEventsResponseSchema.parse({ processed: [upId], retry: [], replies: [] })).toEqual({ processed: [upId], retry: [], replies: [] });
    expect(HttpEventsResponseSchema.safeParse({ processed: [], replies: [] }).success).toBe(false);
  });
});
