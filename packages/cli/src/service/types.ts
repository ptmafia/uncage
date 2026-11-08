import type { ExecFn } from '@uncage/agent';

/** How the background agent is kept running on this computer. */
export type ServiceKind = 'launchd' | 'systemd' | 'schtasks' | 'run-key' | 'none';

/** Everything a service definition pins: the exact Node and CLI entry, arguments, environment and folders. */
export interface ServiceSpec {
  /** realpath of the Node binary used at install time (never a version-manager shim). */
  nodePath: string;
  /** realpath of the CLI's `bin.js`. */
  cliEntry: string;
  /**
   * `['agent', '--supervise', '--log-file', <path>]` on Windows (tasks cannot redirect stdout, and
   * Task Scheduler does not restart a program that exits non-zero), `['agent']` elsewhere.
   */
  args: string[];
  env: { PATH: string; HOME: string };
  workingDir: string;
  logsDir: string;
}

export interface ServiceStatus {
  kind: ServiceKind;
  installed: boolean;
  /** null when the service manager cannot tell (or there is none). */
  running: boolean | null;
  /** The spec read back from the installed definition. */
  spec: ServiceSpec | null;
  /** Whether the pinned Node still exists (null when nothing is installed). */
  nodeExists: boolean | null;
  /** `<pinned node> --version`, e.g. `v22.23.4` (null when it does not run). */
  nodeVersion: string | null;
  definitionPath: string | null;
  detail?: string;
}

export interface AgentService {
  readonly kind: ServiceKind;
  /** Writes the definition and (re)starts the agent. `notes`: hints to print (e.g. linger). */
  install(spec: ServiceSpec): Promise<{ definitionPath: string; notes: string[] }>;
  uninstall(): Promise<{ removed: boolean }>;
  /** Restarts an installed agent; false (and nothing done) when it is not installed. */
  restart(): Promise<boolean>;
  /** Reads the pinned spec back from the service's own definition. */
  status(): Promise<ServiceStatus>;
}

export interface ServiceDeps {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  exec: ExecFn;
  uid?: number;
  /** POSIX user name (loginctl) or Windows `DOMAIN\user` (task principal, icacls). */
  username?: string;
  /** Starts a detached, hidden process (the Windows Run-key fallback starts the agent now). Returns its pid. */
  spawnDetached?: (file: string, args: string[]) => number | undefined;
  /** Windows build number (conhost `--headless` needs 17763+). Default from `os.release()`. */
  windowsBuild?: number;
}
