import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';

/**
 * Home directory for Connected Mode state (`~/.uncage/agent.yaml`, `~/.uncage/sites/…`, session
 * workspaces under `~/Uncage/…`). `UNCAGE_HOME` (absolute) overrides it for tests and dev runs while
 * `HOME` stays untouched, so Claude Code keeps finding its login.
 */
export function connectedHome(env: NodeJS.ProcessEnv = process.env): string {
  const h = env.UNCAGE_HOME;
  if (!h) return homedir();
  if (!isAbsolute(h)) throw new Error(`UNCAGE_HOME must be an absolute path (got "${h}").`);
  return h;
}

/** `uncage setup` with `UNCAGE_HOME` cannot install the background agent: launchd would not inherit it. */
export function daemonHomeConflict(env: NodeJS.ProcessEnv, noDaemon: boolean): string | null {
  if (!env.UNCAGE_HOME || noDaemon) return null;
  return 'UNCAGE_HOME is for foreground runs: pass --no-daemon, then start "uncage agent" with the same UNCAGE_HOME.';
}
