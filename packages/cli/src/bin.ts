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
import { defaultExec, loadAgentConfig } from '@uncage/agent';
import { ACTIVITY_HELP, showActivity } from './activity-cmd.js';
import { AGENT_HELP, resolveAgentExecutables, runAgent } from './agent-cmd.js';
import { agentService, type AgentService } from './service/index.js';
import { connectedHome, daemonHomeConflict } from './home.js';
import { installAgentService, runSetup, SETUP_HELP } from './setup.js';
import { listSites, removeSite, SITES_HELP } from './sites.js';
import { versionOutput } from './version.js';

const HELP = `uncage - run AI coding agents behind a local, approval-gated API

Local Mode:
  uncage serve  [--port <n>] [--workspace <dir>] [--data-dir <dir>] [--token-file <file>]
  uncage doctor [--port <n> | --url <url>] [--workspace <dir>] [--data-dir <dir>] [--token-file <file>]
                [--export-events <sessionId> [--out <file>] [--include-content]]

Connected Mode (a website drives this computer):
  uncage setup <url> [--no-daemon] [--no-browser]   Connect this computer to a website.
  uncage agent [--log-file <path>]                  Run the agent in the foreground.
  uncage agent install | uninstall | status [--json]  Manage the background agent (this user).
  uncage sites                                      List connected websites.
  uncage sites remove <id>                          Disconnect a website.
  uncage activity [--site <id>] [--follow]          What websites did on this computer.

  uncage <command> --help
  uncage --version

Zero-config: "uncage serve" works with no setup (optional ./uncage.config.yaml).
Env: UNCAGE_PORT, UNCAGE_LOG_LEVEL; doctor also reads UNCAGE_URL. UNCAGE_HOME (absolute) moves
Connected Mode state (~/.uncage/agent.yaml, ~/Uncage workspaces) for tests/dev; HOME is untouched.`;

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
  const version = versionOutput(cmd);
  if (version !== null) {
    console.log(version);
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
    const sites = await loadAgentConfig(connectedHome())
      .then((c) => c.sites)
      .catch(() => []);
    const checks = await runDoctor({
      config,
      adapters: buildAdapters(config, process.platform === 'win32' ? await resolveAgentExecutables() : {}),
      sites,
      // The background agent never runs with UNCAGE_HOME (setup refuses), so there is no service to check then.
      ...(process.env.UNCAGE_HOME ? {} : { service: await realService() }),
      exec: defaultExec,
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

  if (cmd === 'setup') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        'no-daemon': { type: 'boolean', default: false },
        'no-browser': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    if (values.help || positionals.length !== 1) {
      console.log(SETUP_HELP);
      return values.help ? 0 : 2;
    }
    const conflict = daemonHomeConflict(process.env, values['no-daemon']);
    if (conflict) {
      console.error(conflict);
      return 2;
    }
    await runSetup({
      url: positionals[0]!,
      home: connectedHome(),
      fetch,
      exec: defaultExec,
      out: (l) => console.log(l),
      noDaemon: values['no-daemon'],
      noBrowser: values['no-browser'],
    });
    return 0;
  }

  if (cmd === 'agent') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h', default: false },
        json: { type: 'boolean', default: false },
        'log-file': { type: 'string' },
      },
    });
    if (values.help) {
      console.log(AGENT_HELP);
      return 0;
    }
    const sub = positionals[0];
    if (sub === 'install' || sub === 'uninstall' || sub === 'status') {
      if (positionals.length > 1) {
        console.error(AGENT_HELP);
        return 2;
      }
      if (process.env.UNCAGE_HOME && sub === 'install') {
        console.error('UNCAGE_HOME is for foreground runs: the background agent always uses your home folder. Run "uncage agent" with UNCAGE_HOME instead.');
        return 2;
      }
      const service = await realService();
      if (sub === 'install') {
        await installAgentService({ home: homedir(), exec: defaultExec, out: (l) => console.log(l), service });
        return 0;
      }
      if (sub === 'uninstall') {
        const { removed } = await service.uninstall();
        console.log(removed ? '✓ Background agent stopped and removed. (~/.uncage/agent.yaml is kept.)' : 'The background agent was not installed.');
        return 0;
      }
      const st = await service.status();
      if (values.json) console.log(JSON.stringify(st, null, 2));
      else console.log(formatServiceStatus(st));
      return 0;
    }
    if (positionals.length > 0) {
      console.error(`Unknown agent command "${positionals[0]}".\n\n${AGENT_HELP}`);
      return 2;
    }
    const logFile = values['log-file'] ? resolve(cwd, values['log-file']) : undefined;
    const agent = await runAgent({ home: connectedHome(), ...(logFile ? { logFile } : {}) });
    if (agent.sites === 0) {
      await agent.close();
      console.error('No connected websites. Connect one with: uncage setup <url>');
      return 0; // clean exit: the service manager does not restart it (restart on failure only)
    }
    let stopping = false;
    const stop = () => {
      if (stopping) process.exit(1);
      stopping = true;
      setTimeout(() => process.exit(1), 10_000).unref();
      agent.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return -1;
  }

  if (cmd === 'sites') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { help: { type: 'boolean', short: 'h', default: false } },
    });
    if (values.help) {
      console.log(SITES_HELP);
      return 0;
    }
    if (positionals.length === 0) {
      console.log(await listSites(connectedHome()));
      return 0;
    }
    if (positionals[0] === 'remove' && positionals.length === 2) {
      await removeSite({ home: connectedHome(), id: positionals[1]!, fetch, out: (l) => console.log(l) });
      // The background agent never runs with UNCAGE_HOME (setup refuses), so leave it alone then.
      if (!process.env.UNCAGE_HOME) await (await realService()).restart();
      return 0;
    }
    console.error(SITES_HELP);
    return 2;
  }

  if (cmd === 'activity') {
    const { values } = parseArgs({
      args: rest,
      options: {
        site: { type: 'string' },
        follow: { type: 'boolean', short: 'f', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    if (values.help) {
      console.log(ACTIVITY_HELP);
      return 0;
    }
    await showActivity({
      home: connectedHome(),
      ...(values.site ? { site: values.site } : {}),
      follow: values.follow,
      json: values.json,
      out: (l) => console.log(l),
    });
    return 0;
  }

  console.error(`Unknown command "${cmd}".\n\n${HELP}`);
  return 2;
}

/** The background agent service of this computer (the real home, platform and service manager). */
function realService(): Promise<AgentService> {
  return agentService({ platform: process.platform, home: homedir(), env: process.env, exec: defaultExec, ...(process.getuid ? { uid: process.getuid() } : {}) });
}

function formatServiceStatus(st: Awaited<ReturnType<AgentService['status']>>): string {
  if (st.kind === 'none') return `Background agent: no service manager here.\n${st.detail ?? ''}`;
  if (!st.installed) return `Background agent (${st.kind}): not installed. Install it with: uncage agent install`;
  const lines = [
    `Background agent (${st.kind}): ${st.running ? 'running' : st.running === null ? 'installed' : 'not running'}${st.detail ? ` (${st.detail})` : ''}`,
    `  definition: ${st.definitionPath ?? '?'}`,
  ];
  if (st.spec) {
    lines.push(`  node:       ${st.spec.nodePath} ${st.nodeExists ? (st.nodeVersion ?? '') : '(missing: run uncage agent install)'}`);
    lines.push(`  cli:        ${st.spec.cliEntry}`);
    lines.push(`  logs:       ${st.spec.logsDir}`);
  }
  return lines.join('\n');
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
