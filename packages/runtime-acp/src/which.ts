import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, win32 } from 'node:path';

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

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * A `which` over `env.PATH`. On Windows only names with a `PATHEXT` extension are found (as
 * `CreateProcess` would), never an extensionless file. A command with a path separator is checked
 * as is (absolute only) and never searched.
 */
export function createWhich(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Which {
  const windows = platform === 'win32';
  const sep = windows ? ';' : delimiter;
  const exts = windows ? (env.PATHEXT ?? DEFAULT_PATHEXT).split(';').filter((e) => /^\.[A-Za-z0-9]+$/.test(e)) : [''];
  const hasExt = (cmd: string): boolean => exts.some((e) => cmd.toLowerCase().endsWith(e.toLowerCase()));
  return async (cmd) => {
    if (!cmd) return null;
    const hasSep = cmd.includes('/') || (windows && cmd.includes('\\'));
    if (hasSep) {
      if (!windows) return isAbsolute(cmd) && (await executable(cmd, false)) ? cmd : null;
      if (!win32.isAbsolute(cmd) && !isAbsolute(cmd)) return null;
      const names = hasExt(cmd) ? [cmd] : exts.map((e) => cmd + e);
      for (const name of names) if (await executable(name, true)) return name;
      return null;
    }
    const dirs = (env.PATH ?? env.Path ?? '').split(sep).filter(Boolean);
    const names = windows ? (hasExt(cmd) ? [cmd] : exts.map((e) => cmd + e)) : [cmd];
    for (const dir of dirs) {
      for (const name of names) {
        const candidate = join(dir, name);
        if (await executable(candidate, windows)) return candidate;
      }
    }
    return null;
  };
}

/** The script an npm `.cmd` shim runs (`"%dp0%\node_modules\pkg\bin.js" %*`), resolved next to the shim. */
async function npmShimScript(shim: string): Promise<string | undefined> {
  const text = await readFile(shim, 'utf8').catch(() => '');
  if (text.length > 16 * 1024) return undefined;
  const m = /"%~?dp0%?\\([^"%\r\n]+\.(?:js|cjs|mjs))"/i.exec(text);
  if (!m || m[1]!.split(/[\\/]/).includes('..')) return undefined;
  const script = join(dirname(shim), ...m[1]!.split(/[\\/]/));
  return (await executable(script, true)) ? script : undefined;
}

/** Characters cmd.exe interprets even inside quotes (variables, escapes) or that end a quoted arg. */
const CMD_UNSAFE = /["%!^\r\n\0]/;

/**
 * One cmd.exe command line from argv, for `cmd.exe /d /s /c "<line>"`: every argument quoted.
 * Undefined when an argument holds characters that cannot be quoted safely for cmd.exe.
 */
export function cmdLine(argv: string[]): string | undefined {
  if (argv.some((a) => CMD_UNSAFE.test(a))) return undefined;
  return argv.map((a) => `"${a}"`).join(' ');
}

/**
 * The absolute cmd.exe: `%SystemRoot%\System32\cmd.exe`, else `%ComSpec%` when it is an absolute
 * path to a `cmd.exe`. Never a bare `cmd.exe` (that would be looked up in the current directory).
 */
export function systemCmd(env: NodeJS.ProcessEnv): string | undefined {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir;
  if (root && win32.isAbsolute(root) && !CMD_UNSAFE.test(root)) return win32.join(root, 'System32', 'cmd.exe');
  const spec = env.ComSpec ?? env.COMSPEC;
  if (spec && win32.isAbsolute(spec) && win32.basename(spec).toLowerCase() === 'cmd.exe' && !CMD_UNSAFE.test(spec)) return spec;
  return undefined;
}

export type Spawnable = { command: string[] } | { error: string };

/**
 * Makes an argv spawnable without a shell on Windows: `command[0]` is resolved with PATHEXT (not
 * found → an error, never the bare name, which Windows would also look up in the current
 * directory); a `.exe`/`.com` runs directly; an npm `.cmd` shim becomes `node <script>`; any other
 * `.cmd`/`.bat` runs through the absolute cmd.exe (`/d /s /c`) with every argument quoted, refused
 * when an argument cannot be quoted safely. Elsewhere the argv is returned unchanged.
 */
export async function spawnableCommand(
  command: string[],
  o: { which: Which; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; node?: string },
): Promise<Spawnable> {
  if ((o.platform ?? process.platform) !== 'win32' || command.length === 0) return { command };
  const [first, ...rest] = command;
  const resolved = await o.which(first!);
  if (!resolved) return { error: `${first} was not found on PATH.` };
  if (/\.(cmd|bat)$/i.test(resolved)) {
    const script = await npmShimScript(resolved);
    if (script) return { command: [o.node ?? process.execPath, script, ...rest] };
    const cmd = systemCmd(o.env ?? process.env);
    if (!cmd) return { error: 'cmd.exe was not found (SystemRoot / ComSpec are not set to an absolute path).' };
    const line = cmdLine([resolved, ...rest]);
    if (line === undefined) return { error: 'Its arguments cannot be passed safely to cmd.exe.' };
    return { command: [cmd, '/d', '/s', '/c', `"${line}"`] };
  }
  return { command: [resolved, ...rest] };
}

/**
 * On Windows a relative executable would also be searched in the current directory: refuse it
 * (spawning gives ENOENT, reported as not installed). Undefined when the spawn may go ahead.
 */
export function relativeWindowsExecutable(executable: string, platform: NodeJS.Platform = process.platform): NodeJS.ErrnoException | undefined {
  if (platform !== 'win32' || win32.isAbsolute(executable)) return undefined;
  return Object.assign(new Error(`spawn ${executable} ENOENT (not resolved to an absolute path)`), { code: 'ENOENT' });
}
