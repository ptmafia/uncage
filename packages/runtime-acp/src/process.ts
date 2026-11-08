import { spawn, spawnSync } from 'node:child_process';
import { isCmdLine, resolveCommand, systemTool } from '@uncage/protocol/node';
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
import pkg from '../package.json' with { type: 'json' };

/**
 * Uncage does not serve `fs/*` or `terminal/*` to agents: they use their own tools on the workspace,
 * so Uncage never becomes an execution surface.
 */
export const CLIENT_CAPABILITIES: ClientCapabilities = { fs: { readTextFile: false, writeTextFile: false }, terminal: false };

export const CLIENT_INFO = { name: 'uncage', title: 'Uncage', version: pkg.version };

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
  /**
   * Stops the agent and whatever it started. POSIX: SIGTERM to its process group, SIGKILL after a
   * grace period. Windows: `taskkill /t /f` on its process tree (npx / cmd.exe agents run the real
   * agent as a grandchild) and its stdin ended. `force`: SIGKILL / tree kill at once, and our ends of
   * its stdio pipes closed, so `exited` settles even if a grandchild still holds them.
   */
  kill(force?: boolean): void;
}

/** Windows: the tree kill for `pid` (`%SystemRoot%\System32\taskkill.exe /pid <pid> /t /f`, never a bare name). */
export function treeKillArgv(pid: number, env: NodeJS.ProcessEnv = process.env): [string, string[]] {
  return [systemTool('taskkill', { platform: 'win32', env }), ['/pid', String(pid), '/t', '/f']];
}

/**
 * `kill()`, then waits for `exited` at most `timeoutMs`; past that, force-kills and resolves anyway
 * (`'timeout'`), so a caller (`dispose`, `uncage runtimes`, `uncage doctor`) never blocks forever.
 */
export async function stopAcpProcess(p: Pick<AcpProcess, 'kill' | 'exited'>, timeoutMs: number): Promise<'exited' | 'timeout'> {
  p.kill();
  let timer: NodeJS.Timeout | undefined;
  const r = await Promise.race([
    p.exited.then(() => 'exited' as const),
    new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
  if (r === 'timeout') p.kill(true);
  return r;
}

export interface AcpClientHandlers {
  onUpdate(n: SessionNotification): void;
  onPermission(req: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse>;
}

/** Process groups (POSIX) / process tree roots (Windows) of agents still possibly alive. */
const liveGroups = new Set<number>();
const liveWinPids = new Set<number>();
let exitHooked = false;

/**
 * SIGKILLs every agent process group still known (POSIX); tree-kills every agent still known with
 * `taskkill /t /f` (Windows, best effort). Synchronous: runs from `process.on('exit')`.
 */
export function killAllAgentGroups(): void {
  for (const pgid of liveGroups) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  liveGroups.clear();
  for (const pid of liveWinPids) {
    try {
      const [file, args] = treeKillArgv(pid);
      spawnSync(file, args, { stdio: 'ignore', windowsHide: true, timeout: 5_000 });
    } catch {
      // Best effort.
    }
  }
  liveWinPids.clear();
}

function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  // However this process ends (process.exit included), no agent or grandchild outlives it.
  process.on('exit', killAllAgentGroups);
}
function trackGroup(pgid: number): void {
  liveGroups.add(pgid);
  hookExit();
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
 * The argv to spawn. POSIX: unchanged (`command[0]` is found on `env.PATH` by the spawn). Windows:
 * through `resolveCommand`: PATH × PATHEXT, never the current directory; an npm `.cmd` shim becomes
 * node + its JS file; any other `.cmd`/`.bat` runs as the absolute `cmd.exe /d /s /c "<line>"` with
 * every argument quoted (an argument cmd.exe would interpret is refused). Never `shell: true`.
 */
export async function acpSpawnArgv(
  command: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<{ file: string; args: string[]; verbatim: boolean }> {
  const [executable, ...args] = command;
  if (!executable) throw new Error('The ACP agent command is empty.');
  if (platform !== 'win32') return { file: executable, args, verbatim: false };
  const r = await resolveCommand(executable, args, { platform, env });
  if (!r) throw Object.assign(new Error(`spawn ${executable} ENOENT (not found on PATH)`), { code: 'ENOENT', path: executable });
  // `cmd.exe /d /s /c "<line>"`: the line is already quoted; Node must not quote it again.
  return { file: r.file, args: r.args, verbatim: isCmdLine(r.file, r.args) };
}

/**
 * Spawns an ACP agent (`acpSpawnArgv`), connects the official SDK client over its stdio and
 * completes `initialize`. Rejects with the spawn error (e.g. `ENOENT`), an `AcpProtocolError`, an
 * `AcpExitError`, or a timeout; the process is killed in every case.
 */
export async function startAcpProcess(o: {
  command: string[];
  env: NodeJS.ProcessEnv;
  handlers: AcpClientHandlers;
  initTimeoutMs: number;
}): Promise<AcpProcess> {
  const { file, args, verbatim } = await acpSpawnArgv(o.command, o.env);
  const windows = process.platform === 'win32';
  const proc = spawn(file, args, {
    env: o.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // POSIX: its own process group, so stopping the agent also stops whatever it started.
    detached: !windows,
    windowsHide: true,
    windowsVerbatimArguments: verbatim,
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
  // Windows: no process groups; remember the tree root for the exit hook.
  const winPid = windows ? proc.pid : undefined;
  if (winPid !== undefined) {
    liveWinPids.add(winPid);
    hookExit();
  }
  let treeKilled = false;
  /** Windows: `taskkill /t /f` on the agent's tree (absolute path), once. */
  const treeKill = (): void => {
    if (winPid === undefined || treeKilled) return;
    treeKilled = true;
    liveWinPids.delete(winPid);
    try {
      const [file, args] = treeKillArgv(winPid, o.env);
      const tk = spawn(file, args, { stdio: 'ignore', windowsHide: true });
      tk.on('error', () => undefined);
    } catch {
      // Falls back to killing the direct child below.
    }
  };
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
  const kill = (force = false): void => {
    if (windows) {
      proc.stdin.end();
      treeKill();
      if (!exitedFlag) proc.kill(force ? 'SIGKILL' : 'SIGTERM');
    } else if (force) {
      signalGroup('SIGKILL');
      if (pgid !== undefined) untrackGroup(pgid);
    } else if (!killTimer) {
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => {
        signalGroup('SIGKILL');
        if (pgid !== undefined) untrackGroup(pgid);
      }, KILL_GRACE_MS);
      killTimer.unref();
    }
    if (force) {
      // A grandchild may still hold the pipes: close our ends so `close` (and `exited`) can fire.
      proc.stdout.destroy();
      proc.stderr.destroy();
      proc.stdin.destroy();
    }
  };
  // The agent exited by itself: whatever it left behind in its group / tree goes too.
  void exited.then(() => {
    if (pgid !== undefined) kill();
    else if (winPid !== undefined) treeKill();
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
