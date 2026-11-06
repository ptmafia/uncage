import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RuntimeProbe } from '@uncage/protocol';

export type ExecFile = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

export const INSTALL_URL = 'https://docs.claude.com/en/docs/claude-code/setup';

const defaultExecFile: ExecFile = (cmd, args) => promisify(nodeExecFile)(cmd, args, { timeout: 10_000 });

/** Runs `claude --version`. Login can't be checked without spending tokens, so it is deferred to the first run. */
export async function probeClaude(executable = 'claude', execFile: ExecFile = defaultExecFile): Promise<RuntimeProbe> {
  try {
    const { stdout } = await execFile(executable, ['--version']);
    const version = /\d+\.\d+\.\d+\S*/.exec(stdout)?.[0];
    return { status: 'available', ...(version ? { version } : {}), message: 'Login is checked on first run' };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        status: 'not_installed',
        message: 'Claude Code CLI was not found.',
        hint: 'Install Claude Code and make sure `claude` is on your PATH.',
        installUrl: INSTALL_URL,
      };
    }
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}
