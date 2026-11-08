import { describe, expect, it } from 'vitest';
import { BRIDGE_TOKEN_ENV } from './site-mcp.js';
import { redactAcpTraffic } from './traffic.js';

describe('redactAcpTraffic', () => {
  it('redacts MCP bearer tokens in session/new and session/resume', () => {
    const msg = {
      jsonrpc: '2.0',
      id: 3,
      method: 'session/resume',
      params: {
        sessionId: 's1',
        cwd: '/tmp/x',
        mcpServers: [
          { type: 'http', name: 'site', url: 'http://127.0.0.1:1/mcp', headers: [{ name: 'Authorization', value: 'Bearer abc.DEF_123-xyz' }] },
          { name: 'site', command: '/node', args: ['bridge.js', 'http://127.0.0.1:1/mcp'], env: [{ name: BRIDGE_TOKEN_ENV, value: 'tok-secret' }] },
        ],
      },
    };
    const out = JSON.stringify(redactAcpTraffic(msg));
    expect(out).not.toContain('abc.DEF_123-xyz');
    expect(out).not.toContain('tok-secret');
    expect(out).toContain('"value":"Bearer [redacted]"');
    expect(out).toContain('"value":"[redacted]"');
    expect(out).toContain('http://127.0.0.1:1/mcp');
  });

  it('drops the params of _auth/status_update and masks e-mails and stray bearer tokens anywhere', () => {
    const auth = { jsonrpc: '2.0', method: '_auth/status_update', params: { authStatus: { account: { email: 'someone@example.com', organization: 'Org' } } } };
    expect(redactAcpTraffic(auth)).toEqual({ jsonrpc: '2.0', method: '_auth/status_update', params: '[redacted]' });
    const chunk = { method: 'session/update', params: { update: { content: { text: 'mail a.b+c@mail.example.co.jp, curl -H "Authorization: Bearer zzz999"' } } } };
    const out = JSON.stringify(redactAcpTraffic(chunk));
    expect(out).not.toMatch(/a\.b\+c@|zzz999/);
    expect(out).toContain('[email]');
    expect(out).toContain('Bearer [redacted]');
    expect(redactAcpTraffic('raw line Bearer q1 x@y.io')).toBe('raw line Bearer [redacted] [email]');
  });

  it('leaves everything else untouched', () => {
    const msg = { id: 1, result: { stopReason: 'end_turn', n: 2, ok: true, none: null } };
    expect(redactAcpTraffic(msg)).toEqual(msg);
  });
});
