import { mkdtemp, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ensureToken } from './token.js';

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
    await writeFile(p, 'abc\n', { mode: 0o644 });
    const warn = vi.fn();
    const t = await ensureToken(h, warn);
    expect(t.token).toBe('abc');
    expect((await stat(p)).mode & 0o777).toBe(0o600);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain(p);
  });
});
