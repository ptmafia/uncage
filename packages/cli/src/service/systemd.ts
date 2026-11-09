import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { assertDefinitionValues, probeNode } from './spec.js';
import type { AgentService, ServiceDeps, ServiceSpec, ServiceStatus } from './types.js';

export const SYSTEMD_UNIT = 'uncage-agent.service';

/** `$XDG_CONFIG_HOME/systemd/user/uncage-agent.service`, else `~/.config/systemd/user/…` (systemd.unit(5)). */
export function systemdUnitPath(home: string, env: NodeJS.ProcessEnv): string {
  const base = env.XDG_CONFIG_HOME && posix.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : posix.join(home, '.config');
  return posix.join(base, 'systemd', 'user', SYSTEMD_UNIT);
}

/** `%` starts a specifier in every unit setting: `%%` is a literal percent. */
const spec_ = (s: string): string => s.replace(/%/g, '%%');
const unspec = (s: string): string => s.replace(/%%/g, '%');

/** One double-quoted word: `\` and `"` escaped, `%` → `%%`; in ExecStart also `$` → `$$` (no variable expansion). */
function quote(s: string, exec: boolean): string {
  const q = spec_(s.replace(/\\/g, '\\\\').replace(/"/g, '\\"'));
  return `"${exec ? q.replace(/\$/g, '$$$$') : q}"`;
}

/** Splits a line of double-quoted (or bare) words, undoing `quote`. */
function words(line: string, exec: boolean): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (line[i] === ' ' || line[i] === '\t') i++;
    if (i >= line.length) break;
    let w = '';
    if (line[i] === '"') {
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length) {
          w += line[i + 1];
          i += 2;
        } else w += line[i++];
      }
      i++; // closing quote
    } else {
      while (i < line.length && line[i] !== ' ' && line[i] !== '\t') w += line[i++];
    }
    w = unspec(w);
    out.push(exec ? w.replace(/\$\$/g, '$') : w);
  }
  return out;
}

/**
 * The user unit: `ExecStart="<node>" "<bin.js>" "agent"`, restarted on failure after 10 s (a clean
 * exit — no websites — stays stopped), logs appended to `<logsDir>/agent(.err).log`, started with the
 * user manager (`WantedBy=default.target`).
 */
export function systemdUnit(spec: ServiceSpec): string {
  assertDefinitionValues(spec, 'systemd');
  const exec = [spec.nodePath, spec.cliEntry, ...spec.args].map((a) => quote(a, true)).join(' ');
  return `# Written by "uncage agent install". Remove with "uncage agent uninstall".
[Unit]
Description=Uncage agent (Connected Mode)

[Service]
Type=simple
ExecStart=${exec}
WorkingDirectory=${spec_(spec.workingDir)}
Environment=${quote(`PATH=${spec.env.PATH}`, false)} ${quote(`HOME=${spec.env.HOME}`, false)}
Restart=on-failure
RestartSec=10
StandardOutput=append:${spec_(posix.join(spec.logsDir, 'agent.log'))}
StandardError=append:${spec_(posix.join(spec.logsDir, 'agent.err.log'))}

[Install]
WantedBy=default.target
`;
}

/** Reads a spec back from a unit written by `systemdUnit` (null when it is not one). */
export function parseSystemdUnit(text: string): ServiceSpec | null {
  const get = (key: string): string | undefined => {
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
    return m?.[1];
  };
  const execStart = get('ExecStart');
  const out = get('StandardOutput');
  const workingDir = get('WorkingDirectory');
  if (!execStart || !out?.startsWith('append:') || workingDir === undefined) return null;
  const argv = words(execStart, true);
  if (argv.length < 2) return null;
  const env: Record<string, string> = {};
  for (const w of words(get('Environment') ?? '', false)) {
    const i = w.indexOf('=');
    if (i > 0) env[w.slice(0, i)] = w.slice(i + 1);
  }
  return {
    nodePath: argv[0]!,
    cliEntry: argv[1]!,
    args: argv.slice(2),
    env: { PATH: env.PATH ?? '', HOME: env.HOME ?? '' },
    workingDir: unspec(workingDir),
    logsDir: posix.dirname(unspec(out.slice('append:'.length))),
  };
}

const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

/** `loginctl show-user <user> -p Linger` → true / false; null when loginctl cannot tell. */
export async function lingerEnabled(d: Pick<ServiceDeps, 'exec' | 'env' | 'username'>): Promise<boolean | null> {
  const user = d.username ?? d.env.USER ?? d.env.LOGNAME;
  if (!user) return null;
  try {
    const { stdout } = await d.exec('loginctl', ['show-user', user, '-p', 'Linger']);
    const v = /^Linger=(yes|no)\s*$/m.exec(stdout)?.[1];
    return v === undefined ? null : v === 'yes';
  } catch {
    return null;
  }
}

/** Linux: a systemd user unit, `systemctl --user`. */
export function systemdService(d: ServiceDeps): AgentService {
  const path = systemdUnitPath(d.home, d.env);
  const ctl = (...args: string[]) => d.exec('systemctl', ['--user', ...args]);
  return {
    kind: 'systemd',
    /** Writes the unit, `daemon-reload`, `enable --now`; a re-install also restarts a running agent. */
    async install(spec) {
      const reinstall = await exists(path);
      await mkdir(posix.dirname(path), { recursive: true });
      await mkdir(spec.logsDir, { recursive: true, mode: 0o700 });
      await writeFile(path, systemdUnit(spec), { mode: 0o644 });
      await ctl('daemon-reload');
      await ctl('enable', '--now', SYSTEMD_UNIT);
      if (reinstall) await ctl('restart', SYSTEMD_UNIT);
      const notes: string[] = [];
      if ((await lingerEnabled(d)) === false) {
        const user = d.username ?? d.env.USER ?? '$USER';
        notes.push(`The agent stops when you log out. To keep it running: loginctl enable-linger ${user}`);
      }
      return { definitionPath: path, notes };
    },
    /** `disable --now`, removes the unit, `daemon-reload`. Config and data stay. */
    async uninstall() {
      if (!(await exists(path))) return { removed: false };
      await ctl('disable', '--now', SYSTEMD_UNIT).catch(() => undefined);
      await rm(path, { force: true });
      await ctl('daemon-reload').catch(() => undefined);
      return { removed: true };
    },
    async restart() {
      if (!(await exists(path))) return false;
      try {
        await ctl('restart', SYSTEMD_UNIT);
        return true;
      } catch {
        return false;
      }
    },
    async status(): Promise<ServiceStatus> {
      const text = await readFile(path, 'utf8').catch(() => null);
      const spec = text === null ? null : parseSystemdUnit(text);
      let running = false;
      let detail: string | undefined;
      if (text !== null) {
        const state = await ctl('is-active', SYSTEMD_UNIT).then(
          (r) => r.stdout.trim(),
          (e: { stdout?: string }) => (e.stdout ?? '').trim() || 'unknown',
        );
        running = state === 'active';
        if (!running) detail = state;
      }
      const node = spec ? await probeNode(d.exec, spec.nodePath) : { nodeExists: null, nodeVersion: null };
      return {
        kind: 'systemd',
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
