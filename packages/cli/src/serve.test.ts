import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, formatBanner } from './serve.js';

describe('createLogger', () => {
  it('redacts token and authorization', () => {
    let out = '';
    const sink = new Writable({
      write(chunk, _e, cb) {
        out += String(chunk);
        cb();
      },
    });
    const log = createLogger({}, sink);
    log.info({ token: 'TOK1', authorization: 'Bearer AUTH1', req: { headers: { authorization: 'Bearer AUTH2' } }, x: { token: 'TOK2', apiKey: 'KEY1' } }, 'hi');
    expect(out).not.toMatch(/TOK|AUTH|KEY1/);
    expect(out).toContain('[redacted]');
  });
});

describe('formatBanner', () => {
  it('warns when bypassPermissions is enabled', () => {
    const rt = [{ id: 'claude', ok: true }];
    expect(formatBanner('http://127.0.0.1:4783', '/w', rt)).not.toContain('bypassPermissions');
    expect(formatBanner('http://127.0.0.1:4783', '/w', rt, { allowBypass: false })).not.toContain('bypassPermissions');
    expect(formatBanner('http://127.0.0.1:4783', '/w', rt, { allowBypass: true }).split('\n')).toEqual([
      'Uncage listening on http://127.0.0.1:4783 · workspace /w · runtimes: claude ✓',
      '⚠ bypassPermissions enabled',
    ]);
  });
});
