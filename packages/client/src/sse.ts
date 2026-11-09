export interface SSEFrame {
  id?: string;
  event?: string;
  data: string;
}

interface StreamDecoder {
  decode(input?: Uint8Array, options?: { stream?: boolean }): string;
}

/**
 * A streaming UTF-8 decoder for runtimes without `TextDecoder` (older Hermes / React Native).
 * Same output as `TextDecoder('utf-8')`: a character split across chunks waits for the rest, and
 * each maximal invalid subpart becomes one U+FFFD.
 */
export function utf8Decoder(): StreamDecoder {
  let pending: number[] = [];
  return {
    decode(input, options) {
      const bytes = pending.concat(Array.from(input ?? []));
      pending = [];
      const units: number[] = [];
      let out = '';
      const flush = () => {
        out += String.fromCharCode(...units);
        units.length = 0;
      };
      let i = 0;
      while (i < bytes.length) {
        const b = bytes[i]!;
        if (b < 0x80) {
          units.push(b);
          i++;
        } else {
          const need = b >= 0xc2 && b <= 0xdf ? 1 : b >= 0xe0 && b <= 0xef ? 2 : b >= 0xf0 && b <= 0xf4 ? 3 : -1;
          if (need < 0) {
            units.push(0xfffd);
            i++;
          } else {
            // Bounds of the first continuation byte exclude overlongs, surrogates and > U+10FFFF.
            const lo = b === 0xe0 ? 0xa0 : b === 0xf0 ? 0x90 : 0x80;
            const hi = b === 0xed ? 0x9f : b === 0xf4 ? 0x8f : 0xbf;
            let cp = b & (need === 1 ? 0x1f : need === 2 ? 0x0f : 0x07);
            let j = 1;
            for (; j <= need && i + j < bytes.length; j++) {
              const c = bytes[i + j]!;
              if (c < (j === 1 ? lo : 0x80) || c > (j === 1 ? hi : 0xbf)) break;
              cp = (cp << 6) | (c & 0x3f);
            }
            if (j > need) {
              if (cp > 0xffff) {
                cp -= 0x10000;
                units.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
              } else units.push(cp);
              i += j;
            } else if (i + j >= bytes.length && options?.stream) {
              pending = bytes.slice(i);
              break;
            } else {
              units.push(0xfffd);
              i += j;
            }
          }
        }
        if (units.length >= 4096) flush();
      }
      flush();
      return out;
    },
  };
}

/**
 * Parses a text/event-stream body. Decodes with `stream: true` so multi-byte characters split
 * across chunks stay intact. Aborting `signal` cancels the body, even when the fetch that made it
 * ignores aborts (a stream torn down while a mobile app was in the background never ends otherwise).
 */
export async function* parseSSE(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<SSEFrame> {
  const reader = stream.getReader();
  const decoder: StreamDecoder = typeof TextDecoder === 'function' ? new TextDecoder('utf-8') : utf8Decoder();
  const onAbort = () => void reader.cancel().catch(() => undefined);
  if (signal?.aborted) onAbort();
  signal?.addEventListener('abort', onAbort, { once: true });
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
      if (signal?.aborted) return;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      yield* drain(false);
    }
    buffer += decoder.decode();
    yield* drain(true);
    // An unterminated final frame is discarded, per the SSE spec.
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
