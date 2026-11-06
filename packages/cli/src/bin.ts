import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { doctorExitCode, exportEvents, formatChecks, runDoctor } from './doctor.js';
import { applyWorkspaceFlag, buildAdapters, serve } from './serve.js';

const HELP = `uncage - run AI coding agents behind a local, approval-gated API

Usage:
  uncage serve  [--port <n>] [--workspace <dir>] [--data-dir <dir>] [--token-file <file>]
  uncage doctor [--data-dir <dir>] [--token-file <file>]
                [--export-events <sessionId> [--out <file>] [--include-content]]

Zero-config: "uncage serve" works with no setup (optional ./uncage.config.yaml).
Env: UNCAGE_PORT, UNCAGE_LOG_LEVEL.`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(HELP);
    return 0;
  }
  const cwd = process.cwd();

  if (cmd === 'serve') {
    const { values } = parseArgs({
      args: rest,
      options: {
        port: { type: 'string' },
        workspace: { type: 'string' },
        'data-dir': { type: 'string' },
        'token-file': { type: 'string' },
      },
    });
    let config = await loadConfig(cwd, values.port ? { ...process.env, UNCAGE_PORT: values.port } : process.env);
    if (values.workspace) config = applyWorkspaceFlag(config, values.workspace, cwd);
    await serve({
      config,
      ...(values['data-dir'] ? { dataDir: resolve(cwd, values['data-dir']) } : {}),
      ...(values['token-file'] ? { tokenFile: resolve(cwd, values['token-file']) } : {}),
    });
    return -1; // keep running until a signal arrives
  }

  if (cmd === 'doctor') {
    const { values } = parseArgs({
      args: rest,
      options: {
        'export-events': { type: 'string' },
        out: { type: 'string' },
        'include-content': { type: 'boolean', default: false },
        'data-dir': { type: 'string' },
        'token-file': { type: 'string' },
      },
    });
    const tokenFile = values['token-file'] ? { tokenFile: resolve(cwd, values['token-file']) } : {};
    const config = await loadConfig(cwd, process.env);
    const home = homedir();
    const sessionId = values['export-events'];
    if (sessionId) {
      const events = await exportEvents({
        sessionId,
        config,
        home,
        fetch,
        ...tokenFile,
        includeContent: values['include-content'] ?? false,
      });
      const json = JSON.stringify(events, null, 2);
      if (values.out) {
        await writeFile(values.out, `${json}\n`);
        console.error(
          `Wrote ${events.length} events to ${values.out}${values['include-content'] ? '' : ' (content redacted; add --include-content to keep it)'}`,
        );
      } else console.log(json);
      return 0;
    }
    const checks = await runDoctor({
      config,
      adapters: buildAdapters(config),
      fetch,
      home,
      ...tokenFile,
      ...(values['data-dir'] ? { dataDir: resolve(cwd, values['data-dir']) } : {}),
    });
    console.log(formatChecks(checks));
    return doctorExitCode(checks);
  }

  console.error(`Unknown command "${cmd}".\n\n${HELP}`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (e: unknown) => {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
