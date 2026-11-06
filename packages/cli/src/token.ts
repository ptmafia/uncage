import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function tokenPath(home: string = homedir()): string {
  return join(home, '.uncage', 'token');
}

/** Returns the bearer token from `~/.uncage/token`, creating it (mode 0600, dir 0700) if missing. */
export function ensureToken(
  home: string = homedir(),
  warn: (msg: string) => void = () => undefined,
): Promise<{ token: string; path: string }> {
  return ensureTokenAt(tokenPath(home), warn);
}

/** Like ensureToken, for an explicit token file (`--token-file`). */
export async function ensureTokenAt(
  path: string,
  warn: (msg: string) => void = () => undefined,
): Promise<{ token: string; path: string }> {
  try {
    const st = await stat(path);
    const token = (await readFile(path, 'utf8')).trim();
    if (token) {
      if ((st.mode & 0o077) !== 0) {
        await chmod(path, 0o600);
        warn(`Token file ${path} had loose permissions (${(st.mode & 0o777).toString(8)}); changed to 600.`);
      }
      return { token, path };
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('base64url');
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return { token, path };
}
