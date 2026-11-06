import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RuntimeProbe } from '@uncage/protocol';
import type { AccountReadParams, AccountReadResult } from './protocol.js';

export type ExecFile = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

export const INSTALL_URL = 'https://developers.openai.com/codex';

const defaultExecFile: ExecFile = (cmd, args) => promisify(nodeExecFile)(cmd, args, { timeout: 10_000 });

/**
 * 1. `<executable> --version`; ENOENT → not_installed.
 * 2. `account/read` on the app-server; no account while OpenAI auth is required → auth_required.
 */
export async function probeCodex(
  executable: string,
  execFile: ExecFile = defaultExecFile,
  accountRead: (params: AccountReadParams) => Promise<AccountReadResult>,
): Promise<RuntimeProbe> {
  let version: string | undefined;
  try {
    const { stdout } = await execFile(executable, ['--version']);
    version = /\d+\.\d+\.\d+\S*/.exec(stdout)?.[0];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        status: 'not_installed',
        message: 'Codex CLI was not found.',
        hint: 'npm i -g @openai/codex && codex login',
        installUrl: INSTALL_URL,
      };
    }
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
  const v = version ? { version } : {};
  try {
    const { account, requiresOpenaiAuth } = await accountRead({ refreshToken: false });
    if (account === null && requiresOpenaiAuth) {
      return { status: 'auth_required', ...v, message: 'Codex is not logged in.', hint: 'codex login' };
    }
    return { status: 'available', ...v };
  } catch (err) {
    return { status: 'error', ...v, message: err instanceof Error ? err.message : String(err) };
  }
}
