import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { release } from 'node:os';
import { join } from 'node:path';
import { windowsUser } from '@uncage/agent';
import { probeNode } from './spec.js';
import type { AgentService, ServiceDeps, ServiceKind, ServiceSpec, ServiceStatus } from './types.js';

export const TASK_NAME = 'UncageAgent';
export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const CONHOST = 'conhost.exe';
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
export function taskCommand(spec: ServiceSpec, headless = true): { command: string; args: string[] } {
  const argv = [spec.nodePath, spec.cliEntry, ...spec.args];
  return headless ? { command: CONHOST, args: ['--headless', ...argv] } : { command: spec.nodePath, args: argv.slice(1) };
}

const tag = (text: string, name: string): string | undefined => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return m ? unxml(m[1]!) : undefined;
};

/**
 * The scheduled task, as a UTF-16 XML document for `schtasks /create /xml`: runs at `userId`'s logon
 * only (LogonTrigger.UserId), as that user with an interactive token and least privilege (no UAC),
 * one instance, no time limit, restarted every minute on failure (999 times), not stopped on
 * battery, hidden. Exec: `conhost.exe --headless "<node>" "<bin.js>" agent --log-file "<log>"`
 * (`headless: false` → node.exe directly, for Windows builds whose conhost has no `--headless`).
 * The env and logs folder are kept in `Documentation` so `parseTaskXml` can read the spec back
 * (a task has no environment of its own: the agent inherits the user's).
 */
export function taskXml(spec: ServiceSpec, userId: string, o: { headless?: boolean } = {}): string {
  const { command, args } = taskCommand(spec, o.headless ?? true);
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
export function runKeyCommand(spec: ServiceSpec, headless = true): string {
  const { command, args } = taskCommand(spec, headless);
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

function defaultSpawnDetached(file: string, args: string[]): number | undefined {
  const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => undefined);
  child.unref();
  return child.pid;
}

/**
 * Windows: a scheduled task `UncageAgent` for the current user (`schtasks /create /xml`). When Task
 * Scheduler answers "Access is denied" (some managed machines refuse standard users), the agent is
 * registered under `HKCU\…\Run` instead and started now, detached and hidden (no restart on failure
 * there: it comes back at the next login or `uncage agent install`).
 */
export function schtasksService(d: ServiceDeps): AgentService {
  const user = d.username ?? windowsUser(d.env);
  const build = d.windowsBuild ?? Number(release().split('.')[2]);
  const headless = !(build > 0 && build < HEADLESS_MIN_BUILD);
  const dir = join(d.home, '.uncage', 'service');
  const defPath = join(dir, `${TASK_NAME}.xml`);
  const pidPath = join(dir, 'agent.pid');
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
  const readPid = async (): Promise<number | null> => {
    const n = Number((await readFile(pidPath, 'utf8').catch(() => '')).trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const killStarted = async () => {
    const pid = await readPid();
    if (pid !== null) await d.exec('taskkill', ['/pid', String(pid), '/t', '/f']).catch(() => undefined);
    await rm(pidPath, { force: true });
  };
  const startDetached = async (spec: ServiceSpec) => {
    const { command, args } = taskCommand(spec, headless);
    const pid = spawnDetached(command, args);
    if (pid) await writeFile(pidPath, `${pid}\n`);
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
      await mkdir(spec.logsDir, { recursive: true });
      await mkdir(dir, { recursive: true });
      // schtasks reads the file as UTF-16 (BOM) like the document declares.
      await writeFile(defPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml(spec, user, { headless }), 'utf16le')]));
      try {
        await schtasks('/create', '/tn', TASK_NAME, '/xml', defPath, '/f');
      } catch (e) {
        if (!/access is denied/i.test(errText(e))) {
          throw new Error(`schtasks /create failed: ${errText(e).trim()}`, { cause: e });
        }
        kind = 'run-key';
        await d.exec('reg', ['add', RUN_KEY, '/v', TASK_NAME, '/t', 'REG_SZ', '/d', runKeyCommand(spec, headless), '/f']);
        await killStarted();
        await startDetached(spec);
        return {
          definitionPath: `${RUN_KEY}\\${TASK_NAME}`,
          notes: [
            'Task Scheduler refused to register the task (Access is denied), so the agent starts at login from',
            `${RUN_KEY} instead. It is not restarted automatically if it stops: run "uncage agent install" again.`,
          ],
        };
      }
      kind = 'schtasks';
      // A Run-key registration from an earlier, refused install is replaced by the task.
      await d.exec('reg', ['delete', RUN_KEY, '/v', TASK_NAME, '/f']).catch(() => undefined);
      await killStarted();
      await schtasks('/end', '/tn', TASK_NAME).catch(() => undefined);
      await schtasks('/run', '/tn', TASK_NAME);
      return { definitionPath: defPath, notes: [] };
    },
    async uninstall() {
      await schtasks('/end', '/tn', TASK_NAME).catch(() => undefined);
      const task = await ok(schtasks('/delete', '/tn', TASK_NAME, '/f'));
      const run = await ok(d.exec('reg', ['delete', RUN_KEY, '/v', TASK_NAME, '/f']));
      await killStarted();
      await rm(defPath, { force: true });
      return { removed: task || run };
    },
    async restart() {
      if (await taskExists()) {
        await schtasks('/end', '/tn', TASK_NAME).catch(() => undefined);
        return ok(schtasks('/run', '/tn', TASK_NAME));
      }
      const spec = await readSpec();
      if (spec && (await runValueExists())) {
        await killStarted();
        await startDetached(spec);
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
          const pid = await readPid();
          running = pid === null ? null : processAlive(pid);
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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
