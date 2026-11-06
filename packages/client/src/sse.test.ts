import { describe, expect, it } from 'vitest';
import { parseSSE } from './sse.js';

const streamOf = (chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
const text = (s: string) => [new TextEncoder().encode(s)];
const collect = async (s: ReadableStream<Uint8Array>) => {
  const out = [];
  for await (const f of parseSSE(s)) out.push(f);
  return out;
};

describe('parseSSE', () => {
  it('parses multi-line data and id/event fields', async () => {
    const frames = await collect(streamOf(text('id: evt_1\nevent: message\ndata: a\ndata: b\n\ndata: c\r\n\r\n')));
    expect(frames).toEqual([
      { id: 'evt_1', event: 'message', data: 'a\nb' },
      { id: 'evt_1', data: 'c' },
    ]);
  });

  it('ignores comment lines', async () => {
    const frames = await collect(streamOf(text(': ping\n\n: hi\ndata: x\n\n')));
    expect(frames).toEqual([{ data: 'x' }]);
  });

  it('CJK/emoji split across chunks decodes intact', async () => {
    const bytes = new TextEncoder().encode('data: 你好🙂\n\n');
    for (let i = 1; i < bytes.length; i++) {
      const frames = await collect(streamOf([bytes.slice(0, i), bytes.slice(i)]));
      expect(frames).toEqual([{ data: '你好🙂' }]);
    }
  });
});
