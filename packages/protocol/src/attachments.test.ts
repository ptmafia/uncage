import { describe, expect, it } from 'vitest';
import { classifyAttachment, displayFileName } from './attachments.js';

describe('displayFileName', () => {
  it('keeps the NFC basename without control characters, capped at 200 chars with its extension', () => {
    expect(displayFileName('a/b\\c.png')).toBe('c.png');
    expect(displayFileName(' x\u0000y.txt ')).toBe('xy.txt');
    expect(displayFileName('..')).toBe('file');
    expect(displayFileName('dir/')).toBe('file');
    const long = displayFileName(`${'设'.repeat(300)}.png`);
    expect([...long]).toHaveLength(200);
    expect(classifyAttachment(long, 'image/png')).toBe('image');
  });
});
