import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createUncage } from '@uncage/core';
import type { RuntimeAdapter } from '@uncage/protocol';
import { claudeAdapter } from '@uncage/runtime-claude';
import { codexAdapter } from '@uncage/runtime-codex';
import { createUncageServer } from '@uncage/server';
import pino, { type Logger } from 'pino';
import type { UncageConfig } from './config.js';
import { ensureToken } from './token.js';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'headers.authorization',
  'authorization',
  'token',
  '*.token',
  '*.apiKey',
  'apiKey',
  'env',
  '*.env',
];

export function createLogger(env: NodeJS.ProcessEnv = process.env, destination?: NodeJS.WritableStream): Logger {
  const opts = { level: env.UNCAGE_LOG_LEVEL ?? 'info', redact: { paths: REDACT_PATHS, censor: '[redacted]' } };
  return destination ? pino(opts, destination) : pino(opts, pino.destination(2));
}

export function buildAdapters(config: UncageConfig): RuntimeAdapter[] {
  const adapters: RuntimeAdapter[] = [];
  if (config.runtimes.claude.enabled) adapters.push(claudeAdapter());
  if (config.runtimes.codex.enabled) {
    adapters.push(codexAdapter(config.runtimes.codex.command ? { command: config.runtimes.codex.command } : {}));
  }
  return adapters;
}

/** `--workspace <dir>` sets the default workspace and, when the config left roots at the zero-config default, the allowed roots. */
export function applyWorkspaceFlag(config: UncageConfig, dir: string, cwd: string): UncageConfig {
  const abs = resolve(cwd, dir);
  const zeroConfigRoots = config.workspace.allowedRoots.length === 1 && config.workspace.allowedRoots[0] === cwd;
  return { ...config, workspace: { default: abs, allowedRoots: zeroConfigRoots ? [abs] : config.workspace.allowedRoots } };
}

export function formatBanner(url: string, workspace: string, runtimes: Array<{ id: string; ok: boolean; reason?: string }>): string {
  const rt = runtimes.map((r) => `${r.id} ${r.ok ? '✓' : `✗${r.reason ? ` (${r.reason})` : ''}`}`).join(', ');
  return `Uncage listening on ${url} · workspace ${workspace} · runtimes: ${rt || 'none'}`;
}

export interface ServeOptions {
  config: UncageConfig;
  dataDir?: string;
  home?: string;
  out?: (line: string) => void;
}

export async function serve(o: ServeOptions): Promise<void> {
  const out = o.out ?? ((l) => console.log(l));
  const home = o.home ?? homedir();
  const logger = createLogger();
  const { token, path } = await ensureToken(home, (m) => logger.warn(m));
  const { config } = o;
  const adapters = buildAdapters(config);

  const uncage = await createUncage({
    adapters,
    dataDir: o.dataDir ?? join(home, '.uncage', 'data'),
    workspace: config.workspace,
    approvals: { ttlMs: config.security.approvalTtlMs },
    eventRetentionDays: config.server.eventRetentionDays,
    logger,
  });
  const server = await createUncageServer({
    uncage,
    token,
    port: config.server.port,
    allowedOrigins: config.security.allowedOrigins,
    logger,
  });

  let url: string;
  try {
    url = await server.listen();
  } catch (e) {
    await uncage.close().catch(() => undefined);
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new Error(
        `Port ${config.server.port} is already in use. Is Uncage already running? Try: uncage serve --port ${config.server.port + 1}`,
        { cause: e },
      );
    }
    throw e;
  }

  const runtimes = await Promise.all(
    adapters.map(async (a) => {
      const p = await a.probe().catch(() => ({ status: 'error' as const }));
      return { id: a.id, ok: p.status === 'available', reason: p.status === 'not_installed' ? 'not installed' : p.status };
    }),
  );
  out(formatBanner(url, config.workspace.default, runtimes));
  out(`Token file: ${path}`);

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    server
      .close()
      .then(() => uncage.close())
      .then(
        () => process.exit(0),
        (e: unknown) => {
          logger.error({ err: e }, 'shutdown failed');
          process.exit(1);
        },
      );
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}
