import { realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { UncageError } from './errors.js';

const isWithin = (path: string, root: string): boolean =>
  path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Canonicalises `requested` (default `cfg.default`) with realpath — so symlinks are followed —
 * and requires the result to be an existing directory inside one of the realpath'd roots.
 * Path checks are not a sandbox; they only keep sessions inside the configured roots.
 */
export async function resolveWorkspace(
  requested: string | undefined,
  cfg: { allowedRoots: string[]; default: string },
): Promise<string> {
  const target = resolve(requested ?? cfg.default);
  const invalid = (cause?: unknown) =>
    new UncageError('invalid_workspace', { details: { workspace: target }, cause });

  let real: string;
  try {
    real = await realpath(target);
    if (!(await stat(real)).isDirectory()) throw invalid();
  } catch (e) {
    throw e instanceof UncageError ? e : invalid(e);
  }
  const roots = await Promise.all(cfg.allowedRoots.map((r) => realpath(resolve(r)).catch(() => null)));
  if (!roots.some((root) => root !== null && isWithin(real, root))) throw invalid();
  return real;
}
