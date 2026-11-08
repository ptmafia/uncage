import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { probeNode } from './spec.js';
import type { AgentService, ServiceDeps, ServiceSpec, ServiceStatus } from './types.js';

export const LAUNCHD_LABEL = 'dev.uncage.agent';

export const plistPath = (home: string): string => posix.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);

const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const unxml = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');

/**
 * The launchd user agent running `<node> <bin.js> agent`: starts at login (RunAtLoad), restarted by
 * launchd when it exits with a failure (KeepAlive.SuccessfulExit = false — e.g. after a self-upgrade),
 * but not after a clean exit (no websites configured). Logs go to `<logsDir>/agent(.err).log`.
 */
export function launchdPlist(spec: ServiceSpec): string {
  const args = [spec.nodePath, spec.cliEntry, ...spec.args].map((a) => `    <string>${xml(a)}</string>`).join('\n');
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
  <string>${xml(spec.workingDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(spec.env.PATH)}</string>
    <key>HOME</key>
    <string>${xml(spec.env.HOME)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(posix.join(spec.logsDir, 'agent.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(posix.join(spec.logsDir, 'agent.err.log'))}</string>
</dict>
</plist>
`;
}

/** The `<string>` after `<key>name</key>` (first match), unescaped. */
function keyString(text: string, name: string): string | undefined {
  const m = new RegExp(`<key>${name}</key>\\s*<string>([^<]*)</string>`).exec(text);
  return m ? unxml(m[1]!) : undefined;
}

/** Reads a spec back from a plist written by `launchdPlist` (null when it is not one). */
export function parsePlist(text: string): ServiceSpec | null {
  const arr = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1];
  if (!arr) return null;
  const argv = [...arr.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unxml(m[1]!));
  const env = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text)?.[1] ?? '';
  const out = keyString(text, 'StandardOutPath');
  const workingDir = keyString(text, 'WorkingDirectory');
  if (argv.length < 2 || !out || workingDir === undefined) return null;
  return {
    nodePath: argv[0]!,
    cliEntry: argv[1]!,
    args: argv.slice(2),
    env: { PATH: keyString(env, 'PATH') ?? '', HOME: keyString(env, 'HOME') ?? '' },
    workingDir,
    logsDir: posix.dirname(out),
  };
}

const domain = (uid: number): string => `gui/${uid}`;

/** The launchctl calls `install` makes, in order (bootout may fail if not loaded). */
export function launchctlInstallCommands(uid: number, plist: string): Array<[string, string[]]> {
  return [
    ['launchctl', ['bootout', `${domain(uid)}/${LAUNCHD_LABEL}`]],
    ['launchctl', ['bootstrap', domain(uid), plist]],
  ];
}

/** macOS: a launchd user agent in `~/Library/LaunchAgents/dev.uncage.agent.plist`, domain `gui/<uid>`. */
export function launchdService(d: ServiceDeps): AgentService {
  const uid = d.uid ?? process.getuid?.() ?? 501;
  const path = plistPath(d.home);
  const target = `${domain(uid)}/${LAUNCHD_LABEL}`;
  return {
    kind: 'launchd',
    /** Writes the plist and (re)starts the agent: `launchctl bootout` (ignored if absent) then `bootstrap gui/<uid>`. */
    async install(spec) {
      await mkdir(posix.dirname(path), { recursive: true });
      await mkdir(spec.logsDir, { recursive: true, mode: 0o700 });
      await writeFile(path, launchdPlist(spec), { mode: 0o644 });
      const [bootout, bootstrap] = launchctlInstallCommands(uid, path);
      await d.exec(...bootout!).catch(() => undefined);
      try {
        await d.exec(...bootstrap!);
      } catch (e) {
        throw new Error(`launchctl bootstrap failed: ${(e as { stderr?: string }).stderr?.trim() || (e as Error).message}`, { cause: e });
      }
      return { definitionPath: path, notes: [] };
    },
    /** `launchctl bootout` (ignored if not loaded) and removes the plist. Config and data stay. */
    async uninstall() {
      await d.exec('launchctl', ['bootout', target]).catch(() => undefined);
      try {
        await rm(path);
        return { removed: true };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { removed: false };
        throw e;
      }
    },
    /** `launchctl kickstart -k` (e.g. after `uncage sites remove`); false when it is not loaded. */
    async restart() {
      try {
        await d.exec('launchctl', ['kickstart', '-k', target]);
        return true;
      } catch {
        return false;
      }
    },
    async status(): Promise<ServiceStatus> {
      const text = await readFile(path, 'utf8').catch(() => null);
      const spec = text === null ? null : parsePlist(text);
      let running = false;
      let detail: string | undefined;
      if (text !== null) {
        try {
          const { stdout } = await d.exec('launchctl', ['print', target]);
          running = /^\s*state = running\s*$/m.test(stdout);
          const pid = /^\s*pid = (\d+)\s*$/m.exec(stdout)?.[1];
          if (pid) detail = `pid ${pid}`;
        } catch {
          // not loaded
        }
      }
      const node = spec ? await probeNode(d.exec, spec.nodePath) : { nodeExists: null, nodeVersion: null };
      return {
        kind: 'launchd',
        installed: text !== null,
        running,
        spec,
        ...node,
        definitionPath: text === null ? null : path,
        ...(detail ? { detail } : {}),
      };
    },
  };
}
