import { createUncage, type Uncage, type UncageOptions } from '@uncage/core';
import { createFakeAdapter, type FakeStep } from '@uncage/testkit';
import { createUncageServer, type ServerOptions } from './app.js';

export const TOKEN = 'test-token-0123456789';
export const PORT = 4783;
export const HOST = `127.0.0.1:${PORT}`;
export const auth = { host: HOST, authorization: `Bearer ${TOKEN}` };

export const shellApproval: FakeStep = {
  approval: { category: 'shell', title: 'Run ls', target: { command: 'ls' } },
};

export type TestServer = Awaited<ReturnType<typeof createUncageServer>> & { uncage: Uncage };

/** Tracks servers so `closeAll` can tear them down after each test. */
export function serverFactory() {
  const open: TestServer[] = [];
  return {
    async make(
      script: FakeStep[],
      extra: Partial<ServerOptions> = {},
      uncageExtra: Partial<UncageOptions> = {},
    ): Promise<TestServer> {
      const uncage = await createUncage({
        adapters: [createFakeAdapter({ script })],
        dataDir: 'memory://',
        ...uncageExtra,
      });
      const server = await createUncageServer({ uncage, token: TOKEN, port: PORT, ...extra });
      const s = { ...server, uncage };
      open.push(s);
      return s;
    },
    async closeAll(): Promise<void> {
      for (const s of open.splice(0)) {
        await s.close();
        await s.uncage.close();
      }
    },
  };
}

export interface SseFrame {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
}

/** Minimal SSE reader for tests: yields parsed frames (comments included) from a fetch body. */
export async function* readFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const frame: SseFrame = {};
      for (const line of raw.split('\n')) {
        if (line.startsWith(':')) frame.comment = line.slice(1).trim();
        else {
          const colon = line.indexOf(':');
          const key = line.slice(0, colon) as 'id' | 'event' | 'data';
          frame[key] = line.slice(colon + 1).replace(/^ /, '');
        }
      }
      yield frame;
    }
  }
}

export interface SseConnection {
  res: Response;
  /** Reads frames until `until` matches (inclusive), or throws after `timeoutMs`. */
  until(pred: (f: SseFrame) => boolean, timeoutMs?: number): Promise<SseFrame[]>;
  /** Reads every frame until the server ends the stream. */
  all(timeoutMs?: number): Promise<SseFrame[]>;
  close(): void;
}

export async function openSse(url: string, headers: Record<string, string> = {}): Promise<SseConnection> {
  const ac = new AbortController();
  const res = await fetch(url, { headers, signal: ac.signal });
  const body = res.body;
  if (!body) throw new Error('no body');
  const frames = readFrames(body);
  const seen: SseFrame[] = [];
  const read = async (pred: (f: SseFrame) => boolean, timeoutMs = 3000): Promise<SseFrame[]> => {
    const start = seen.length;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out; saw ${JSON.stringify(seen.slice(start))}`)), timeoutMs);
    });
    const reader = (async () => {
      for (;;) {
        const next = await frames.next();
        if (next.done) return seen.slice(start);
        seen.push(next.value);
        if (pred(next.value)) return seen.slice(start);
      }
    })();
    reader.catch(() => undefined);
    try {
      return await Promise.race([reader, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    res,
    until: read,
    all: (timeoutMs) => read(() => false, timeoutMs),
    close: () => ac.abort(),
  };
}
