import { mkdtemp, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ensureToken, ensureTokenAt } from './token.js';

const LONG = 'a'.repeat(32);
const home = () => mkdtemp(join(tmpdir(), 'uncage-home-'));

describe('ensureToken', () => {
  it('creates 0600 and is stable on second call', async () => {
    const h = await home();
    const a = await ensureToken(h);
    expect(a.path).toBe(join(h, '.uncage', 'token'));
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await stat(a.path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(h, '.uncage'))).mode & 0o777).toBe(0o700);
    expect((await ensureToken(h)).token).toBe(a.token);
  });

  it('tightens loose permissions and warns', async () => {
    const h = await home();
    await mkdir(join(h, '.uncage'), { recursive: true });
    const p = join(h, '.uncage', 'token');
    await writeFile(p, `${LONG}\n`, { mode: 0o644 });
    const warn = vi.fn();
    const t = await ensureToken(h, warn);
    expect(t.token).toBe(LONG);
    expect((await stat(p)).mode & 0o777).toBe(0o600);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain(p);
  });

  it('ensureTokenAt uses an explicit path (for --token-file), creating its directory', async () => {
    const h = await home();
    const p = join(h, 'nested', 'tok');
    const a = await ensureTokenAt(p);
    expect(a.path).toBe(p);
    expect((await stat(p)).mode & 0o777).toBe(0o600);
    expect((await ensureTokenAt(p)).token).toBe(a.token);
  });

  it('rejects a short existing token, naming the path (default path and --token-file)', async () => {
    const h = await home();
    await mkdir(join(h, '.uncage'), { recursive: true });
    const p = join(h, '.uncage', 'token');
    await writeFile(p, `${'a'.repeat(31)}\n`, { mode: 0o600 });
    await expect(ensureToken(h)).rejects.toThrow(`Token file ${p} holds a token shorter than 32 characters`);
    const explicit = join(h, 'tok');
    await writeFile(explicit, 'abc', { mode: 0o600 });
    await expect(ensureTokenAt(explicit)).rejects.toThrow(explicit);
    // The file is left alone: the user decides what to do with it.
    expect(await readFile(explicit, 'utf8')).toBe('abc');
  });

  it('rejects a token path that is not a regular file', async () => {
    const h = await home();
    const dir = join(h, 'tokdir');
    await mkdir(dir);
    await expect(ensureTokenAt(dir)).rejects.toThrow(`Token file ${dir} is not a regular file`);
  });

  it('fills an empty existing file with a new token', async () => {
    const h = await home();
    const p = join(h, 'tok');
    await writeFile(p, '\n', { mode: 0o600 });
    const t = await ensureTokenAt(p);
    expect(t.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
