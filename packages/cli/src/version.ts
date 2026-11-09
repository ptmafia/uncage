import pkg from '../package.json' with { type: 'json' };

/** This CLI's version (`@uncage/cli` package.json). */
export const CLI_VERSION: string = pkg.version;

/**
 * `uncage --version` / `-v` / `version` → what to print; anything else → null. Line 1 is the version
 * alone (installers read the first x.y.z), line 2 the Node actually running this CLI:
 * `node v22.23.4 (/path/to/node)`.
 */
export function versionOutput(
  cmd: string | undefined,
  node: { version: string; execPath: string } = { version: process.version, execPath: process.execPath },
): string | null {
  if (cmd !== '--version' && cmd !== '-v' && cmd !== 'version') return null;
  return `${CLI_VERSION}\nnode ${node.version} (${node.execPath})`;
}
