import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, win32 } from 'node:path';

/**
 * Starting commands without a shell, on every OS. The one implementation used by the agent (claude /
 * codex executables, npm for the self-upgrade) and by `@uncage/runtime-acp` (ACP agent discovery and
 * `startAcpProcess`). Never `shell: true`; on Windows never a bare `cmd.exe` and never a lookup in
 * the current directory.
 */

/**
 * How to start a command without a shell. `via`:
 * - `direct`: `file` is the executable itself (`claude.exe`, `/usr/local/bin/codex`, or the `.exe` an
 *   npm shim points at).
 * - `node-shim`: an npm `.cmd` shim for a JS bin: `file` is a Node binary and `args[0]` the JS target.
 * - `cmd`: any other `.cmd`/`.bat`: the absolute `cmd.exe` with `/d /s /c "<quoted line>"`. Spawn it
 *   with `windowsVerbatimArguments: true` so Node does not re-quote the line.
 */
export interface ResolvedCommand {
  file: string;
  args: string[];
  via: 'direct' | 'node-shim' | 'cmd';
}

export interface ResolveOptions {
  /** Default `process.platform`. */
  platform?: NodeJS.Platform;
  /** PATH / PATHEXT / SystemRoot come from here. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** The Node binary used for npm JS shims when the shim's folder has no `node.exe`. Default `process.execPath`. */
  execPath?: string;
}

/** A `.cmd`/`.bat` that cannot be started safely (no absolute cmd.exe, or arguments cmd.exe would interpret). */
export class UnsafeCommandError extends Error {
  readonly code = 'EUNSAFECMD';
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeCommandError';
  }
}

/** Windows env lookup is case-insensitive (`Path`, `PATH`, `PathExt`, `SystemRoot`). */
function envGet(env: NodeJS.ProcessEnv, name: string, win: boolean): string | undefined {
  if (!win) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

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

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** PATHEXT, lower-cased, `.exe` first (a native binary beats an npm shim in the same folder). */
function pathExts(env: NodeJS.ProcessEnv): string[] {
  const exts = (envGet(env, 'PATHEXT', true) ?? DEFAULT_PATHEXT)
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => /^\.[a-z0-9]+$/.test(e));
  return ['.exe', ...exts.filter((e) => e !== '.exe')];
}

const absolute = (p: string, win: boolean): boolean => (win ? win32.isAbsolute(p) || isAbsolute(p) : isAbsolute(p));

/**
 * The file a shell would run for `cmd`, without starting one. POSIX: an executable file in a PATH
 * folder. Windows: every PATH folder in order (quoted entries allowed), trying PATHEXT with `.exe`
 * first; only names with a PATHEXT extension are found (as `CreateProcess` would), never an
 * extensionless file. A command containing a path separator must be absolute and is never searched;
 * relative PATH entries (e.g. `.`) are skipped, so nothing is looked up in the current directory.
 * Null when nothing is found.
 */
export async function findCommand(cmd: string, o: Omit<ResolveOptions, 'execPath'> = {}): Promise<string | null> {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const win = platform === 'win32';
  if (!cmd) return null;
  const hasSep = cmd.includes('/') || (win && cmd.includes('\\'));
  if (!win) {
    if (hasSep) return isAbsolute(cmd) && (await isExecutable(cmd)) ? cmd : null;
    for (const dir of (envGet(env, 'PATH', false) ?? '').split(':')) {
      if (dir && isAbsolute(dir) && (await isExecutable(join(dir, cmd)))) return join(dir, cmd);
    }
    return null;
  }
  const exts = pathExts(env);
  const lower = cmd.toLowerCase();
  const candidates = (base: string): string[] => (exts.some((e) => lower.endsWith(e)) ? [base] : exts.map((e) => base + e));
  if (hasSep) {
    if (!absolute(cmd, true)) return null;
    for (const c of candidates(cmd)) if (await isFile(c)) return c;
    return null;
  }
  for (const raw of (envGet(env, 'PATH', true) ?? '').split(';')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || !absolute(dir, true)) continue;
    for (const c of candidates(join(dir, cmd))) if (await isFile(c)) return c;
  }
  return null;
}

/**
 * Parses an npm `cmd-shim` `.cmd` file: the target after `%dp0%\` (or `%~dp0\`) on the line that ends
 * with `%*`, and whether it is started through node (`"%_prog%"` / `node`). Null for anything else,
 * including a target that leaves the shim's folder (`..`).
 */
export function parseNpmCmdShim(text: string): { target: string; viaNode: boolean } | null {
  const lines = text.split(/\r?\n/).filter((l) => l.includes('%*'));
  const line = lines[lines.length - 1];
  if (!line) return null;
  const quoted = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
  const target = quoted
    .map((q) => /^%(?:~dp0|dp0%)\\?(.+)$/i.exec(q)?.[1])
    .find((rel): rel is string => rel !== undefined && !/^node(\.exe)?$/i.test(rel));
  if (!target || /[%\r\n]/.test(target) || target.split(/[\\/]/).includes('..')) return null;
  const viaNode = /"%_prog%"/i.test(line) || /\bnode(\.exe)?"?\s+"%/i.test(line) || /\.[cm]?js$/i.test(target);
  return { target: target.replace(/\//g, '\\'), viaNode };
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
  const root = envGet(env, 'SystemRoot', true) ?? envGet(env, 'windir', true);
  if (root && win32.isAbsolute(root) && !CMD_UNSAFE.test(root)) return win32.join(root, 'System32', 'cmd.exe');
  const spec = envGet(env, 'ComSpec', true);
  if (spec && win32.isAbsolute(spec) && win32.basename(spec).toLowerCase() === 'cmd.exe' && !CMD_UNSAFE.test(spec)) return spec;
  return undefined;
}

/** Windows tools that live in `System32` (PowerShell 5.1 in its own folder below it). */
const SYSTEM_TOOLS: Record<string, string[]> = {
  icacls: ['icacls.exe'],
  schtasks: ['schtasks.exe'],
  reg: ['reg.exe'],
  taskkill: ['taskkill.exe'],
  rundll32: ['rundll32.exe'],
  whoami: ['whoami.exe'],
  cmd: ['cmd.exe'],
  powershell: ['WindowsPowerShell', 'v1.0', 'powershell.exe'],
};

/** A Windows system tool `systemTool` knows (`icacls`, `schtasks`, `reg`, `taskkill`, `rundll32`, `whoami`, `cmd`, `powershell`). */
export type SystemToolName = 'icacls' | 'schtasks' | 'reg' | 'taskkill' | 'rundll32' | 'whoami' | 'cmd' | 'powershell';

/** Whether `name` (with or without `.exe`) is a tool `systemTool` maps. */
export function isSystemTool(name: string): name is SystemToolName {
  return Object.hasOwn(SYSTEM_TOOLS, name.toLowerCase().replace(/\.exe$/, ''));
}

/**
 * The absolute path of a Windows system tool: `%SystemRoot%\System32\<name>.exe` (PowerShell:
 * `…\System32\WindowsPowerShell\v1.0\powershell.exe`), with `C:\Windows` when `SystemRoot` /
 * `windir` is unset or not absolute. Started by bare name, Windows would look in the current
 * directory first (a planted `schtasks.exe` in a checkout would run). Other platforms: `name` unchanged.
 */
export function systemTool(name: SystemToolName, o: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}): string {
  if ((o.platform ?? process.platform) !== 'win32') return name;
  const env = o.env ?? process.env;
  const set = envGet(env, 'SystemRoot', true) ?? envGet(env, 'windir', true);
  const root = set && win32.isAbsolute(set) && !CMD_UNSAFE.test(set) ? set : 'C:\\Windows';
  return win32.join(root, 'System32', ...SYSTEM_TOOLS[name.toLowerCase().replace(/\.exe$/, '')]!);
}

/**
 * What to hand `execFile` / `spawn` for `file` without ever searching the current directory. POSIX,
 * or a path (absolute or with a separator): `file` unchanged. Windows bare names: a known system
 * tool → `systemTool`; anything else → `resolveCommand` (PATH only; npm shims and `.cmd` files made
 * startable without a shell). Null when a bare name is not found.
 */
export async function safeExecFile(
  file: string,
  args: string[],
  o: ResolveOptions = {},
): Promise<{ file: string; args: string[] } | null> {
  const platform = o.platform ?? process.platform;
  if (platform !== 'win32' || /[\\/]/.test(file)) return { file, args };
  if (isSystemTool(file)) return { file: systemTool(file.toLowerCase().replace(/\.exe$/, '') as SystemToolName, { platform, ...(o.env ? { env: o.env } : {}) }), args };
  const r = await resolveCommand(file, args, o);
  return r ? { file: r.file, args: r.args } : null;
}

/** Shims are a few hundred bytes; anything bigger is not one. */
const MAX_SHIM_BYTES = 16 * 1024;

async function resolveWinFile(full: string, args: string[], env: NodeJS.ProcessEnv, execPath: string): Promise<ResolvedCommand> {
  const ext = full.slice(full.lastIndexOf('.')).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat') return { file: full, args, via: 'direct' };
  const text = await readFile(full, 'utf8').catch(() => '');
  const shim = text.length <= MAX_SHIM_BYTES ? parseNpmCmdShim(text) : null;
  if (shim) {
    // The target is relative to the shim's folder (Windows separators; join with the host's).
    const target = join(dirname(full), ...shim.target.split('\\'));
    if (await isFile(target)) {
      if (shim.viaNode) {
        const localNode = join(dirname(full), 'node.exe');
        return { file: (await isFile(localNode)) ? localNode : execPath, args: [target, ...args], via: 'node-shim' };
      }
      if (/\.(exe|com)$/i.test(target)) return { file: target, args, via: 'direct' };
    }
  }
  const cmd = systemCmd(env);
  if (!cmd) throw new UnsafeCommandError('cmd.exe was not found (SystemRoot / ComSpec are not set to an absolute path).');
  const line = cmdLine([full, ...args]);
  if (line === undefined) throw new UnsafeCommandError('Its arguments cannot be passed safely to cmd.exe.');
  return { file: cmd, args: ['/d', '/s', '/c', `"${line}"`], via: 'cmd' };
}

/**
 * Finds `cmd` like `findCommand` and makes it startable without a shell. POSIX: the file found.
 * Windows: a `.exe`/`.com` directly; an npm `.cmd` shim becomes its Node + JS target (or its `.exe`
 * target); any other `.cmd`/`.bat` runs through the absolute cmd.exe (`/d /s /c`) with every argument
 * quoted. Null when nothing is found. Throws `UnsafeCommandError` when a `.cmd`/`.bat` cannot be
 * started safely (no absolute cmd.exe, or an argument with `"`, `%`, `!`, `^` or a line break).
 */
export async function resolveCommand(cmd: string, args: string[] = [], o: ResolveOptions = {}): Promise<ResolvedCommand | null> {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const full = await findCommand(cmd, { platform, env });
  if (!full) return null;
  if (platform !== 'win32') return { file: full, args, via: 'direct' };
  return resolveWinFile(full, args, env, o.execPath ?? process.execPath);
}

/** Whether a spawn of `file` needs `windowsVerbatimArguments` (a `cmd.exe /d /s /c "<line>"` from `resolveCommand`). */
export function isCmdLine(file: string, args: readonly string[]): boolean {
  return win32.basename(file).toLowerCase() === 'cmd.exe' && args[0] === '/d' && args[1] === '/s' && args[2] === '/c';
}
