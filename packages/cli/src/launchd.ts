import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecFn } from '@uncage/agent';

export const LAUNCHD_LABEL = 'dev.uncage.agent';

export const plistPath = (home: string): string => join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
export const logsDir = (home: string): string => join(home, '.uncage', 'logs');

const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export interface PlistOptions {
  home: string;
  /** e.g. `[process.execPath, '/usr/local/lib/node_modules/@uncage/cli/dist/bin.js', 'agent']` */
  programArguments: string[];
  /** PATH for the agent (launchd's default PATH cannot find `claude` / `node` from npm/Homebrew). */
  path: string;
}

/**
 * The launchd user agent running `uncage agent`: starts at login (RunAtLoad), restarted by launchd
 * when it exits with a failure (KeepAlive.SuccessfulExit = false — e.g. after a self-upgrade), but
 * not after a clean exit (no websites configured). Logs go to `~/.uncage/logs`.
 */
export function launchdPlist(o: PlistOptions): string {
  const args = o.programArguments.map((a) => `    <string>${xml(a)}</string>`).join('\n');
  const logs = logsDir(o.home);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>${xml(o.home)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(o.path)}</string>
    <key>HOME</key>
    <string>${xml(o.home)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(join(logs, 'agent.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(logs, 'agent.err.log'))}</string>
</dict>
</plist>
`;
}

export interface LaunchdDeps {
  home: string;
  uid: number;
  exec: ExecFn;
}

const domain = (uid: number): string => `gui/${uid}`;

/** The launchctl calls `installLaunchAgent` makes, in order (bootout may fail if not loaded). */
export function launchctlInstallCommands(uid: number, plist: string): Array<[string, string[]]> {
  return [
    ['launchctl', ['bootout', `${domain(uid)}/${LAUNCHD_LABEL}`]],
    ['launchctl', ['bootstrap', domain(uid), plist]],
  ];
}

/** Writes the plist and (re)starts the agent: `launchctl bootout` (ignored if absent) then `bootstrap gui/<uid>`. */
export async function installLaunchAgent(d: LaunchdDeps & Omit<PlistOptions, 'home'>): Promise<string> {
  const path = plistPath(d.home);
  await mkdir(join(d.home, 'Library', 'LaunchAgents'), { recursive: true });
  await mkdir(logsDir(d.home), { recursive: true, mode: 0o700 });
  await writeFile(path, launchdPlist({ home: d.home, programArguments: d.programArguments, path: d.path }), { mode: 0o644 });
  const [bootout, bootstrap] = launchctlInstallCommands(d.uid, path);
  await d.exec(...bootout!).catch(() => undefined);
  try {
    await d.exec(...bootstrap!);
  } catch (e) {
    throw new Error(`launchctl bootstrap failed: ${(e as { stderr?: string }).stderr?.trim() || (e as Error).message}`, { cause: e });
  }
  return path;
}

/** Restarts a loaded agent (e.g. after `uncage sites remove`); a no-op when it is not loaded. */
export async function restartLaunchAgent(d: LaunchdDeps): Promise<boolean> {
  try {
    await d.exec('launchctl', ['kickstart', '-k', `${domain(d.uid)}/${LAUNCHD_LABEL}`]);
    return true;
  } catch {
    return false;
  }
}

/** `launchctl bootout` (ignored if not loaded) and removes the plist. Config and data stay. */
export async function uninstallLaunchAgent(d: LaunchdDeps): Promise<{ removed: boolean }> {
  await d.exec('launchctl', ['bootout', `${domain(d.uid)}/${LAUNCHD_LABEL}`]).catch(() => undefined);
  try {
    await rm(plistPath(d.home));
    return { removed: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { removed: false };
    throw e;
  }
}
