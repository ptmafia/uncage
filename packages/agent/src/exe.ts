import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { findCommand, resolveCommand, UnsafeCommandError, type ResolveOptions } from '@uncage/protocol/node';

// One implementation for every package (`@uncage/protocol/node`): re-exported here for the CLI.
export {
  findCommand,
  parseNpmCmdShim,
  resolveCommand,
  UnsafeCommandError,
  type ResolvedCommand,
  type ResolveOptions,
} from '@uncage/protocol/node';

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function isExecutable(p: string): Promise<boolean> {
  if (!(await isFile(p))) return false;
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The command that opens `url` in the default browser: `open` · `xdg-open` · `rundll32 url.dll,FileProtocolHandler`. */
export function openUrlCommand(url: string, platform: NodeJS.Platform): [string, string[]] {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}

const UPGRADE_ARGS = ['i', '-g', '@uncage/cli@latest'];

/**
 * The self-upgrade command (`npm i -g @uncage/cli@latest`), resolved for the Node running this
 * process so the upgrade lands where this CLI was installed. Windows: always `node npm-cli.js …`,
 * never `npm.cmd` (cmd.exe mangles arguments, and `.cmd` cannot be started without a shell).
 */
export async function selfUpgradeCommand(o: ResolveOptions = {}): Promise<[string, string[]]> {
  const platform = o.platform ?? process.platform;
  const execPath = o.execPath ?? process.execPath;
  const nodeDir = dirname(execPath);
  if (platform === 'win32') {
    const besideNode = join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (await isFile(besideNode)) return [execPath, [besideNode, ...UPGRADE_ARGS]];
    // npm.cmd is not a cmd-shim: run the npm-cli.js beside it with our Node.
    const env = o.env ?? process.env;
    const npmCmd = await findCommand('npm', { platform, env });
    if (npmCmd) {
      const cli = join(dirname(npmCmd), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (await isFile(cli)) return [execPath, [cli, ...UPGRADE_ARGS]];
      const r = await resolveCommand(npmCmd, UPGRADE_ARGS, { platform, env, execPath }).catch((e: unknown) => {
        if (e instanceof UnsafeCommandError) return null;
        throw e;
      });
      if (r) return [r.file, r.args];
    }
    return ['npm', UPGRADE_ARGS];
  }
  const besideNode = join(nodeDir, 'npm');
  if (await isExecutable(besideNode)) return [besideNode, UPGRADE_ARGS];
  const r = await resolveCommand('npm', UPGRADE_ARGS, { ...o, platform });
  return r ? [r.file, r.args] : ['npm', UPGRADE_ARGS];
}
