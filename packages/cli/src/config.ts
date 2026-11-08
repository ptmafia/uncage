import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AcpRuntimesSchema, DEFAULT_ACP_RUNTIMES, type AcpRuntimesConfig } from '@uncage/agent';
import { parse } from 'yaml';
import { z } from 'zod';

export interface UncageConfig {
  server: { port: number; eventRetentionDays: number };
  security: { allowedOrigins: string[]; approvalTtlMs: number; allowBypass: boolean };
  workspace: { allowedRoots: string[]; default: string };
  runtimes: { claude: { enabled: boolean }; codex: { enabled: boolean; command?: string[] }; acp: AcpRuntimesConfig };
}

export const CONFIG_FILE = 'uncage.config.yaml';
export const DEFAULT_PORT = 4783;

/** Shape of `uncage.config.yaml`. Every object level is strict: unknown keys are rejected. */
export const ConfigSchema = z
  .object({
    server: z
      .object({
        port: z.number().int().min(0).max(65535).default(DEFAULT_PORT),
        eventRetentionDays: z.number().positive().default(7),
      })
      .strict()
      .default({ port: DEFAULT_PORT, eventRetentionDays: 7 }),
    security: z
      .object({
        allowedOrigins: z.array(z.string()).default([]),
        approvalTtlMs: z.number().int().positive().default(600_000),
        /** Enables the `bypassPermissions` permission mode. */
        allowBypass: z.boolean().default(false),
      })
      .strict()
      .default({ allowedOrigins: [], approvalTtlMs: 600_000, allowBypass: false }),
    workspace: z
      .object({
        allowedRoots: z.array(z.string()).min(1).optional(),
        default: z.string().optional(),
      })
      .strict()
      .default({}),
    runtimes: z
      .object({
        claude: z.object({ enabled: z.boolean().default(true) }).strict().default({ enabled: true }),
        codex: z
          .object({ enabled: z.boolean().default(true), command: z.array(z.string()).min(1).optional() })
          .strict()
          .default({ enabled: true }),
        /** ACP agents: same schema as `runtimes.acp` in ~/.uncage/agent.yaml. */
        acp: AcpRuntimesSchema.default(DEFAULT_ACP_RUNTIMES),
      })
      .strict()
      .default({ claude: { enabled: true }, codex: { enabled: true }, acp: DEFAULT_ACP_RUNTIMES }),
  })
  .strict();

function formatIssues(file: string, err: z.ZodError): string {
  const lines = err.issues.map((i) => {
    if (i.code === 'unrecognized_keys') {
      const base = i.path.join('.');
      return i.keys.map((k) => `  - unknown key "${base ? `${base}.` : ''}${k}" (not a supported option)`).join('\n');
    }
    return `  - ${i.path.join('.') || '(root)'}: ${i.message}`;
  });
  return `Invalid ${file}:\n${lines.join('\n')}`;
}

/**
 * Loads `./uncage.config.yaml` (optional), applies defaults, then env overrides (`UNCAGE_PORT`;
 * `UNCAGE_ALLOW_BYPASS=1` turns `security.allowBypass` on). A project file cannot consent to
 * downloading agents: `runtimes.acp.enable` / `consented` are ignored with a warning (`warn`).
 */
export async function loadConfig(
  cwd: string,
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void = (m) => console.error(`! ${m}`),
): Promise<UncageConfig> {
  const path = join(cwd, CONFIG_FILE);
  let raw: unknown = {};
  try {
    raw = parse(await readFile(path, 'utf8')) ?? {};
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`Could not read ${path}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(formatIssues(CONFIG_FILE, parsed.error));
  const c = parsed.data;
  const { enable, consented } = c.runtimes.acp;
  if (enable.length > 0 || Object.keys(consented).length > 0) {
    const ids = [...new Set([...enable, ...Object.keys(consented)])];
    warn(
      `${CONFIG_FILE}: runtimes.acp.enable/consented are ignored (a project file cannot consent to running downloaded agents). ` +
        `To allow them, run: ${ids.map((id) => `uncage runtimes enable ${id}`).join('; ')}`,
    );
  }

  let port = c.server.port;
  if (env.UNCAGE_PORT !== undefined && env.UNCAGE_PORT !== '') {
    port = Number(env.UNCAGE_PORT);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`UNCAGE_PORT must be an integer between 0 and 65535 (got "${env.UNCAGE_PORT}").`);
    }
  }

  return {
    server: { port, eventRetentionDays: c.server.eventRetentionDays },
    security: { ...c.security, allowBypass: c.security.allowBypass || env.UNCAGE_ALLOW_BYPASS === '1' },
    workspace: {
      allowedRoots: c.workspace.allowedRoots ?? [cwd],
      default: c.workspace.default ?? c.workspace.allowedRoots?.[0] ?? cwd,
    },
    runtimes: {
      claude: c.runtimes.claude,
      codex: {
        enabled: c.runtimes.codex.enabled,
        ...(c.runtimes.codex.command ? { command: c.runtimes.codex.command } : {}),
      },
      acp: { ...c.runtimes.acp, enable: [], consented: {} },
    },
  };
}
