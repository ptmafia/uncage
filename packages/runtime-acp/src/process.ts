import { spawn } from 'node:child_process';
import { win32 } from 'node:path';
import { relativeWindowsExecutable } from './which.js';
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

/** Process groups of agents still possibly alive (POSIX). */
const liveGroups = new Set<number>();
let exitHooked = false;

/** SIGKILLs every agent process group still known. Synchronous: runs from `process.on('exit')`. */
export function killAllAgentGroups(): void {
  for (const pgid of liveGroups) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  liveGroups.clear();
}

function trackGroup(pgid: number): void {
  liveGroups.add(pgid);
  if (!exitHooked) {
    exitHooked = true;
    // However this process ends (process.exit included), no agent or grandchild outlives it.
    process.on('exit', killAllAgentGroups);
  }
}
const untrackGroup = (pgid: number): void => void liveGroups.delete(pgid);

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
  const relative = relativeWindowsExecutable(executable);
  if (relative) throw relative;
  const windows = process.platform === 'win32';
  const proc = spawn(executable, args, {
    env: o.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // POSIX: its own process group, so stopping the agent also stops whatever it started.
    detached: !windows,
    // `cmd.exe /d /s /c "<line>"` (see spawnableCommand): the line is already quoted.
    windowsVerbatimArguments: windows && win32.basename(executable).toLowerCase() === 'cmd.exe',
  });

  let stderrBuf = Buffer.alloc(0);
  proc.stderr.on('data', (chunk: Buffer) => {
    stderrBuf = Buffer.concat([stderrBuf, chunk]);
    if (stderrBuf.length > STDERR_TAIL_BYTES) stderrBuf = stderrBuf.subarray(stderrBuf.length - STDERR_TAIL_BYTES);
  });
  // The tail may start mid-character; the decoder replaces a partial leading sequence.
  const stderrTail = (): string => stderrBuf.toString('utf8');
  // EPIPE after the child died is reported through 'close'.
  proc.stdin.on('error', () => undefined);

  let spawnError: Error | undefined;
  let exitedFlag = false;
  const exited = new Promise<AcpExit>((resolve) => {
    // 'close' (not 'exit') so every stdout line is read before the exit is reported.
    proc.once('close', (code, signal) => {
      exitedFlag = true;
      resolve({ code, signal, stderrTail: stderrTail() });
    });
    // Spawn failures (ENOENT) emit 'error' and no 'close' on some platforms; `on` so a later
    // error (e.g. a failed kill) never goes unhandled.
    proc.on('error', (err) => {
      spawnError ??= err;
      if (proc.pid === undefined) {
        exitedFlag = true;
        resolve({ code: null, signal: null, stderrTail: stderrTail() });
      }
    });
  });

  // POSIX: the agent leads its own process group; remember it until the group has been killed.
  const pgid = !windows && proc.pid !== undefined ? proc.pid : undefined;
  if (pgid !== undefined) trackGroup(pgid);
  /** Signals the agent's whole process group (POSIX; even after the leader exited), else the agent. */
  const signalGroup = (sig: NodeJS.Signals): void => {
    if (pgid !== undefined) {
      try {
        process.kill(-pgid, sig);
      } catch {
        // The whole group is gone.
      }
      return;
    }
    if (!exitedFlag) proc.kill(sig);
  };
  let killTimer: NodeJS.Timeout | undefined;
  /**
   * SIGTERM to the group, then SIGKILL to the group after a grace period. The SIGKILL is sent even
   * when the leader exited meanwhile (its children may still run); a process exit before that is
   * covered by the exit hook.
   */
  const kill = (): void => {
    if (killTimer) return;
    signalGroup('SIGTERM');
    killTimer = setTimeout(() => {
      signalGroup('SIGKILL');
      if (pgid !== undefined) untrackGroup(pgid);
    }, KILL_GRACE_MS);
    killTimer.unref();
  };
  // The agent exited by itself: whatever it left behind in its group goes too.
  void exited.then(() => {
    if (pgid !== undefined) kill();
  });

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
