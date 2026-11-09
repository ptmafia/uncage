import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
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
import { applyWorkspaceFlag, buildAllAdapters, serve } from './serve.js';
import { defaultExec, DEFAULT_ACP_RUNTIMES, loadAgentConfig } from '@uncage/agent';
import { loadRegistry, refreshRegistry } from '@uncage/runtime-acp';
import { acpCacheDir, setupAcp } from './acp.js';
import { ACTIVITY_HELP, showActivity } from './activity-cmd.js';
import { AGENT_HELP, agentAdapters, resolveAgentExecutables, runAgent } from './agent-cmd.js';
import { RUNTIMES_HELP, runRuntimes, toggleRuntime } from './runtimes-cmd.js';
import { agentService, type AgentService } from './service/index.js';
import { connectedHome, daemonHomeConflict } from './home.js';
import { installAgentService, runSetup, SETUP_HELP } from './setup.js';
import { CONNECT_HELP, runConnect } from './connect.js';
import { DASHBOARD_HELP, startDashboard } from './dashboard/server.js';
import { unregisterUrlHandler } from './service/url-handler.js';
import { listSites, removeSite, SITES_HELP } from './sites.js';
import { rotateLog, superviseAgent, watchSupervisor } from './supervise.js';
import { versionOutput } from './version.js';

const HELP = `uncage - run AI coding agents behind a local, approval-gated API

Local Mode:
  uncage serve  [--port <n>] [--workspace <dir>] [--data-dir <dir>] [--token-file <file>]
  uncage doctor [--port <n> | --url <url>] [--workspace <dir>] [--data-dir <dir>] [--token-file <file>]
                [--export-events <sessionId> [--out <file>] [--include-content]]

Connected Mode (a website drives this computer):
  uncage setup <url> [--no-daemon] [--no-browser] [--no-qr]   Connect this computer to a website.
  uncage connect <url | uncage://connect?url=…>      Connect another website in one click (asks first).
  uncage agent [--log-file <path>]                  Run the agent in the foreground.
  uncage agent install | uninstall | status [--json]  Manage the background agent (this user).
  uncage sites                                      List connected websites.
  uncage sites remove <id>                          Disconnect a website.
  uncage runtimes [--json]                          Agents this computer offers (incl. ACP agents).
  uncage runtimes enable|disable <id>               Turn an ACP agent on or off.
  uncage activity [--site <id>] [--follow]          What websites did on this computer.
  uncage dashboard [--no-browser]                   A local page: sites, status, activity, disconnect.

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
      adapters: await buildAllAdapters(config, home),
      sites,
      // The background agent never runs with UNCAGE_HOME (setup refuses), so there is no service to check then.
      ...(process.env.UNCAGE_HOME ? {} : { service: await realService() }),
      exec: defaultExec,
      fetch,
      home,
      agentHome: connectedHome(),
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
        'no-qr': { type: 'boolean', default: false },
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
      noQr: values['no-qr'],
      isTTY: process.stdout.isTTY === true,
    });
    return 0;
  }

  if (cmd === 'connect') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        'no-browser': { type: 'boolean', default: false },
        'no-qr': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    if (values.help || positionals.length !== 1) {
      console.log(CONNECT_HELP);
      return values.help ? 0 : 2;
    }
    const isTTY = process.stdin.isTTY === true && process.stdout.isTTY === true;
    return runConnect({
      link: positionals[0]!,
      home: connectedHome(),
      fetch,
      exec: defaultExec,
      out: (l) => console.log(l),
      isTTY,
      prompt: async (question, signal) => {
        const { createInterface } = await import('node:readline/promises');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return await rl.question(question, signal ? { signal } : {});
        } finally {
          rl.close();
        }
      },
      noBrowser: values['no-browser'],
      noQr: values['no-qr'],
      // The background agent never runs with UNCAGE_HOME (setup refuses), so leave it alone then.
      service: process.env.UNCAGE_HOME ? null : await realService(),
    });
  }

  if (cmd === 'agent') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h', default: false },
        json: { type: 'boolean', default: false },
        'log-file': { type: 'string' },
        supervise: { type: 'boolean', default: false },
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
        const handler = await unregisterUrlHandler({ platform: process.platform, home: homedir(), exec: defaultExec });
        if (handler.removed) console.log('✓ uncage:// link handler removed.');
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
    // Cap log growth at every start: --log-file, and the files launchd / systemd append to.
    const logsDir = join(connectedHome(), '.uncage', 'logs');
    for (const f of new Set([...(logFile ? [logFile] : []), join(logsDir, 'agent.log'), join(logsDir, 'agent.err.log')])) await rotateLog(f);
    if (values.supervise) {
      // Windows service: keep the agent running (Task Scheduler does not restart a non-zero exit).
      let onStop: () => void = () => undefined;
      const stopSignal = new Promise<void>((r) => (onStop = r));
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(sig, onStop);
      return superviseAgent({
        execPath: process.execPath,
        entry: process.argv[1]!,
        args: ['agent', ...(logFile ? ['--log-file', logFile] : [])],
        ...(logFile ? { logFile } : {}),
        stopSignal,
      });
    }
    watchSupervisor();
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

  if (cmd === 'runtimes') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        json: { type: 'boolean', default: false },
        all: { type: 'boolean', default: false },
        refresh: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    if (values.help) {
      console.log(RUNTIMES_HELP);
      return 0;
    }
    const home = connectedHome();
    if (positionals.length === 2 && (positionals[0] === 'enable' || positionals[0] === 'disable')) {
      await toggleRuntime({ home, id: positionals[1]!, enable: positionals[0] === 'enable', out: (l) => console.log(l), registry: await loadRegistry(acpCacheDir(home)) });
      // The background agent never runs with UNCAGE_HOME (setup refuses), so leave it alone then.
      if (!process.env.UNCAGE_HOME) await (await realService()).restart();
      return 0;
    }
    if (positionals.length > 0) {
      console.error(RUNTIMES_HELP);
      return 2;
    }
    if (values.refresh) {
      try {
        const r = await refreshRegistry({ cacheDir: acpCacheDir(home), fetch });
        if (!values.json) console.log(`ACP registry ${r.version}: ${r.agents.length} agents (refreshed).`);
      } catch (e) {
        console.error(`! Could not refresh the ACP registry (${e instanceof Error ? e.message : String(e)}); using the cached or bundled copy.`);
      }
    }
    const config = await loadAgentConfig(home);
    const { allowBypass } = config.localPolicy;
    const acp = await setupAcp({ acp: config.runtimes?.acp ?? DEFAULT_ACP_RUNTIMES, allowBypass, home });
    return runRuntimes({
      adapters: agentAdapters(allowBypass, acp.adapters, process.platform === 'win32' ? await resolveAgentExecutables() : {}, acp.nativeIcons)(),
      json: values.json,
      all: values.all,
      catalog: acp.catalog,
      out: (l) => console.log(l),
    });
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

  if (cmd === 'dashboard') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        'no-browser': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    if (values.help || positionals.length > 0) {
      console.log(DASHBOARD_HELP);
      return values.help ? 0 : 2;
    }
    const dash = await startDashboard({
      home: connectedHome(),
      exec: defaultExec,
      open: !values['no-browser'],
      fetch,
      // The background agent never runs with UNCAGE_HOME (setup refuses), so leave it alone then.
      service: process.env.UNCAGE_HOME ? null : await realService(),
    });
    console.log(`Uncage dashboard: ${dash.url}`);
    console.log('Only this computer can open it. It stops when you close the page or after 30 minutes idle (Ctrl+C stops it now).');
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => void dash.close());
    await dash.closed;
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
