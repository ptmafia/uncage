import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import {
  DOCTOR_HELP,
  doctorExitCode,
  exportEvents,
  formatChecks,
  nonLoopbackWarning,
  parseDoctorArgs,
  runDoctor,
} from './doctor.js';
import { applyWorkspaceFlag, buildAdapters, serve } from './serve.js';

const HELP = `uncage - run AI coding agents behind a local, approval-gated API

Usage:
  uncage serve  [--port <n>] [--workspace <dir>] [--data-dir <dir>] [--token-file <file>]
  uncage doctor [--port <n> | --url <url>] [--workspace <dir>] [--data-dir <dir>] [--token-file <file>]
                [--export-events <sessionId> [--out <file>] [--include-content]]
  uncage <command> --help

Zero-config: "uncage serve" works with no setup (optional ./uncage.config.yaml).
Env: UNCAGE_PORT, UNCAGE_LOG_LEVEL; doctor also reads UNCAGE_URL.`;

const SERVE_HELP = `uncage serve - start the local Uncage daemon

Usage:
  uncage serve [--port <n>] [--workspace <dir>] [--data-dir <dir>] [--token-file <file>]

Options:
  --port <n>          Port to listen on (default 4783, or UNCAGE_PORT).
  --workspace <dir>   Directory the agent works in (default: the current directory).
  --data-dir <dir>    Where sessions and events are stored (default ~/.uncage/data).
  --token-file <file> Where the bearer token is kept (default ~/.uncage/token).
  -h, --help          Show this help.`;

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
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    if (values.help) {
      console.log(SERVE_HELP);
      return 0;
    }
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
    const config = await loadConfig(cwd, process.env);
    const args = parseDoctorArgs(rest, process.env, config, cwd);
    if (args.help) {
      console.log(DOCTOR_HELP);
      return 0;
    }
    // Before the token goes anywhere.
    const remote = nonLoopbackWarning(args.serverUrl);
    if (remote) console.error(`! ${remote}`);
    const tokenFile = args.tokenFile ? { tokenFile: args.tokenFile } : {};
    const home = homedir();
    if (args.exportEvents) {
      const events = await exportEvents({
        sessionId: args.exportEvents,
        config,
        home,
        fetch,
        serverUrl: args.serverUrl,
        ...tokenFile,
        includeContent: args.includeContent,
      });
      const json = JSON.stringify(events, null, 2);
      if (args.out) {
        await writeFile(args.out, `${json}\n`);
        console.error(
          `Wrote ${events.length} events to ${args.out}${args.includeContent ? '' : ' (content redacted; add --include-content to keep it)'}`,
        );
      } else console.log(json);
      return 0;
    }
    const checks = await runDoctor({
      config,
      adapters: buildAdapters(config),
      fetch,
      home,
      serverUrl: args.serverUrl,
      ...tokenFile,
      ...(args.dataDir ? { dataDir: args.dataDir } : {}),
      ...(args.workspace ? { workspaces: [args.workspace] } : {}),
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
