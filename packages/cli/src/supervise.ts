import { spawn } from 'node:child_process';
import { appendFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Env var naming the supervisor's pid: the agent child exits when that process is gone. */
export const SUPERVISOR_PID_ENV = 'UNCAGE_SUPERVISOR_PID';
/** The self-upgrade exit code (`UPGRADE_EXIT_CODE` in @uncage/agent): restart quickly with the new version. */
const UPGRADE_EXIT = 75;

export interface SupervisedChild {
  /** Resolves with the exit code (null when killed by a signal). */
  exited: Promise<number | null>;
  kill(): void;
}

export interface SuperviseOptions {
  execPath: string;
  entry: string;
  /** The child's arguments, e.g. `['agent', '--log-file', <path>]`. */
  args: string[];
  /** Appends one line per restart (the agent's log file). */
  logFile?: string;
  /**
   * Where the supervisor writes its pid (default `supervisor.pid` beside `logFile`): the Windows
   * service kills this process tree on uninstall / restart, because ending the task only stops
   * conhost, not the node processes under it.
   */
  pidFile?: string;
  /** Wait before restarting after a failure (default 10 s, like the systemd unit's RestartSec). */
  restartDelayMs?: number;
  /** Wait before restarting after a self-upgrade (exit 75; default 1 s). */
  upgradeDelayMs?: number;
  /** Injectable for tests. */
  start?: (file: string, args: string[], env: NodeJS.ProcessEnv) => SupervisedChild;
  sleep?: (ms: number) => Promise<void>;
  /** Called once the supervisor should stop (signal); resolves the loop with 0. */
  stopSignal?: Promise<void>;
}

function defaultStart(file: string, args: string[], env: NodeJS.ProcessEnv): SupervisedChild {
  const child = spawn(file, args, { env, stdio: 'ignore', windowsHide: true });
  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code));
    child.on('error', () => resolve(1));
  });
  return { exited, kill: () => void child.kill() };
}

/**
 * Keeps `<node> <entry> ...args` running: a clean exit (0: no websites configured) ends the
 * supervisor with 0; any other exit restarts it after `restartDelayMs` (1 s after a self-upgrade).
 * Windows needs this: Task Scheduler's RestartOnFailure does not restart a task whose program
 * exits non-zero, and the HKCU Run-key fallback has no restart at all. The child gets the
 * supervisor's pid (`UNCAGE_SUPERVISOR_PID`) and exits when the supervisor is gone (task ended).
 */
export async function superviseAgent(o: SuperviseOptions): Promise<number> {
  const start = o.start ?? defaultStart;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const env = { ...process.env, [SUPERVISOR_PID_ENV]: String(process.pid) };
  let stopping = false;
  let current: SupervisedChild | undefined;
  void o.stopSignal?.then(() => {
    stopping = true;
    current?.kill();
  });
  const pidFile = o.pidFile ?? (o.logFile ? supervisorPidPath(dirname(o.logFile)) : undefined);
  if (pidFile) await writeFile(pidFile, `${process.pid}\n`).catch(() => undefined);
  const done = async (): Promise<number> => {
    if (pidFile) await rm(pidFile, { force: true }).catch(() => undefined);
    return 0;
  };
  const note = (msg: string) =>
    o.logFile ? appendFile(o.logFile, `${JSON.stringify({ level: 40, time: Date.now(), msg: `supervisor: ${msg}` })}\n`).catch(() => undefined) : undefined;
  for (;;) {
    current = start(o.execPath, [o.entry, ...o.args], env);
    const code = await current.exited;
    if (stopping || code === 0) return done();
    const delay = code === UPGRADE_EXIT ? (o.upgradeDelayMs ?? 1_000) : (o.restartDelayMs ?? 10_000);
    await note(`agent exited with ${code ?? 'a signal'}; restarting in ${delay} ms`);
    await sleep(delay);
    if (stopping) return done();
  }
}

/** `<logsDir>/supervisor.pid`. */
export const supervisorPidPath = (logsDir: string): string => join(logsDir, 'supervisor.pid');

/** In the agent child: exit when the supervisor that started it is gone (checked every second). */
export function watchSupervisor(env: NodeJS.ProcessEnv = process.env, exit: (code: number) => void = (c) => process.exit(c)): void {
  const pid = Number(env[SUPERVISOR_PID_ENV]);
  if (!Number.isInteger(pid) || pid <= 0) return;
  setInterval(() => {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EPERM') exit(0);
    }
  }, 1_000).unref();
}
