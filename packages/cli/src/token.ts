import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { restrictToUser } from '@uncage/agent';

const WIN = process.platform === 'win32';

export function tokenPath(home: string = homedir()): string {
  return join(home, '.uncage', 'token');
}

/** Returns the bearer token from `~/.uncage/token`, creating it (mode 0600 / a user-only ACL, dir 0700) if missing. */
export function ensureToken(
  home: string = homedir(),
  warn: (msg: string) => void = () => undefined,
): Promise<{ token: string; path: string }> {
  return ensureTokenAt(tokenPath(home), warn);
}

/** Tokens we generate are 43 chars; anything this short was hand-written and is too guessable. */
export const MIN_TOKEN_LENGTH = 32;

/**
 * Like ensureToken, for an explicit token file (`--token-file`). An existing file must be a
 * regular file holding a token of at least MIN_TOKEN_LENGTH chars; otherwise this throws, naming
 * the path. An empty (or whitespace-only) file is treated as absent and filled with a new token.
 */
export async function ensureTokenAt(
  path: string,
  warn: (msg: string) => void = () => undefined,
): Promise<{ token: string; path: string }> {
  try {
    const st = await stat(path);
    if (!st.isFile()) {
      throw new Error(`Token file ${path} is not a regular file. Remove it, or pass another --token-file.`);
    }
    const token = (await readFile(path, 'utf8')).trim();
    if (token) {
      if (token.length < MIN_TOKEN_LENGTH) {
        throw new Error(
          `Token file ${path} holds a token shorter than ${MIN_TOKEN_LENGTH} characters. ` +
            'Delete the file so a strong token is generated, or put a longer random token in it.',
        );
      }
      // POSIX mode bits; on Windows the file got a user-only ACL when it was created.
      if (!WIN && (st.mode & 0o077) !== 0) {
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
  await restrictToUser(path); // chmod 600; on Windows icacls: only this user
  return { token, path };
}
