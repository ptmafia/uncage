import { execFile } from 'node:child_process';
import { chmod, rename as fsRename, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';
import { execTarget } from './exe.js';

/** Runs a command without a shell (same shape as the agent's `ExecFn`). */
export type PermsExec = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);
const defaultExec: PermsExec = async (file0, args0) => {
  // Windows: `icacls` from System32, never a planted one in the current directory.
  const { file, args } = await execTarget(file0, args0);
  const r = await execFileAsync(file, args, { encoding: 'utf8', windowsHide: true });
  return { stdout: r.stdout, stderr: r.stderr };
};

export interface PermsOptions {
  platform?: NodeJS.Platform;
  exec?: PermsExec;
  /** Windows account (`DOMAIN\user`). Default `%USERDOMAIN%\%USERNAME%`, else the OS user name. */
  user?: string;
}

/** The current Windows account as icacls names it (`DOMAIN\user`). */
export function windowsUser(env: NodeJS.ProcessEnv = process.env): string {
  const name = env.USERNAME ?? userInfo().username;
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${name}` : name;
}

/**
 * Makes `path` readable by the current user only. POSIX: `chmod 600` (`700` for a directory).
 * Windows: `icacls "<path>" /inheritance:r /grant:r "<user>:F"` (`(OI)(CI)F` for a directory), which
 * drops the inherited entries (Users, Authenticated Users) and leaves only the user.
 */
export async function restrictToUser(path: string, o: PermsOptions & { dir?: boolean } = {}): Promise<void> {
  const platform = o.platform ?? process.platform;
  if (platform !== 'win32') {
    await chmod(path, o.dir ? 0o700 : 0o600);
    return;
  }
  const user = o.user ?? windowsUser();
  await (o.exec ?? defaultExec)('icacls', [path, '/inheritance:r', '/grant:r', `${user}:${o.dir ? '(OI)(CI)F' : 'F'}`]);
}

/** Trustees allowed besides the user: SYSTEM and Administrators (English names or SIDs). */
const ALLOWED = [/^NT AUTHORITY\\SYSTEM$/i, /^BUILTIN\\Administrators$/i, /^\*?S-1-5-18$/i, /^\*?S-1-5-32-544$/i];

/** The trustees in `icacls <path>` output (one ACE per line, the first prefixed by the path). */
export function parseIcacls(output: string, path: string): Array<{ trustee: string; rights: string }> {
  const out: Array<{ trustee: string; rights: string }> = [];
  for (const raw of output.split(/\r?\n/)) {
    let line = raw;
    if (line.startsWith(path)) line = line.slice(path.length);
    line = line.trim();
    if (!line || /^Successfully processed|^Failed processing/i.test(line)) continue;
    const i = line.indexOf(':(');
    if (i <= 0) continue;
    out.push({ trustee: line.slice(0, i), rights: line.slice(i + 1) });
  }
  return out;
}

/**
 * Whether only the user can read `path`. POSIX: no group/other bits. Windows: `icacls` lists only the
 * user, SYSTEM and Administrators (no inherited entries for Users / Everyone).
 */
export async function checkUserOnly(path: string, o: PermsOptions = {}): Promise<{ ok: boolean; detail: string; fix: string }> {
  const platform = o.platform ?? process.platform;
  if (platform !== 'win32') {
    const mode = (await stat(path)).mode & 0o777;
    return { ok: (mode & 0o077) === 0, detail: `mode ${mode.toString(8)}`, fix: `chmod 600 '${path}'` };
  }
  const user = o.user ?? windowsUser();
  const fix = `icacls "${path}" /inheritance:r /grant:r "${user}:F"`;
  const { stdout } = await (o.exec ?? defaultExec)('icacls', [path]);
  const aces = parseIcacls(stdout, path);
  const name = user.split('\\').pop()!.toLowerCase();
  const isUser = (t: string): boolean => t.toLowerCase() === user.toLowerCase() || t.split('\\').pop()!.toLowerCase() === name;
  const others = aces.filter((a) => !isUser(a.trustee) && !ALLOWED.some((r) => r.test(a.trustee)));
  if (aces.length === 0) return { ok: false, detail: 'icacls listed no entries', fix };
  if (others.length > 0) return { ok: false, detail: `also readable by ${[...new Set(others.map((a) => a.trustee))].join(', ')}`, fix };
  return { ok: true, detail: `only ${user}`, fix };
}

/**
 * Atomically replaces `dest` with `tmp`. Windows: retries `EPERM` / `EBUSY` / `EACCES` (an antivirus
 * scan or an open reader briefly holds the file) 10 times, 50 ms apart.
 */
export async function replaceFile(
  tmp: string,
  dest: string,
  o: { platform?: NodeJS.Platform; rename?: (a: string, b: string) => Promise<void> } = {},
): Promise<void> {
  const platform = o.platform ?? process.platform;
  const rename = o.rename ?? fsRename;
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, dest);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (platform !== 'win32' || attempt >= 9 || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}
