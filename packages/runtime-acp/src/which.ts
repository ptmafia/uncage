import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';

/** Resolves a command on PATH (absolute path or null). */
export type Which = (cmd: string) => Promise<string | null>;

async function executable(path: string, windows: boolean): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    if (!windows) await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * A `which` over `env.PATH` (Windows: also every `PATHEXT` extension). A command with a path
 * separator is checked as is (absolute) and never searched.
 */
export function createWhich(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Which {
  const windows = platform === 'win32';
  const sep = windows ? ';' : delimiter;
  return async (cmd) => {
    if (!cmd) return null;
    if (cmd.includes('/') || (windows && cmd.includes('\\'))) return isAbsolute(cmd) && (await executable(cmd, windows)) ? cmd : null;
    const dirs = (env.PATH ?? env.Path ?? '').split(sep).filter(Boolean);
    const exts = windows ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = join(dir, cmd + ext);
        if (await executable(candidate, windows)) return candidate;
      }
    }
    return null;
  };
}
