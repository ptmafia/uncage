import type { ChildProcessWithoutNullStreams } from 'node:child_process';

type Id = number | string;

interface Pending {
  method: string;
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer?: NodeJS.Timeout;
}

export interface JsonRpcPeerOptions {
  /** Reject a request that gets no response within this many ms. Defaults to no timeout. */
  requestTimeoutMs?: number;
}

/** A JSON-RPC error response from the other side. */
export class JsonRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'JsonRpcError';
  }
}

const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

/**
 * JSON-RPC over a child process's stdio, one JSON object per line.
 * Codex omits the `"jsonrpc": "2.0"` field, so this peer neither sends nor requires it.
 */
export class JsonRpcPeer {
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<Id, Pending>();
  private readonly notificationListeners = new Set<(method: string, params: unknown) => void>();
  private requestHandler?: (method: string, params: unknown, id: Id) => Promise<unknown>;
  private readonly exitListeners: Array<(code: number | null) => void> = [];
  private exited = false;
  private exitCode: number | null = null;
  private readonly exitedPromise: Promise<void>;

  constructor(
    private readonly proc: ChildProcessWithoutNullStreams,
    private readonly opts: JsonRpcPeerOptions = {},
  ) {
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onData(chunk));
    // Drain stderr so a chatty child never blocks on a full pipe.
    proc.stderr.resume();
    // EPIPE after the child died is reported through 'exit'.
    proc.stdin.on('error', () => undefined);
    this.exitedPromise = new Promise((resolve) => {
      // 'close' (not 'exit') so every stdout line is dispatched before pending requests fail.
      proc.once('close', (code) => {
        this.handleExit(code);
        resolve();
      });
      // Spawn failures (e.g. ENOENT) emit 'error' and never 'exit'.
      // `on`, not `once`: a later 'error' (e.g. a failed kill) must never go unhandled.
      proc.on('error', () => {
        this.handleExit(null);
        resolve();
      });
    });
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.exited) return Promise.reject(this.exitError());
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { method, resolve: resolve as (v: unknown) => void, reject };
      if (this.opts.requestTimeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${method} timed out after ${this.opts.requestTimeoutMs} ms`));
        }, this.opts.requestTimeoutMs);
      }
      this.pending.set(id, entry);
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- params are protocol-specific; callers narrow them.
  onNotification(fn: (method: string, params: any) => void): () => void {
    this.notificationListeners.add(fn);
    return () => this.notificationListeners.delete(fn);
  }

  /** Handles server-initiated requests; the resolved value is sent back as `result`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see onNotification.
  onRequest(fn: (method: string, params: any, id: Id) => Promise<unknown>): void {
    this.requestHandler = fn;
  }

  onExit(fn: (code: number | null) => void): void {
    if (this.exited) queueMicrotask(() => fn(this.exitCode));
    else this.exitListeners.push(fn);
  }

  get closed(): boolean {
    return this.exited;
  }

  async close(): Promise<void> {
    if (!this.exited) {
      this.proc.stdin.end();
      this.proc.kill();
    }
    await this.exitedPromise;
  }

  private send(message: Record<string, unknown>): void {
    if (this.exited || this.proc.stdin.destroyed) return;
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line === '') continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // Not a protocol line (e.g. a stray log); ignore it.
      }
      this.dispatch(message);
    }
  }

  private dispatch(m: Record<string, unknown>): void {
    const id = m.id as Id | undefined;
    const method = typeof m.method === 'string' ? m.method : undefined;
    if (method !== undefined && id !== undefined) return void this.handleRequest(method, m.params, id);
    if (method !== undefined) {
      for (const fn of [...this.notificationListeners]) fn(method, m.params);
      return;
    }
    if (id === undefined) return;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (m.error !== undefined) {
      const err = (m.error ?? {}) as { code?: number; message?: string };
      entry.reject(new JsonRpcError(entry.method, err.code, err.message ?? `${entry.method} failed`));
    } else {
      entry.resolve(m.result);
    }
  }

  private async handleRequest(method: string, params: unknown, id: Id): Promise<void> {
    if (!this.requestHandler) {
      this.send({ id, error: { code: METHOD_NOT_FOUND, message: `Unsupported request: ${method}` } });
      return;
    }
    try {
      const result = await this.requestHandler(method, params, id);
      this.send({ id, result: result ?? {} });
    } catch (err) {
      const code = err instanceof JsonRpcError && err.code !== undefined ? err.code : INTERNAL_ERROR;
      this.send({ id, error: { code, message: err instanceof Error ? err.message : String(err) } });
    }
  }

  private exitError(): Error {
    return new Error(`codex app-server exited (code ${this.exitCode ?? 'null'})`);
  }

  private handleExit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    const err = this.exitError();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
    for (const fn of this.exitListeners.splice(0)) fn(code);
  }
}
