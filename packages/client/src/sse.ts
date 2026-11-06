export interface SSEFrame {
  id?: string;
  event?: string;
  data: string;
}

/** Parses a text/event-stream body. Decodes with `stream: true` so multi-byte characters split across chunks stay intact. */
export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncIterable<SSEFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let id: string | undefined;
  let event: string | undefined;
  let data: string[] = [];

  const handleLine = (line: string): SSEFrame | undefined => {
    if (line === '') {
      const frame = data.length > 0 || event !== undefined ? { id, event, data: data.join('\n') } : undefined;
      event = undefined;
      data = [];
      if (!frame) return undefined;
      const out: SSEFrame = { data: frame.data };
      if (frame.id !== undefined) out.id = frame.id;
      if (frame.event !== undefined) out.event = frame.event;
      return out;
    }
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id') id = value;
    return undefined;
  };

  function* drain(final: boolean): Generator<SSEFrame> {
    for (;;) {
      const m = /\r\n|\n|\r/.exec(buffer);
      // A trailing lone "\r" may be the first half of "\r\n"; wait for more input unless the stream ended.
      if (!m || (!final && m[0] === '\r' && m.index === buffer.length - 1)) break;
      const line = buffer.slice(0, m.index);
      buffer = buffer.slice(m.index + m[0].length);
      const frame = handleLine(line);
      if (frame) yield frame;
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      yield* drain(false);
    }
    buffer += decoder.decode();
    yield* drain(true);
    // An unterminated final frame is discarded, per the SSE spec.
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
