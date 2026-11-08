import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { release } from 'node:os';
import { join, win32 } from 'node:path';
import { windowsUser } from '@uncage/agent';
import { assertDefinitionValues, probeNode } from './spec.js';
import type { AgentService, ServiceDeps, ServiceKind, ServiceSpec, ServiceStatus } from './types.js';

export const TASK_NAME = 'UncageAgent';
export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
/** `%SystemRoot%\System32\conhost.exe`, resolved (the Run key and a direct start do not expand variables). */
export function conhostPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR ?? 'C:\\Windows';
  return win32.join(root, 'System32', 'conhost.exe');
}
/** conhost `--headless` (no console window) exists from Windows 10 1809 (build 17763). */
const HEADLESS_MIN_BUILD = 17763;

/** Element text: `&`, `<`, `>` (quotes need no escaping outside attributes). */
const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unxml = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

/**
 * One argument for a Windows command line (MSVC CRT rules): quoted when it is a path or holds
 * spaces/quotes; backslashes before a quote (and at the end) are doubled, quotes become `\"`.
 */
export function winQuote(a: string): string {
  if (a !== '' && /^[A-Za-z0-9_.=:,+@-]+$/.test(a)) return a;
  let out = '"';
  let bs = 0;
  for (const ch of a) {
    if (ch === '\\') bs++;
    else if (ch === '"') {
      out += '\\'.repeat(bs * 2 + 1) + '"';
      bs = 0;
    } else {
      out += '\\'.repeat(bs) + ch;
      bs = 0;
    }
  }
  return `${out}${'\\'.repeat(bs * 2)}"`;
}

/** Splits a Windows command line the way the MSVC CRT does (inverse of `winQuote`). */
export function winSplit(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (line[i] === ' ' || line[i] === '\t') i++;
    if (i >= line.length) break;
    let w = '';
    let inQuote = false;
    for (; i < line.length; i++) {
      const ch = line[i]!;
      if (ch === '\\') {
        let n = 0;
        while (line[i] === '\\') {
          n++;
          i++;
        }
        if (line[i] === '"') {
          w += '\\'.repeat(Math.floor(n / 2));
          if (n % 2 === 1) w += '"';
          else inQuote = !inQuote;
        } else {
          w += '\\'.repeat(n);
          i--;
        }
      } else if (ch === '"') inQuote = !inQuote;
      else if (!inQuote && (ch === ' ' || ch === '\t')) break;
      else w += ch;
    }
    out.push(w);
  }
  return out;
}

/** The program and arguments the task (or Run key) starts. */
export function taskCommand(spec: ServiceSpec, headless = true, conhost = conhostPath()): { command: string; args: string[] } {
  const argv = [spec.nodePath, spec.cliEntry, ...spec.args];
  return headless ? { command: conhost, args: ['--headless', ...argv] } : { command: spec.nodePath, args: argv.slice(1) };
}

const tag = (text: string, name: string): string | undefined => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return m ? unxml(m[1]!) : undefined;
};

/**
 * The scheduled task, as a UTF-16 XML document for `schtasks /create /xml`: runs at `userId`'s logon
 * only (LogonTrigger.UserId), as that user with an interactive token and least privilege (no UAC),
 * one instance, no time limit, restarted every minute on failure (999 times), not stopped on
 * battery, hidden. Exec: `%SystemRoot%\\System32\\conhost.exe --headless "<node>" "<bin.js>" agent --log-file "<log>"`
 * (`headless: false` → node.exe directly, for Windows builds whose conhost has no `--headless`).
 * The env and logs folder are kept in `Documentation` so `parseTaskXml` can read the spec back
 * (a task has no environment of its own: the agent inherits the user's).
 */
export function taskXml(spec: ServiceSpec, userId: string, o: { headless?: boolean; conhost?: string } = {}): string {
  assertDefinitionValues(spec, 'schtasks');
  if (/[\r\n]/.test(userId)) throw new Error('Cannot install the background agent: the Windows user name contains a line break.');
  const { command, args } = taskCommand(spec, o.headless ?? true, o.conhost);
  const doc = JSON.stringify({ uncage: 1, env: spec.env, logsDir: spec.logsDir });
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Uncage agent: connects this computer to the websites you approved. Remove with "uncage agent uninstall".</Description>
    <Documentation>${xml(doc)}</Documentation>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(command)}</Command>
      <Arguments>${xml(args.map(winQuote).join(' '))}</Arguments>
      <WorkingDirectory>${xml(spec.workingDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** argv (`conhost.exe --headless node entry …` or `node entry …`) → node, entry, args. */
function fromArgv(argv: string[]): { nodePath: string; cliEntry: string; args: string[] } | null {
  const rest = /(^|\\)conhost(\.exe)?$/i.test(argv[0] ?? '') && argv[1] === '--headless' ? argv.slice(2) : argv;
  if (rest.length < 2) return null;
  return { nodePath: rest[0]!, cliEntry: rest[1]!, args: rest.slice(2) };
}

/** Reads a spec back from a task document written by `taskXml` (null when it is not one). */
export function parseTaskXml(text: string): ServiceSpec | null {
  const t = text.replace(/^\uFEFF/, '');
  const command = tag(t, 'Command');
  const args = tag(t, 'Arguments');
  const workingDir = tag(t, 'WorkingDirectory');
  if (command === undefined || args === undefined) return null;
  const parsed = fromArgv([command, ...winSplit(args)]);
  if (!parsed) return null;
  let doc: { env?: { PATH?: string; HOME?: string }; logsDir?: string } = {};
  try {
    doc = JSON.parse(tag(t, 'Documentation') ?? '{}') as typeof doc;
  } catch {
    // not ours, or edited by hand
  }
  const logFile = parsed.args[parsed.args.indexOf('--log-file') + 1];
  const logsDir = doc.logsDir ?? (parsed.args.includes('--log-file') && logFile ? logFile.replace(/[\\/][^\\/]*$/, '') : '');
  return { ...parsed, env: { PATH: doc.env?.PATH ?? '', HOME: doc.env?.HOME ?? '' }, workingDir: workingDir ?? '', logsDir };
}

/** The Run-key value: the same command line as the task. */
export function runKeyCommand(spec: ServiceSpec, headless = true, conhost = conhostPath()): string {
  assertDefinitionValues(spec, 'schtasks');
  const { command, args } = taskCommand(spec, headless, conhost);
  return [winQuote(command), ...args.map(winQuote)].join(' ');
}

/** Rows of `schtasks /query /fo csv /v` → the `Status` of the first task row (e.g. `Running`, `Ready`). */
export function parseTaskCsvStatus(csv: string): string | null {
  const rows = csv
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => [...l.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"')));
  const header = rows[0];
  const row = rows.find((r, i) => i > 0 && r.join() !== header?.join());
  if (!header || !row) return null;
  const col = header.indexOf('Status');
  if (col >= 0) return row[col] ?? null;
  return row.includes('Running') ? 'Running' : null; // localized headers
}

const errText = (e: unknown): string => `${(e as { stderr?: string }).stderr ?? ''} ${(e as Error).message ?? ''}`;

/**
 * Whether `cmd` (a process command line) is this install's supervisor: argv[0] is the pinned Node
 * (or any `node.exe`), argv[1] is exactly the CLI entry, and `--supervise` is an argument after it.
 * Paths compare case-insensitively (Windows). A command line that merely mentions both strings
 * (`notepad "…\bin.js" --supervise`) does not match.
 */
export function isOwnSupervisorCommandLine(cmd: string, spec: Pick<ServiceSpec, 'nodePath' | 'cliEntry'>): boolean {
  const argv = winSplit(cmd.trim());
  const exe = (argv[0] ?? '').toLowerCase();
  const nodeOk = exe === spec.nodePath.toLowerCase() || /(^|[\\/])node\.exe$/.test(exe);
  return nodeOk && (argv[1] ?? '').toLowerCase() === spec.cliEntry.toLowerCase() && argv.slice(2).includes('--supervise');
}

/** The command line of process `pid` (PowerShell CIM): null when no such process; throws when the lookup fails. */
function defaultCommandLine(exec: ServiceDeps['exec']): (pid: number) => Promise<string | null> {
  return async (pid) => {
    const { stdout } = await exec('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${Math.trunc(pid)}").CommandLine`,
    ]);
    return stdout.trim() || null;
  };
}

function defaultSpawnDetached(file: string, args: string[]): number | undefined {
  const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => undefined);
  child.unref();
  return child.pid;
}

/**
 * Windows: a scheduled task `UncageAgent` for the current user (`schtasks /create /xml`). When Task
 * Scheduler answers "Access is denied" (some managed machines refuse standard users), the agent is
 * registered under `HKCU\…\Run` instead and started now, detached and hidden (the `--supervise`
 * process restarts a failed agent; the supervisor itself comes back at the next login).
 */
export function schtasksService(d: ServiceDeps): AgentService {
  const user = d.username ?? windowsUser(d.env);
  const build = d.windowsBuild ?? Number(release().split('.')[2]);
  const headless = !(build > 0 && build < HEADLESS_MIN_BUILD);
  const dir = join(d.home, '.uncage', 'service');
  const defPath = join(dir, `${TASK_NAME}.xml`);
  const conhost = conhostPath(d.env);
  const spawnDetached = d.spawnDetached ?? defaultSpawnDetached;
  let kind: ServiceKind = 'schtasks';
  const schtasks = (...args: string[]) => d.exec('schtasks', args);
  const ok = (p: Promise<unknown>): Promise<boolean> =>
    p.then(
      () => true,
      () => false,
    );

  const taskExists = () => ok(schtasks('/query', '/tn', TASK_NAME));
  const runValueExists = () => ok(d.exec('reg', ['query', RUN_KEY, '/v', TASK_NAME]));
  const commandLineOf = d.processCommandLine ?? defaultCommandLine(d.exec);
  /**
   * The `--supervise` process this install started, from `<logsDir>/supervisor.pid` (written by the
   * supervisor at every start). `owned` only when that pid's command line is exactly ours
   * (`isOwnSupervisorCommandLine`). A pid that is gone or belongs to something else: the stale file
   * is removed. When the lookup itself fails (`unknown`), the file is kept and nothing is killed.
   */
  const supervisorState = async (
    spec: ServiceSpec | null | undefined,
  ): Promise<{ state: 'none' | 'owned' | 'absent' | 'mismatch' | 'unknown'; pid?: number }> => {
    if (!spec?.logsDir) return { state: 'none' };
    const file = join(spec.logsDir, 'supervisor.pid');
    const n = Number((await readFile(file, 'utf8').catch(() => '')).trim());
    if (!Number.isInteger(n) || n <= 0) return { state: 'none' };
    let cmd: string | null;
    try {
      cmd = await commandLineOf(n);
    } catch {
      return { state: 'unknown', pid: n };
    }
    if (cmd !== null && isOwnSupervisorCommandLine(cmd, spec)) return { state: 'owned', pid: n };
    await rm(file, { force: true });
    return { state: cmd === null ? 'absent' : 'mismatch', pid: n };
  };
  /** Stops the supervised agent tree: ending a task only stops conhost, the node processes would survive. */
  const killStarted = async (spec?: ServiceSpec | null) => {
    const st = await supervisorState(spec);
    if (st.state !== 'owned') return;
    await d.exec('taskkill', ['/pid', String(st.pid), '/t', '/f']).catch(() => undefined);
    await rm(join(spec!.logsDir, 'supervisor.pid'), { force: true });
  };
  /** The Run-key start: the same `--supervise` command line as the task, detached and hidden. */
  const startDetached = (spec: ServiceSpec) => {
    const { command, args } = taskCommand(spec, headless, conhost);
    spawnDetached(command, args);
  };
  const readSpec = async (): Promise<ServiceSpec | null> => {
    const raw = await readFile(defPath).catch(() => null);
    if (!raw) return null;
    const text = raw[0] === 0xff && raw[1] === 0xfe ? raw.subarray(2).toString('utf16le') : raw.toString('utf8');
    return parseTaskXml(text);
  };

  return {
    get kind() {
      return kind;
    },
    async install(spec) {
      assertDefinitionValues(spec, 'schtasks');
      const previous = await readSpec();
      await mkdir(spec.logsDir, { recursive: true });
      await mkdir(dir, { recursive: true });
      // schtasks reads the file as UTF-16 (BOM) like the document declares.
      await writeFile(defPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml(spec, user, { headless, conhost }), 'utf16le')]));
      try {
        await schtasks('/create', '/tn', TASK_NAME, '/xml', defPath, '/f');
      } catch (e) {
        if (!/access is denied/i.test(errText(e))) {
          throw new Error(`schtasks /create failed: ${errText(e).trim()}`, { cause: e });
        }
        kind = 'run-key';
        await d.exec('reg', ['add', RUN_KEY, '/v', TASK_NAME, '/t', 'REG_SZ', '/d', runKeyCommand(spec, headless, conhost), '/f']);
        await killStarted(previous);
        startDetached(spec);
        return {
          definitionPath: `${RUN_KEY}\\${TASK_NAME}`,
          notes: [
            'Task Scheduler refused to register the task (Access is denied), so the agent starts at login from',
            `${RUN_KEY} instead (its supervisor restarts it if it fails; if it stops, run "uncage agent install" again).`,
          ],
        };
      }
      kind = 'schtasks';
      // A Run-key registration from an earlier, refused install is replaced by the task.
      await d.exec('reg', ['delete', RUN_KEY, '/v', TASK_NAME, '/f']).catch(() => undefined);
      await schtasks('/end', '/tn', TASK_NAME).catch(() => undefined);
      await killStarted(previous);
      await schtasks('/run', '/tn', TASK_NAME);
      return { definitionPath: defPath, notes: [] };
    },
    async uninstall() {
      const spec = await readSpec();
      await schtasks('/end', '/tn', TASK_NAME).catch(() => undefined);
      const task = await ok(schtasks('/delete', '/tn', TASK_NAME, '/f'));
      const run = await ok(d.exec('reg', ['delete', RUN_KEY, '/v', TASK_NAME, '/f']));
      await killStarted(spec);
      await rm(defPath, { force: true });
      return { removed: task || run };
    },
    async restart() {
      const spec = await readSpec();
      if (await taskExists()) {
        await schtasks('/end', '/tn', TASK_NAME).catch(() => undefined);
        await killStarted(spec);
        return ok(schtasks('/run', '/tn', TASK_NAME));
      }
      if (spec && (await runValueExists())) {
        await killStarted(spec);
        startDetached(spec);
        return true;
      }
      return false;
    },
    async status(): Promise<ServiceStatus> {
      let installed = false;
      let running: boolean | null = false;
      let detail: string | undefined;
      try {
        const { stdout } = await schtasks('/query', '/tn', TASK_NAME, '/fo', 'csv', '/v');
        kind = 'schtasks';
        installed = true;
        const st = parseTaskCsvStatus(stdout);
        running = st === null ? null : st === 'Running';
        if (st && st !== 'Running') detail = st;
      } catch {
        if (await runValueExists()) {
          kind = 'run-key';
          installed = true;
          const st = await supervisorState(await readSpec());
          running = st.state === 'owned' ? true : st.state === 'unknown' ? null : false;
          if (st.state === 'unknown') detail = 'could not check the agent process';
        }
      }
      const spec = installed ? await readSpec() : null;
      const node = spec ? await probeNode(d.exec, spec.nodePath) : { nodeExists: null, nodeVersion: null };
      return {
        kind,
        installed,
        running: installed ? running : false,
        spec,
        ...node,
        definitionPath: installed ? (kind === 'run-key' ? `${RUN_KEY}\\${TASK_NAME}` : defPath) : null,
        ...(detail ? { detail } : {}),
      };
    },
  };
}
