import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecFn } from '@uncage/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { conhostPath, parseTaskCsvStatus, parseTaskXml, RUN_KEY, runKeyCommand, schtasksService, TASK_NAME, taskXml, winQuote, winSplit } from './schtasks.js';
import type { ServiceSpec } from './types.js';

const cleanups: string[] = [];
afterEach(async () => {
  for (const d of cleanups.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tmpHome(): Promise<string> {
  const h = await mkdtemp(join(tmpdir(), 'uncage-schtasks-'));
  cleanups.push(h);
  return h;
}
const winSpec: ServiceSpec = {
  nodePath: 'C:\\Users\\u\\AppData\\Roaming\\fnm\\node-versions\\v22.23.4\\installation\\node.exe',
  cliEntry: 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@uncage\\cli\\dist\\bin.js',
  args: ['agent', '--supervise', '--log-file', 'C:\\Users\\u\\.uncage\\logs\\agent.log'],
  env: { PATH: 'C:\\Windows\\system32', HOME: 'C:\\Users\\u' },
  workingDir: 'C:\\Users\\u',
  logsDir: 'C:\\Users\\u\\.uncage\\logs',
};
/** A spec whose folders exist on this machine (install creates logsDir). */
const localSpec = (home: string): ServiceSpec => ({ ...winSpec, logsDir: join(home, '.uncage', 'logs'), workingDir: home });
const ok = (stdout = '') => ({ stdout, stderr: '' });
const CSV_RUNNING =
  '"HostName","TaskName","Next Run Time","Status","Logon Mode"\r\n"PC","\\UncageAgent","N/A","Running","Interactive only"\r\n';

describe('schtasks task XML', () => {
  it('schtasks XML: LeastPrivilege, InteractiveToken, RestartOnFailure, current user only', () => {
    const xml = taskXml(winSpec, 'PC\\u');
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>')).toBe(true);
    expect(xml).toMatch(/<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>PC\\u<\/UserId>\s*<\/LogonTrigger>/);
    expect(xml).toMatch(/<Principal id="Author">\s*<UserId>PC\\u<\/UserId>\s*<LogonType>InteractiveToken<\/LogonType>\s*<RunLevel>LeastPrivilege<\/RunLevel>/);
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(xml).toMatch(/<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>999<\/Count>\s*<\/RestartOnFailure>/);
    expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
    expect(xml).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
    expect(xml).toContain('<Hidden>true</Hidden>');
    expect(xml).toContain('<Command>C:\\Windows\\System32\\conhost.exe</Command>');
    expect(taskXml(winSpec, 'PC\\u', { conhost: 'D:\\Win\\System32\\conhost.exe' })).toContain('<Command>D:\\Win\\System32\\conhost.exe</Command>');
    expect(conhostPath({ SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\conhost.exe');
    expect(xml).toContain(
      `<Arguments>--headless "${winSpec.nodePath}" "${winSpec.cliEntry}" agent --supervise --log-file "C:\\Users\\u\\.uncage\\logs\\agent.log"</Arguments>`,
    );
    expect(xml).not.toMatch(/HighestAvailable|<GroupId>|S4U|Password/);
    // Windows builds whose conhost has no --headless run node.exe directly.
    const direct = taskXml(winSpec, 'PC\\u', { headless: false });
    expect(direct).toContain(`<Command>${winSpec.nodePath}</Command>`);
    expect(parseTaskXml(direct)).toEqual(winSpec);
    expect(parseTaskXml('<Task/>')).toBeNull();
  });

  it('quotes Windows command lines like the MSVC runtime parses them', () => {
    for (const a of ['plain', 'with space', 'C:\\dir\\', 'say "hi"', 'a\\\\"b', '', '100%']) expect(winSplit(winQuote(a))).toEqual([a]);
    expect(winSplit('conhost.exe --headless "C:\\a b\\node.exe" x')).toEqual(['conhost.exe', '--headless', 'C:\\a b\\node.exe', 'x']);
    expect(parseTaskXml(taskXml(winSpec, 'PC\\u'))).toEqual(winSpec);
    expect(runKeyCommand(winSpec)).toBe(`"C:\\Windows\\System32\\conhost.exe" --headless "${winSpec.nodePath}" "${winSpec.cliEntry}" agent --supervise --log-file "${winSpec.args[3]}"`);
    expect(parseTaskCsvStatus(CSV_RUNNING)).toBe('Running');
    expect(parseTaskCsvStatus(CSV_RUNNING.replace('"Running"', '"Ready"'))).toBe('Ready');
    expect(parseTaskCsvStatus('')).toBeNull();
  });
});

describe('schtasks service', () => {
  it('install: /create /xml (UTF-16 file) then /end + /run; status reads it back; uninstall: /end, /delete', async () => {
    const home = await tmpHome();
    let created = false;
    const exec = vi.fn<ExecFn>(async (file, args) => {
      if (file === 'schtasks' && args[0] === '/create') created = true;
      if (file === 'schtasks' && args[0] === '/query') {
        if (!created) throw Object.assign(new Error('ERROR: The system cannot find the file specified.'), { code: 1 });
        return ok(CSV_RUNNING);
      }
      if (file === 'reg' && args[0] !== 'add') throw Object.assign(new Error('ERROR: The system was unable to find the specified registry key or value.'), { code: 1 });
      if (file === 'schtasks' && args[0] === '/delete') created = false;
      return ok();
    });
    const s = localSpec(home);
    const processCommandLine = vi.fn(async (pid: number) => (pid === 5150 ? `"${s.nodePath}" "${s.cliEntry}" agent --supervise --log-file "x"` : null));
    const svc = schtasksService({ platform: 'win32', home, env: {}, exec, username: 'PC\\u', windowsBuild: 22631, processCommandLine });
    expect(svc.kind).toBe('schtasks');
    const def = join(home, '.uncage', 'service', 'UncageAgent.xml');
    expect(await svc.install(s)).toEqual({ definitionPath: def, notes: [] });
    const calls = exec.mock.calls.filter(([f]) => f === 'schtasks');
    expect(calls).toEqual([
      ['schtasks', ['/create', '/tn', TASK_NAME, '/xml', def, '/f']],
      ['schtasks', ['/end', '/tn', TASK_NAME]],
      ['schtasks', ['/run', '/tn', TASK_NAME]],
    ]);
    const raw = await readFile(def);
    expect([raw[0], raw[1]]).toEqual([0xff, 0xfe]); // UTF-16LE BOM, as the document declares
    expect(parseTaskXml(raw.subarray(2).toString('utf16le'))).toEqual(s);
    expect((await stat(s.logsDir)).isDirectory()).toBe(true);

    expect(await svc.status()).toMatchObject({ kind: 'schtasks', installed: true, running: true, spec: s, definitionPath: def, nodeExists: false });
    exec.mockClear();
    expect(await svc.restart()).toBe(true);
    expect(exec.mock.calls.filter(([f]) => f === 'schtasks').map(([, a]) => a[0])).toEqual(['/query', '/end', '/run']);

    // The `--supervise` process tree survives /end (only conhost stops): uninstall kills it by its pid
    // file, once the pid's command line proves it is ours.
    await writeFile(join(s.logsDir, 'supervisor.pid'), '5150\n');
    exec.mockClear();
    expect(await svc.uninstall()).toEqual({ removed: true });
    expect(exec.mock.calls).toEqual([
      ['schtasks', ['/end', '/tn', TASK_NAME]],
      ['schtasks', ['/delete', '/tn', TASK_NAME, '/f']],
      ['reg', ['delete', RUN_KEY, '/v', TASK_NAME, '/f']],
      ['taskkill', ['/pid', '5150', '/t', '/f']],
    ]);
    expect(processCommandLine).toHaveBeenCalledWith(5150);
    await expect(stat(join(s.logsDir, 'supervisor.pid'))).rejects.toThrow();
    await expect(stat(def)).rejects.toThrow();
    expect(await svc.status()).toMatchObject({ installed: false, running: false, spec: null });
  });

  it('Access is denied → run-key fallback: reg add HKCU…\\Run, started now detached and hidden', async () => {
    const home = await tmpHome();
    let runValue: string | null = null;
    const exec = vi.fn<ExecFn>(async (file, args) => {
      if (file === 'schtasks' && args[0] === '/create') {
        throw Object.assign(new Error('Command failed: schtasks /create'), { stderr: 'ERROR: Access is denied.\r\n', code: 1 });
      }
      if (file === 'schtasks') throw Object.assign(new Error('ERROR: The system cannot find the file specified.'), { code: 1 });
      if (file === 'reg' && args[0] === 'add') runValue = args[args.indexOf('/d') + 1]!;
      if (file === 'reg' && args[0] === 'query' && runValue === null) throw new Error('not found');
      if (file === 'reg' && args[0] === 'delete') runValue = null;
      return ok();
    });
    const s = localSpec(home);
    // The supervisor writes its own pid file once it runs.
    const spawnDetached = vi.fn(() => {
      void writeFile(join(s.logsDir, 'supervisor.pid'), '4242\n');
      return 4242;
    });
    const processCommandLine = async (pid: number) => (pid === 4242 ? `node "${s.cliEntry}" agent --supervise` : null);
    const svc = schtasksService({ platform: 'win32', home, env: { SystemRoot: 'C:\\Windows' }, exec, username: 'PC\\u', windowsBuild: 22631, spawnDetached, processCommandLine });
    const r = await svc.install(s);
    expect(svc.kind).toBe('run-key');
    expect(r.definitionPath).toBe(`${RUN_KEY}\\UncageAgent`);
    expect(r.notes.join(' ')).toMatch(/Access is denied/);
    expect(exec).toHaveBeenCalledWith('reg', ['add', RUN_KEY, '/v', 'UncageAgent', '/t', 'REG_SZ', '/d', runKeyCommand(s), '/f']);
    expect(spawnDetached).toHaveBeenCalledWith('C:\\Windows\\System32\\conhost.exe', ['--headless', s.nodePath, s.cliEntry, ...s.args]);
    expect(s.args).toContain('--supervise'); // the Run-key start goes through the supervisor too
    await new Promise((r) => setTimeout(r, 20));
    expect(await svc.status()).toMatchObject({ kind: 'run-key', installed: true, running: true, spec: s });

    exec.mockClear();
    expect(await svc.uninstall()).toEqual({ removed: true });
    expect(exec).toHaveBeenCalledWith('taskkill', ['/pid', '4242', '/t', '/f']);
    expect(runValue).toBeNull();
  });

  it('other schtasks errors are reported, not hidden behind the fallback', async () => {
    const home = await tmpHome();
    const exec = vi.fn<ExecFn>(async (file, args) => {
      if (file === 'schtasks' && args[0] === '/create') throw Object.assign(new Error('x'), { stderr: 'ERROR: The task XML is malformed.' });
      return ok();
    });
    const svc = schtasksService({ platform: 'win32', home, env: {}, exec, username: 'PC\\u', windowsBuild: 22631 });
    await expect(svc.install(localSpec(home))).rejects.toThrow(/malformed/);
    expect(exec).not.toHaveBeenCalledWith('reg', expect.arrayContaining(['add']));
  });

  it('old Windows builds (no conhost --headless) start node.exe directly', async () => {
    const home = await tmpHome();
    const exec = vi.fn<ExecFn>(async () => ok());
    await schtasksService({ platform: 'win32', home, env: {}, exec, username: 'PC\\u', windowsBuild: 17134 }).install(localSpec(home));
    const raw = await readFile(join(home, '.uncage', 'service', 'UncageAgent.xml'));
    expect(raw.subarray(2).toString('utf16le')).toContain(`<Command>${winSpec.nodePath}</Command>`);
  });

  it('a stale supervisor.pid (the pid now belongs to another program) is removed, never killed', async () => {
    const home = await tmpHome();
    const exec = vi.fn<ExecFn>(async () => ok());
    const s = localSpec(home);
    const svc = schtasksService({
      platform: 'win32',
      home,
      env: {},
      exec,
      username: 'PC\\u',
      windowsBuild: 22631,
      processCommandLine: async (pid) => (pid === 777 ? '"C:\\Program Files\\Editor\\editor.exe" --restore' : null),
    });
    await svc.install(s);
    for (const pid of ['777', '888']) {
      // 777: reused by another program; 888: no such process.
      await writeFile(join(s.logsDir, 'supervisor.pid'), `${pid}\n`);
      exec.mockClear();
      expect(await svc.restart()).toBe(true);
      expect(exec.mock.calls.some(([f]) => f === 'taskkill')).toBe(false);
      await expect(stat(join(s.logsDir, 'supervisor.pid'))).rejects.toThrow();
    }
    // Our CLI entry but not the supervisor (e.g. a foreground `uncage agent`): not killed either.
    const fg = schtasksService({ platform: 'win32', home, env: {}, exec, username: 'PC\\u', windowsBuild: 22631, processCommandLine: async () => `node "${s.cliEntry}" agent` });
    await writeFile(join(s.logsDir, 'supervisor.pid'), '999\n');
    exec.mockClear();
    await fg.uninstall();
    expect(exec.mock.calls.some(([f]) => f === 'taskkill')).toBe(false);
  });

  it('refuses % in the program, arguments or working folder (Task Scheduler expands it) and line breaks anywhere', async () => {
    const home = await tmpHome();
    const exec = vi.fn<ExecFn>(async () => ok());
    const svc = schtasksService({ platform: 'win32', home, env: {}, exec, username: 'PC\\u', windowsBuild: 22631 });
    await expect(svc.install({ ...localSpec(home), cliEntry: 'C:\\100%\\bin.js' })).rejects.toThrow(/contains "%".*Task Scheduler/);
    await expect(svc.install({ ...localSpec(home), workingDir: 'C:\\%USERPROFILE%' })).rejects.toThrow(/working folder contains "%"/);
    expect(exec).not.toHaveBeenCalled();
    expect(() => taskXml({ ...winSpec, nodePath: 'C:\\node\n<Exec>' }, 'PC\\u')).toThrow(/line break/);
    expect(() => taskXml(winSpec, 'PC\\u\r\n')).toThrow(/line break/);
    // % in the PATH kept in <Documentation> is fine: it is never expanded.
    expect(() => taskXml({ ...winSpec, env: { ...winSpec.env, PATH: 'C:\\100%\\bin' } }, 'PC\\u')).not.toThrow();
  });
});
