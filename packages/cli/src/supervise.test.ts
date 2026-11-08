import { describe, expect, it, vi } from 'vitest';
import { SUPERVISOR_PID_ENV, superviseAgent, watchSupervisor, type SupervisedChild } from './supervise.js';

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
});
