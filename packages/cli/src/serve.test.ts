import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './serve.js';

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
