import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { MAX_LOG_BYTES, rotateLog, SUPERVISOR_PID_ENV, superviseAgent, watchSupervisor, type SupervisedChild } from './supervise.js';

/** Children that exit with the given codes, in order. */
function scripted(codes: Array<number | null>) {
  const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const start = (file: string, args: string[], env: NodeJS.ProcessEnv): SupervisedChild => {
    calls.push({ file, args, env });
    return { exited: Promise.resolve(codes.length > 0 ? codes.shift()! : 0), kill: () => undefined };
  };
  return { calls, start };
}

describe('superviseAgent (the Windows service restarts the agent itself)', () => {
  it('restarts after a failure (10 s) or a self-upgrade exit 75 (1 s); a clean exit ends it with 0', async () => {
    const s = scripted([1, 75, null, 0]);
    const sleep = vi.fn(async () => undefined);
    const code = await superviseAgent({ execPath: '/n/node', entry: '/c/bin.js', args: ['agent', '--log-file', '/l/agent.log'], start: s.start, sleep });
    expect(code).toBe(0);
    expect(s.calls).toHaveLength(4);
    expect(s.calls[0]).toMatchObject({ file: '/n/node', args: ['/c/bin.js', 'agent', '--log-file', '/l/agent.log'] });
    expect(s.calls[0]!.env[SUPERVISOR_PID_ENV]).toBe(String(process.pid));
    expect(sleep.mock.calls).toEqual([[10_000], [1_000], [10_000]]);
  });

  it('writes supervisor.pid beside the log while it runs and removes it at the end', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uncage-sup-'));
    let seen = '';
    const start = (): SupervisedChild => ({ exited: readFile(join(dir, 'supervisor.pid'), 'utf8').then((t) => ((seen = t), 0)), kill: () => undefined });
    expect(await superviseAgent({ execPath: 'n', entry: 'e', args: [], logFile: join(dir, 'agent.log'), start })).toBe(0);
    expect(seen.trim()).toBe(String(process.pid));
    await expect(readFile(join(dir, 'supervisor.pid'))).rejects.toThrow();
    await rm(dir, { recursive: true, force: true });
  });

  it('stops (0) when asked, killing the child', async () => {
    let release!: (c: number | null) => void;
    const kill = vi.fn(() => release(null));
    let stop!: () => void;
    const stopSignal = new Promise<void>((r) => (stop = r));
    const running = superviseAgent({
      execPath: 'n',
      entry: 'e',
      args: [],
      stopSignal,
      start: () => ({ exited: new Promise((r) => (release = r)), kill }),
    });
    await new Promise((r) => setTimeout(r, 10));
    stop();
    expect(await running).toBe(0);
    expect(kill).toHaveBeenCalledOnce();
  });

  it('the agent child exits once its supervisor is gone', async () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      watchSupervisor({ [SUPERVISOR_PID_ENV]: '999999999' }, exit);
      watchSupervisor({}, exit); // not supervised: nothing to watch
      vi.advanceTimersByTime(1_100);
      expect(exit).toHaveBeenCalledWith(0);
      expect(exit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("appends the agent's stdout and stderr to agent.err.log (a crash before the logger starts is kept)", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uncage-sup-'));
    const marker = join(dir, 'ran-once');
    // First run: prints to both streams and crashes; second run: exits cleanly.
    const code = `const fs=require('fs');if(!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'');console.log('starting');console.error('Error: Cannot find module x');process.exit(3)}process.exit(0)`;
    expect(await superviseAgent({ execPath: process.execPath, entry: '-e', args: [code], logFile: join(dir, 'agent.log'), restartDelayMs: 10 })).toBe(0);
    const err = await readFile(join(dir, 'agent.err.log'), 'utf8');
    expect(err).toContain('starting');
    expect(err).toContain('Error: Cannot find module x');
    expect(await readFile(join(dir, 'agent.log'), 'utf8')).toContain('agent exited with 3; restarting in 10 ms');
    await rm(dir, { recursive: true, force: true });
  });
});

describe('rotateLog', () => {
  it('over the cap: copied to .1 (replacing the older one) and truncated in place; small or missing files are left alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uncage-rot-'));
    const f = join(dir, 'agent.log');
    expect(await rotateLog(f)).toBe(false);
    await writeFile(f, 'small');
    expect(await rotateLog(f)).toBe(false);
    await writeFile(`${f}.1`, 'older');
    await writeFile(f, 'x'.repeat(2048));
    expect(await rotateLog(f, 1024)).toBe(true);
    expect((await readFile(`${f}.1`, 'utf8')).length).toBe(2048);
    expect(await readFile(f, 'utf8')).toBe('');
    expect(MAX_LOG_BYTES).toBe(10 * 1024 * 1024);
    await rm(dir, { recursive: true, force: true });
  });
});
