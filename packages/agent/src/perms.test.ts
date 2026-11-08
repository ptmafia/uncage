import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkUserOnly, parseIcacls, replaceFile, restrictToUser, type PermsExec } from './perms.js';

const WIN = process.platform === 'win32';
const cleanups: string[] = [];
afterEach(async () => {
  for (const d of cleanups.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'uncage-perms-'));
  cleanups.push(d);
  return d;
}

const ICACLS_OK = (p: string) => `${p} PC\\u:(F)
${' '.repeat(p.length)} NT AUTHORITY\\SYSTEM:(F)
${' '.repeat(p.length)} BUILTIN\\Administrators:(F)

Successfully processed 1 files; Failed processing 0 files
`;
const ICACLS_OPEN = (p: string) => `${p} PC\\u:(F)
${' '.repeat(p.length)} BUILTIN\\Users:(I)(RX)
${' '.repeat(p.length)} NT AUTHORITY\\Authenticated Users:(I)(M)

Successfully processed 1 files; Failed processing 0 files
`;

describe('restrictToUser / checkUserOnly', () => {
  it.skipIf(WIN)('POSIX: 0600 for files, 0700 for directories; checkUserOnly reads the mode', async () => {
    const d = await tmp();
    const f = join(d, 'token');
    await writeFile(f, 'x', { mode: 0o644 });
    expect(await checkUserOnly(f)).toMatchObject({ ok: false, detail: 'mode 644', fix: `chmod 600 '${f}'` });
    await restrictToUser(f);
    expect((await stat(f)).mode & 0o777).toBe(0o600);
    expect((await checkUserOnly(f)).ok).toBe(true);
    await restrictToUser(d, { dir: true });
    expect((await stat(d)).mode & 0o777).toBe(0o700);
  });

  it('win32: icacls /inheritance:r /grant:r <user>:F (dirs (OI)(CI)F); checkUserOnly parses icacls', async () => {
    const exec = vi.fn<PermsExec>(async () => ({ stdout: '', stderr: '' }));
    await restrictToUser('C:\\Users\\u\\.uncage\\agent.yaml', { platform: 'win32', exec, user: 'PC\\u' });
    await restrictToUser('C:\\Users\\u\\.uncage', { platform: 'win32', exec, user: 'PC\\u', dir: true });
    expect(exec.mock.calls).toEqual([
      ['icacls', ['C:\\Users\\u\\.uncage\\agent.yaml', '/inheritance:r', '/grant:r', 'PC\\u:F']],
      ['icacls', ['C:\\Users\\u\\.uncage', '/inheritance:r', '/grant:r', 'PC\\u:(OI)(CI)F']],
    ]);

    const p = 'C:\\Users\\u\\.uncage\\token';
    const ok = await checkUserOnly(p, { platform: 'win32', user: 'PC\\u', exec: async () => ({ stdout: ICACLS_OK(p), stderr: '' }) });
    expect(ok).toEqual({ ok: true, detail: 'only PC\\u', fix: `icacls "${p}" /inheritance:r /grant:r "PC\\u:F"` });
    const open = await checkUserOnly(p, { platform: 'win32', user: 'PC\\u', exec: async () => ({ stdout: ICACLS_OPEN(p), stderr: '' }) });
    expect(open).toMatchObject({ ok: false, detail: 'also readable by BUILTIN\\Users, NT AUTHORITY\\Authenticated Users' });
    expect(parseIcacls(ICACLS_OK(p), p).map((a) => a.trustee)).toEqual(['PC\\u', 'NT AUTHORITY\\SYSTEM', 'BUILTIN\\Administrators']);
  });

  it.runIf(WIN)('win32 (real icacls): a restricted file lists only the user, SYSTEM and Administrators', async () => {
    const d = await tmp();
    const f = join(d, 'token');
    await writeFile(f, 'x');
    await restrictToUser(f);
    expect(await checkUserOnly(f)).toMatchObject({ ok: true });
  });
});

describe('replaceFile', () => {
  it('renames atomically; on win32 retries EPERM / EBUSY / EACCES up to 10 times', async () => {
    const d = await tmp();
    await writeFile(join(d, 'a.tmp'), 'new');
    await writeFile(join(d, 'a'), 'old');
    await replaceFile(join(d, 'a.tmp'), join(d, 'a'));
    expect(await readFile(join(d, 'a'), 'utf8')).toBe('new');

    let calls = 0;
    const flaky = async () => {
      if (++calls < 3) throw Object.assign(new Error('busy'), { code: 'EPERM' });
    };
    await replaceFile('t', 'd', { platform: 'win32', rename: flaky });
    expect(calls).toBe(3);

    const always = vi.fn(async () => {
      throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    });
    await expect(replaceFile('t', 'd', { platform: 'win32', rename: always })).rejects.toThrow('locked');
    expect(always).toHaveBeenCalledTimes(10);

    const posix = vi.fn(async () => {
      throw Object.assign(new Error('nope'), { code: 'EPERM' });
    });
    await expect(replaceFile('t', 'd', { platform: 'linux', rename: posix })).rejects.toThrow('nope');
    expect(posix).toHaveBeenCalledTimes(1);
  });
});
