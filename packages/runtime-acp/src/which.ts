import { win32 } from 'node:path';
import { cmdLine, findCommand, resolveCommand, systemCmd, UnsafeCommandError } from '@uncage/protocol/node';

// The shared implementation (`@uncage/protocol/node`, also used by the agent for claude / codex):
// one way to find and start commands without a shell on every OS.
export { cmdLine, systemCmd };

/** Resolves a command on PATH (absolute path or null). */
export type Which = (cmd: string) => Promise<string | null>;

/**
 * A `which` over `env.PATH` (`findCommand`, the lookup half of `resolveCommand`). On Windows only
 * names with a `PATHEXT` extension are found (as `CreateProcess` would), never an extensionless
 * file. A command with a path separator is checked as is (absolute only) and never searched.
 */
export function createWhich(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Which {
  return (cmd) => findCommand(cmd, { env, platform });
}

export type Spawnable = { command: string[] } | { error: string };

/**
 * Makes an argv spawnable without a shell on Windows (`resolveCommand`): `command[0]` is found with
 * `which` (not found → an error, never the bare name, which Windows would also look up in the
 * current directory); a `.exe`/`.com` runs directly; an npm `.cmd` shim becomes `node <script>`;
 * any other `.cmd`/`.bat` runs through the absolute cmd.exe (`/d /s /c`) with every argument quoted,
 * refused when an argument cannot be quoted safely. Elsewhere the argv is returned unchanged.
 */
export async function spawnableCommand(
  command: string[],
  o: { which: Which; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; node?: string },
): Promise<Spawnable> {
  if ((o.platform ?? process.platform) !== 'win32' || command.length === 0) return { command };
  const [first, ...rest] = command;
  const found = await o.which(first!);
  if (!found) return { error: `${first} was not found on PATH.` };
  try {
    const r = await resolveCommand(found, rest, { platform: 'win32', env: o.env ?? process.env, ...(o.node ? { execPath: o.node } : {}) });
    if (!r) return { error: `${first} was not found on PATH.` };
    return { command: [r.file, ...r.args] };
  } catch (e) {
    if (e instanceof UnsafeCommandError) return { error: e.message };
    throw e;
  }
}

/**
 * On Windows a relative executable would also be searched in the current directory: refuse it
 * (spawning gives ENOENT, reported as not installed). Undefined when the spawn may go ahead.
 */
export function relativeWindowsExecutable(executable: string, platform: NodeJS.Platform = process.platform): NodeJS.ErrnoException | undefined {
  if (platform !== 'win32' || win32.isAbsolute(executable)) return undefined;
  return Object.assign(new Error(`spawn ${executable} ENOENT (not resolved to an absolute path)`), { code: 'ENOENT' });
}
