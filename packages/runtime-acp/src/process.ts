import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientCapabilities,
  type ClientConnection,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';

/**
 * Uncage does not serve `fs/*` or `terminal/*` to agents: they use their own tools on the workspace,
 * so Uncage never becomes an execution surface.
 */
export const CLIENT_CAPABILITIES: ClientCapabilities = { fs: { readTextFile: false, writeTextFile: false }, terminal: false };

export const CLIENT_INFO = { name: 'uncage', title: 'Uncage', version: '0.0.0' };

const STDERR_TAIL_BYTES = 4096;
const KILL_GRACE_MS = 2000;

export interface AcpExit {
  code: number | null;
  signal: string | null;
  /** The last 4 KiB of the agent's stderr. */
  stderrTail: string;
}

export interface AcpProcess {
  readonly conn: ClientConnection;
  readonly init: InitializeResponse;
  readonly pid: number | undefined;
  readonly exited: Promise<AcpExit>;
  kill(): void;
}

export interface AcpClientHandlers {
  onUpdate(n: SessionNotification): void;
  onPermission(req: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse>;
}

/** `initialize` answered with a protocol version this client does not speak. */
export class AcpProtocolError extends Error {
  constructor(readonly version: unknown) {
    super(`Unsupported ACP protocol version ${String(version)} (Uncage speaks protocol version ${PROTOCOL_VERSION}).`);
    this.name = 'AcpProtocolError';
  }
}

/** The agent process exited before it answered `initialize`. */
export class AcpExitError extends Error {
  constructor(readonly exit: AcpExit) {
    const tail = exit.stderrTail.trim();
    super(`The agent exited (${exit.signal ?? `code ${String(exit.code)}`}) before answering initialize${tail ? `: ${tail}` : ''}`);
    this.name = 'AcpExitError';
  }
}

/**
 * Spawns an ACP agent (`command[0]` resolved on PATH, or absolute), connects the official SDK
 * client over its stdio and completes `initialize`. Rejects with the spawn error (e.g. `ENOENT`),
 * an `AcpProtocolError`, an `AcpExitError`, or a timeout; the process is killed in every case.
 */
export async function startAcpProcess(o: {
  command: string[];
  env: NodeJS.ProcessEnv;
  handlers: AcpClientHandlers;
  initTimeoutMs: number;
}): Promise<AcpProcess> {
  const [executable, ...args] = o.command;
  if (!executable) throw new Error('The ACP agent command is empty.');
  const proc = spawn(executable, args, { env: o.env, stdio: ['pipe', 'pipe', 'pipe'] });

  let stderrTail = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
  });
  // EPIPE after the child died is reported through 'close'.
  proc.stdin.on('error', () => undefined);

  let spawnError: Error | undefined;
  let exitedFlag = false;
  const exited = new Promise<AcpExit>((resolve) => {
    // 'close' (not 'exit') so every stdout line is read before the exit is reported.
    proc.once('close', (code, signal) => {
      exitedFlag = true;
      resolve({ code, signal, stderrTail });
    });
    // Spawn failures (ENOENT) emit 'error' and no 'close' on some platforms; `on` so a later
    // error (e.g. a failed kill) never goes unhandled.
    proc.on('error', (err) => {
      spawnError ??= err;
      if (proc.pid === undefined) {
        exitedFlag = true;
        resolve({ code: null, signal: null, stderrTail });
      }
    });
  });

  let killTimer: NodeJS.Timeout | undefined;
  const kill = (): void => {
    if (exitedFlag || killTimer) return;
    proc.kill('SIGTERM');
    killTimer = setTimeout(() => {
      if (!exitedFlag) proc.kill('SIGKILL');
    }, KILL_GRACE_MS);
    killTimer.unref();
  };
  void exited.then(() => clearTimeout(killTimer));

  const app = client({ name: 'uncage' })
    .onNotification(methods.client.session.update, ({ params }) => o.handlers.onUpdate(params))
    .onRequest(methods.client.session.requestPermission, ({ params, signal }) => o.handlers.onPermission(params, signal));
  const conn = app.connect(
    ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>),
  );
  void exited.then(() => conn.close());

  let timer: NodeJS.Timeout | undefined;
  try {
    const initialize: Promise<InitializeResponse> = conn.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: CLIENT_CAPABILITIES,
      clientInfo: CLIENT_INFO,
    });
    const init = await Promise.race([
      initialize,
      exited.then((exit): never => {
        throw spawnError ?? new AcpExitError(exit);
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`The agent did not answer initialize within ${o.initTimeoutMs} ms.`)), o.initTimeoutMs);
      }),
    ]);
    if (init.protocolVersion !== PROTOCOL_VERSION) throw new AcpProtocolError(init.protocolVersion);
    return { conn, init, pid: proc.pid, exited, kill };
  } catch (err) {
    kill();
    conn.close();
    throw spawnError ?? err;
  } finally {
    clearTimeout(timer);
  }
}
