import { realpath, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import type { ExecFn } from '@uncage/agent';
import type { ServiceSpec } from './types.js';

/** Path helpers for the target platform (service definitions use its separators, whatever the host). */
export const pathFor = (platform: NodeJS.Platform): typeof posix => (platform === 'win32' ? win32 : posix);

/**
 * PATH entries that vanish or change meaning after this shell exits: fnm's per-shell
 * `fnm_multishells/<id>` links. The service PATH never keeps them.
 */
const EPHEMERAL = /[\\/]fnm_multishells[\\/]/i;

/** Windows env lookup is case-insensitive (`Path`). */
function envPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return env.PATH ?? '';
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  return key ? (env[key] ?? '') : '';
}

/**
 * The service PATH: the pinned Node's folder first (so `#!/usr/bin/env node` scripts such as npm
 * agent shims run with it), then the installing shell's PATH without ephemeral, relative or duplicate entries.
 */
export function servicePath(nodePath: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const p = pathFor(platform);
  const sep = platform === 'win32' ? ';' : ':';
  const fallback = platform === 'win32' ? '' : '/usr/bin:/bin';
  const entries = [p.dirname(nodePath), ...(envPath(env, platform) || fallback).split(sep)];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of entries) {
    const key = platform === 'win32' ? e.toLowerCase() : e;
    // Relative entries would resolve against the service's working directory: dropped.
    if (!e || EPHEMERAL.test(e) || seen.has(key) || !p.isAbsolute(e)) continue;
    seen.add(key);
    out.push(e);
  }
  return out.join(sep);
}

/**
 * What the service runs: `realpath(execPath)` and `realpath(argv1)`, so the definition never points
 * at a version-manager shim (`fnm_multishells/…`, volta's `node` proxy) or the npm `uncage` link.
 */
export async function serviceSpec(o: {
  home: string;
  execPath: string;
  argv1: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): Promise<ServiceSpec> {
  const p = pathFor(o.platform);
  const nodePath = await realpath(o.execPath);
  const cliEntry = await realpath(o.argv1);
  const logsDir = p.join(o.home, '.uncage', 'logs');
  return {
    nodePath,
    cliEntry,
    // Windows: a supervisor process restarts the agent (Task Scheduler does not restart a non-zero exit).
    args: o.platform === 'win32' ? ['agent', '--supervise', '--log-file', p.join(logsDir, 'agent.log')] : ['agent'],
    env: { PATH: servicePath(nodePath, o.env, o.platform), HOME: o.home },
    workingDir: o.home,
    logsDir,
  };
}

/** Whether the pinned Node exists and what `<node> --version` prints. */
export async function probeNode(exec: ExecFn, nodePath: string): Promise<{ nodeExists: boolean; nodeVersion: string | null }> {
  const exists = await stat(nodePath).then(
    (s) => s.isFile(),
    () => false,
  );
  if (!exists) return { nodeExists: false, nodeVersion: null };
  try {
    const { stdout } = await exec(nodePath, ['--version']);
    return { nodeExists: true, nodeVersion: /v?\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? null };
  } catch {
    return { nodeExists: true, nodeVersion: null };
  }
}

/** Major version of `v22.23.4` (NaN when unknown). */
export const nodeMajor = (v: string | null): number => Number(/^v?(\d+)\./.exec(v ?? '')?.[1] ?? NaN);

/**
 * Values a service definition cannot hold safely. Every manager: no line breaks (a unit file or a
 * task document would read them as new settings). Windows: no `%` in the program, its arguments or
 * the working folder, because Task Scheduler expands `%NAME%` there and has no escape for it.
 */
export function assertDefinitionValues(spec: ServiceSpec, manager: 'systemd' | 'schtasks'): void {
  const fields: Array<[string, string]> = [
    ['Node path', spec.nodePath],
    ['CLI path', spec.cliEntry],
    ...spec.args.map((a, i): [string, string] => [`argument ${i + 1}`, a]),
    ['working folder', spec.workingDir],
    ['logs folder', spec.logsDir],
    ['PATH', spec.env.PATH],
    ['HOME', spec.env.HOME],
  ];
  for (const [what, v] of fields) {
    if (/[\r\n]/.test(v)) throw new Error(`Cannot install the background agent: the ${what} contains a line break (${JSON.stringify(v)}).`);
  }
  if (manager === 'schtasks') {
    for (const [what, v] of fields.slice(0, spec.args.length + 3)) {
      if (v.includes('%')) {
        throw new Error(
          `Cannot install the background agent: the ${what} contains "%" (${v}), which Task Scheduler would expand as a variable. ` +
            'Install Node / the CLI in a folder without "%", then run "uncage agent install" again.',
        );
      }
    }
  }
}
