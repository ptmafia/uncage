import pkg from '../package.json' with { type: 'json' };

/** This CLI's version (`@uncage/cli` package.json). */
export const CLI_VERSION: string = pkg.version;

/** `uncage --version` / `-v` / `version` → the version to print; anything else → null. */
export function versionOutput(cmd: string | undefined): string | null {
  return cmd === '--version' || cmd === '-v' || cmd === 'version' ? CLI_VERSION : null;
}
