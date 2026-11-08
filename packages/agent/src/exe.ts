import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * How to start a command without a shell. `via`:
 * - `direct`: `file` is the executable itself (`claude.exe`, `/usr/local/bin/codex`, or the `.exe` an
 *   npm shim points at).
 * - `node-shim`: an npm `.cmd` shim for a JS bin: `file` is a Node binary and `args[0]` the JS target.
 * - `cmd`: any other `.cmd`/`.bat`: `cmd.exe /d /s /c "<quoted line>"`. Spawn it with
 *   `windowsVerbatimArguments: true` so Node does not re-quote the line.
 */
export interface ResolvedCommand {
  file: string;
  args: string[];
  via: 'direct' | 'node-shim' | 'cmd';
}

export interface ResolveOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** The Node binary used for npm JS shims when the shim's folder has no `node.exe`. Default `process.execPath`. */
  execPath?: string;
}

/** Windows env lookup is case-insensitive (`Path`, `PATH`, `PathExt`). */
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

/** PATHEXT, lower-cased, `.exe` first (a native binary beats an npm shim in the same folder). */
function pathExts(env: NodeJS.ProcessEnv): string[] {
  const raw = envGet(env, 'PATHEXT', true) ?? '.COM;.EXE;.BAT;.CMD';
  const exts = raw
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => /^\.[a-z0-9]+$/.test(e));
  return ['.exe', ...exts.filter((e) => e !== '.exe')];
}

const hasSep = (cmd: string, win: boolean): boolean => cmd.includes('/') || (win && cmd.includes('\\'));

/**
 * Parses an npm `cmd-shim` `.cmd` file: the target after `%dp0%\` (or `%~dp0\`) on the line that ends
 * with `%*`, and whether it is started through node (`"%_prog%"` / `node`). Null for anything else.
 */
export function parseNpmCmdShim(text: string): { target: string; viaNode: boolean } | null {
  const lines = text.split(/\r?\n/).filter((l) => l.includes('%*'));
  const line = lines[lines.length - 1];
  if (!line) return null;
  const quoted = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
  const target = quoted
    .map((q) => /^%(?:~dp0|dp0%)\\?(.+)$/i.exec(q)?.[1])
    .find((rel): rel is string => rel !== undefined && !/^node(\.exe)?$/i.test(rel));
  if (!target) return null;
  const viaNode = /"%_prog%"/i.test(line) || /\bnode(\.exe)?"?\s+"%/i.test(line) || /\.[cm]?js$/i.test(target);
  return { target: target.replace(/\//g, '\\'), viaNode };
}

/** Quotes one argument for a cmd.exe command line. */
function cmdQuote(a: string): string {
  return a !== '' && /^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`;
}

async function resolveWinFile(full: string, args: string[], env: NodeJS.ProcessEnv, execPath: string): Promise<ResolvedCommand> {
  const ext = full.slice(full.lastIndexOf('.')).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat') return { file: full, args, via: 'direct' };
  const shim = parseNpmCmdShim(await readFile(full, 'utf8').catch(() => ''));
  if (shim) {
    // The target is relative to the shim's folder (Windows separators; join with the host's).
    const target = join(dirname(full), ...shim.target.split('\\'));
    if (await isFile(target)) {
      if (!shim.viaNode) return { file: target, args, via: 'direct' };
      const localNode = join(dirname(full), 'node.exe');
      return { file: (await isFile(localNode)) ? localNode : execPath, args: [target, ...args], via: 'node-shim' };
    }
  }
  const comspec = envGet(env, 'ComSpec', true) ?? 'cmd.exe';
  return { file: comspec, args: ['/d', '/s', '/c', `"${[full, ...args].map(cmdQuote).join(' ')}"`], via: 'cmd' };
}

/** The file a shell would run for `cmd` (POSIX: executable on PATH; Windows: PATH × PATHEXT, `.exe` first). */
async function findOnPath(cmd: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (platform !== 'win32') {
    if (hasSep(cmd, false)) return (await isExecutable(resolve(cmd))) ? resolve(cmd) : null;
    for (const dir of (envGet(env, 'PATH', false) ?? '').split(':')) {
      if (dir && (await isExecutable(join(dir, cmd)))) return join(dir, cmd);
    }
    return null;
  }
  const exts = pathExts(env);
  const lower = cmd.toLowerCase();
  const candidates = (base: string): string[] => (exts.some((e) => lower.endsWith(e)) ? [base] : exts.map((e) => base + e));
  if (hasSep(cmd, true) || isAbsolute(cmd)) {
    for (const c of candidates(cmd)) if (await isFile(c)) return c;
    return null;
  }
  for (const raw of (envGet(env, 'PATH', true) ?? '').split(';')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!dir) continue;
    for (const c of candidates(join(dir, cmd))) if (await isFile(c)) return c;
  }
  return null;
}

/**
 * Finds `cmd` the way a shell would, without starting one. POSIX: an executable file on PATH (or the
 * path itself when it contains `/`). Windows: every PATH folder in order, trying PATHEXT with `.exe`
 * first; an npm `.cmd` shim becomes its Node + JS target (or its `.exe` target), any other `.cmd`/`.bat`
 * runs through `cmd.exe /d /s /c`. Null when nothing is found. Never uses `shell: true` (DEP0190).
 */
export async function resolveCommand(cmd: string, args: string[] = [], o: ResolveOptions = {}): Promise<ResolvedCommand | null> {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const full = await findOnPath(cmd, platform, env);
  if (!full) return null;
  if (platform !== 'win32') return { file: full, args, via: 'direct' };
  return resolveWinFile(full, args, env, o.execPath ?? process.execPath);
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
    const npmCmd = await findOnPath('npm', platform, o.env ?? process.env);
    if (npmCmd) {
      const cli = join(dirname(npmCmd), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (await isFile(cli)) return [execPath, [cli, ...UPGRADE_ARGS]];
      const r = await resolveWinFile(npmCmd, UPGRADE_ARGS, o.env ?? process.env, execPath);
      return [r.file, r.args];
    }
    return ['npm', UPGRADE_ARGS];
  }
  const besideNode = join(nodeDir, 'npm');
  if (await isExecutable(besideNode)) return [besideNode, UPGRADE_ARGS];
  const r = await resolveCommand('npm', UPGRADE_ARGS, { ...o, platform });
  return r ? [r.file, r.args] : ['npm', UPGRADE_ARGS];
}
