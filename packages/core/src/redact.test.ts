import { describe, expect, it } from 'vitest';
import { redactForExport } from './redact.js';

describe('redactForExport', () => {
  it('keeps ids, states and safe keys; replaces other strings with a length placeholder', () => {
    const out = redactForExport({
      sessionId: 'ses_1',
      type: 'run.started',
      prompt: 'secret prompt',
      nested: { title: 'hello', state: 'running' },
      input: { anything: 'x' },
      list: ['a', 'bb'],
      n: 3,
    });
    expect(out).toEqual({
      sessionId: 'ses_1',
      type: 'run.started',
      prompt: '[redacted 13 chars]',
      nested: { title: '[redacted 5 chars]', state: 'running' },
      input: '[redacted object]',
      list: ['[redacted 1 chars]', '[redacted 2 chars]'],
      n: 3,
    });
  });
});
