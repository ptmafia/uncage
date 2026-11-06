import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveWorkspace } from './workspace.js';

describe('resolveWorkspace', () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'uncage-ws-')));
    root = join(base, 'root');
    outside = join(base, 'outside');
    mkdirSync(join(root, 'nested', 'deep'), { recursive: true });
    mkdirSync(outside);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('rejects symlink escaping allowedRoots', async () => {
    symlinkSync(outside, join(root, 'escape'));
    await expect(
      resolveWorkspace(join(root, 'escape'), { allowedRoots: [root], default: root }),
    ).rejects.toMatchObject({ code: 'invalid_workspace' });
  });

  it('accepts nested dir', async () => {
    await expect(
      resolveWorkspace(join(root, 'nested', 'deep'), { allowedRoots: [root], default: root }),
    ).resolves.toBe(join(root, 'nested', 'deep'));
    await expect(resolveWorkspace(undefined, { allowedRoots: [root], default: root })).resolves.toBe(root);
  });

  it('rejects ../ traversal', async () => {
    await expect(
      resolveWorkspace(join(root, 'nested', '..', '..', 'outside'), { allowedRoots: [root], default: root }),
    ).rejects.toMatchObject({ code: 'invalid_workspace' });
    // A sibling sharing the root's prefix is not inside the root.
    mkdirSync(`${root}-evil`);
    await expect(resolveWorkspace(`${root}-evil`, { allowedRoots: [root], default: root })).rejects.toMatchObject({
      code: 'invalid_workspace',
    });
  });

  it('rejects missing paths and files', async () => {
    await expect(resolveWorkspace(join(root, 'nope'), { allowedRoots: [root], default: root })).rejects.toMatchObject({
      code: 'invalid_workspace',
    });
  });
});
