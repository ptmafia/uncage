import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { agentConfigPath, loadAgentConfig, normalizeHubUrl, type ExecFn } from '@uncage/agent';
import { confirmConnect, detectLocale, DIALOG_TIMEOUT_S, type ConfirmDeps } from './confirm-dialog.js';
import { connectNotice, showNotice, type Notice } from './notice.js';
import { agentService, type AgentService } from './service/index.js';
import { pairSite, type PairDeps } from './setup.js';
import { registrableDomain, siteIdentity, type SiteIdentity } from './site-identity.js';
import { rotateLog } from './supervise.js';
import { plainText } from './text.js';

export const CONNECT_HELP = `uncage connect - connect this computer to another website in one click

Usage:
  uncage connect <url | uncage://connect?url=…> [--no-browser] [--no-qr] [--from-link]

What "uncage://" links run. Shows who the website is (its registered domain, address and
warnings: international characters, a bare IP address, a first connection, a look-alike of a
site you already use) in a dialog on this computer. Only after you click Connect does it start
the usual approval (the website's /device page), save the site in ~/.uncage/agent.yaml and
restart the background agent. Whoever runs a connected site can start coding-agent sessions on
this computer at any time, within your local policy: only connect sites you trust.

Note: the restart interrupts sessions that other websites are running on this computer.

Options:
  --no-browser   Do not open a browser; just print the code and link.
  --no-qr        Do not print the link as a QR code.
  --from-link    Set by the uncage:// link handler: the outcome (connected, or why not) is also
                 shown in a system notification, and after Cancel the same site cannot ask again
                 for 30 seconds. On Windows it continues in a hidden window.
  -h, --help     Show this help.

Exit codes: 0 connected, 1 cancelled or refused, 2 bad link.`;

/** Longest link accepted (the raw link and the site URL inside it). */
export const MAX_LINK_LENGTH = 2048;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
// Whitespace and control characters (\p{Cc}: C0, DEL, C1).
const CONTROL_OR_SPACE = /[\s\p{Cc}]/u;

function checkSiteUrl(raw: string): { url: string } | { error: string } {
  if (raw.length > MAX_LINK_LENGTH) return { error: `The site URL is longer than ${MAX_LINK_LENGTH} characters.` };
  if (raw === '' || CONTROL_OR_SPACE.test(raw)) return { error: 'The site URL is empty or contains spaces or control characters.' };
  // "localhost:3000" is a host and port, not a scheme; "javascript:…" is a scheme.
  const hasScheme = /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(raw);
  let u: URL;
  try {
    u = new URL(hasScheme ? raw : `https://${raw}`);
  } catch {
    return { error: `"${raw.slice(0, 200)}" is not a valid URL.` };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: `Only https:// websites can be connected (got ${u.protocol}).` };
  if (u.protocol === 'http:' && !LOOPBACK.has(u.hostname)) return { error: `Refusing plain http for ${u.hostname}: use https:// (http is only allowed for localhost).` };
  if (u.username || u.password) return { error: 'The site URL must not contain a user name or password.' };
  if (!u.hostname || u.hostname.endsWith('.')) return { error: 'The site URL has no valid host name.' };
  if (u.search || u.hash || raw.includes('#') || /\?/.test(raw)) return { error: 'The site URL must not contain a query (?…) or fragment (#…).' };
  try {
    return { url: normalizeHubUrl(u.href) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * `uncage://connect?url=<site>` (exactly one `url` parameter, nothing else) or a bare site URL →
 * the hub URL to pair with. Refused: other schemes (javascript:, data:, file:, …), plain http
 * except loopback, credentials, queries / fragments, extra parameters, control characters and
 * anything longer than 2048 characters.
 */
export function parseConnectLink(raw: string): { url: string } | { error: string } {
  const s = raw.trim();
  if (s.length > MAX_LINK_LENGTH) return { error: `The link is longer than ${MAX_LINK_LENGTH} characters.` };
  if (!/^uncage:/i.test(s)) return checkSiteUrl(s);
  let link: URL;
  try {
    link = new URL(s);
  } catch {
    return { error: 'Not a valid uncage:// link.' };
  }
  if (link.username || link.password || link.port) return { error: 'Not a valid uncage:// link (unexpected user or port).' };
  if (link.hostname.toLowerCase() !== 'connect' || (link.pathname !== '' && link.pathname !== '/')) {
    return { error: 'Unknown uncage:// link: only uncage://connect?url=… is supported.' };
  }
  if (link.hash || s.includes('#')) return { error: 'The uncage:// link must not contain a fragment (#…).' };
  const keys = [...link.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== 'url') return { error: 'The uncage:// link must have exactly one parameter: url.' };
  return checkSiteUrl(link.searchParams.get('url') ?? '');
}

/**
 * A lock whose PID is alive is still held until it is this old (the longest dialog, its cut-off
 * margin, plus slack): after that the PID was most likely reused by another process.
 */
export const LOCK_MAX_AGE_MS = (DIALOG_TIMEOUT_S + 60) * 1000;
/** A takeover lock (held for milliseconds) older than this was left by a crash. */
const TAKEOVER_STALE_MS = 10_000;

/** Whether `pid` runs (EPERM: it runs, as another user). */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Creates `path` exclusively with `<pid> <time> <random token>`; null when another live run holds
 * it. A lock is stale when its PID is not alive, or it is older than `LOCK_MAX_AGE_MS`. A stale
 * lock is taken over under an exclusive `<path>.takeover` lock: checked again, moved aside by an
 * atomic rename, then the exclusive create is retried. `release()` deletes the file only
 * while it still carries our token.
 */
export async function takeLock(path: string, o: { isAlive?: (pid: number) => boolean } = {}): Promise<{ release(): Promise<void> } | null> {
  const isAlive = o.isAlive ?? pidAlive;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(16).toString('base64url');
  const content = `${process.pid} ${new Date().toISOString()} ${token}\n`;
  const read = (p: string) => readFile(p, 'utf8').catch(() => null);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fh = await open(path, 'wx', 0o600);
      try {
        await fh.writeFile(content);
      } finally {
        await fh.close();
      }
      return {
        release: async () => {
          if ((await read(path)) === content) await rm(path, { force: true });
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const stale = async (): Promise<boolean | null> => {
      const held = await read(path);
      const age = await stat(path).then(
        (st) => Date.now() - st.mtimeMs,
        () => null,
      );
      if (held === null || age === null) return null; // released meanwhile
      // Created but not written yet (between the exclusive create and the write): held.
      if (held.trim() === '') return age > TAKEOVER_STALE_MS;
      return !(isAlive(Number(held.trim().split(/\s+/)[0])) && age < LOCK_MAX_AGE_MS);
    };
    const first = await stale();
    if (first === null) continue;
    if (!first) return null;
    // Stale. Take it over under a short exclusive takeover lock, so two runs that both judged it
    // stale cannot both replace it; inside, check again and move it aside by atomic rename.
    const takeover = `${path}.takeover`;
    let mutex;
    try {
      mutex = await open(takeover, 'wx', 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // Another run is taking over right now; a takeover lock left by a crash expires quickly.
      const age = await stat(takeover).then((st) => Date.now() - st.mtimeMs, () => 0);
      if (age > TAKEOVER_STALE_MS) await rm(takeover, { force: true });
      return null;
    }
    try {
      if ((await stale()) === true) {
        const aside = `${path}.stale-${token}`;
        await rename(path, aside).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== 'ENOENT') throw e;
        });
        await rm(aside, { force: true });
      }
    } finally {
      await mutex.close();
      await rm(takeover, { force: true });
    }
  }
  return null;
}

export interface ConnectDeps {
  /** The link or URL given on the command line. */
  link: string;
  home: string;
  fetch: typeof fetch;
  exec: ExecFn;
  out: (line: string) => void;
  platform?: NodeJS.Platform;
  /** Is stdout a terminal (QR code, terminal confirmation)? Default `process.stdout.isTTY`. */
  isTTY?: boolean;
  /** The terminal question (fallback when no dialog tool is available). */
  prompt?: ConfirmDeps['prompt'];
  env?: NodeJS.ProcessEnv;
  /** The confirmation (default `confirmConnect`: the native dialog). */
  confirm?: (i: SiteIdentity) => Promise<boolean>;
  /** The background agent to restart (default: this platform's). Null: leave it alone (UNCAGE_HOME runs). */
  service?: AgentService | null;
  uid?: number;
  noBrowser?: boolean;
  noQr?: boolean;
  machine?: PairDeps['machine'];
  sleep?: PairDeps['sleep'];
  /**
   * Launched by the uncage:// link handler: no terminal to read, so the outcome is also shown with
   * `notify`; a Cancel holds the same registrable domain back for `CANCEL_COOLDOWN_MS`; connect.log
   * is capped.
   */
  fromLink?: boolean;
  /** Shows the outcome natively (default `showNotice`); only with `fromLink`. */
  notify?: (n: Notice) => Promise<void>;
  /** The clock (cool-down). Default `Date.now`. */
  now?: () => number;
}

/** After a Cancel, links for the same registrable domain are refused (no dialog) for this long. */
export const CANCEL_COOLDOWN_MS = 30_000;
/** connect.log (the macOS applet's output) is rotated once past this size. */
export const CONNECT_LOG_MAX_BYTES = 1024 * 1024;

type Cooldowns = Record<string, number>;

async function readCooldowns(path: string): Promise<Cooldowns> {
  try {
    const v: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!v || typeof v !== 'object') return {};
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, number] => typeof e[1] === 'number'));
  } catch {
    return {};
  }
}

/**
 * Windows, `--from-link`: node.exe is a console program, so the link handler opens a console window
 * that would stay for the whole flow. Respawn the same command detached with no window and let
 * the caller exit at once (the notice reports the outcome). True when relaunched.
 */
export function relaunchHidden(o: {
  platform: NodeJS.Platform;
  /** `process.argv`: node, the CLI, then the arguments. */
  argv: string[];
  env: NodeJS.ProcessEnv;
  spawn: (file: string, args: string[], opts: { detached: true; windowsHide: true; stdio: 'ignore'; env: NodeJS.ProcessEnv }) => { unref(): void };
}): boolean {
  if (o.platform !== 'win32' || o.env.UNCAGE_CONNECT_RELAUNCHED === '1') return false;
  const [node, ...args] = o.argv;
  o.spawn(node!, args, { detached: true, windowsHide: true, stdio: 'ignore', env: { ...o.env, UNCAGE_CONNECT_RELAUNCHED: '1' } }).unref();
  return true;
}

/**
 * `uncage connect`: parse → site identity (known = registrable domains in agent.yaml) → native
 * confirmation → device flow → restart the background agent if installed. 0 connected,
 * 1 cancelled / refused, 2 bad link. No device flow ever starts without a yes.
 */
export async function runConnect(d: ConnectDeps): Promise<0 | 1 | 2> {
  const platform = d.platform ?? process.platform;
  const env = d.env ?? process.env;
  const stateDir = dirname(agentConfigPath(d.home));
  const now = d.now ?? Date.now;
  if (d.fromLink) await rotateLog(join(stateDir, 'logs', 'connect.log'), CONNECT_LOG_MAX_BYTES);
  const notify = async (o: Parameters<typeof connectNotice>[0]) => {
    if (!d.fromLink) return;
    const n = connectNotice(o, detectLocale(env));
    await (d.notify ?? ((x: Notice) => showNotice(x, { platform, exec: d.exec, env })))(n).catch(() => undefined);
  };

  const parsed = parseConnectLink(d.link);
  if ('error' in parsed) {
    d.out(`Not connected: ${parsed.error}`);
    await notify({ ok: false, reason: parsed.error });
    return 2;
  }
  const isTTY = d.isTTY ?? process.stdout.isTTY === true;
  const config = await loadAgentConfig(d.home);
  const known = [
    ...new Set(
      config.sites.flatMap((s) => {
        try {
          const host = new URL(s.url).hostname;
          return host ? [registrableDomain(host)] : [];
        } catch {
          return []; // a malformed entry in agent.yaml is skipped, not fatal
        }
      }),
    ),
  ];
  const identity = siteIdentity(parsed.url, known);
  const domain = identity.registrableDomain;
  // A page re-firing the link after each Cancel: hold that domain back for a moment (links only).
  const cooldownFile = join(stateDir, 'connect.cooldown.json');
  if (d.fromLink) {
    const at = (await readCooldowns(cooldownFile))[domain];
    if (at !== undefined && now() - at >= 0 && now() - at < CANCEL_COOLDOWN_MS) {
      d.out(`Not connected: you cancelled ${domain} less than ${CANCEL_COOLDOWN_MS / 1000} s ago. Wait a moment and try again.`);
      return 1;
    }
  }
  const confirm =
    d.confirm ??
    ((i: SiteIdentity) => confirmConnect(i, { platform, exec: d.exec, isTTY, env, out: d.out, ...(d.prompt ? { prompt: d.prompt } : {}) }));
  // One question at a time: a page firing links repeatedly cannot stack dialogs.
  const lock = await takeLock(join(stateDir, 'connect.lock'));
  if (!lock) {
    d.out('Not connected: another "uncage connect" is already asking on this computer.');
    return 1;
  }
  let answer: boolean | 'error';
  try {
    answer = await confirm(identity).catch(() => 'error' as const);
    if (answer === false && d.fromLink) {
      const all = await readCooldowns(cooldownFile);
      const kept = Object.fromEntries(Object.entries(all).filter(([, t]) => now() - t < CANCEL_COOLDOWN_MS));
      await writeFile(cooldownFile, `${JSON.stringify({ ...kept, [domain]: now() })}\n`, { mode: 0o600 }).catch(() => undefined);
    }
  } finally {
    await lock.release();
  }
  if (answer !== true) {
    d.out(`Not connected to ${domain} (cancelled).`);
    return 1;
  }
  let site;
  try {
    site = await pairSite({
      url: parsed.url,
      home: d.home,
      fetch: d.fetch,
      exec: d.exec,
      out: d.out,
      platform,
      isTTY,
      expectUrl: parsed.url,
      ...(d.noBrowser ? { noBrowser: true } : {}),
      ...(d.noQr ? { noQr: true } : {}),
      ...(d.machine ? { machine: d.machine } : {}),
      ...(d.sleep ? { sleep: d.sleep } : {}),
    });
  } catch (e) {
    const reason = plainText(e instanceof Error ? e.message : String(e));
    d.out(`Not connected: ${reason}`);
    await notify({ ok: false, domain, reason });
    return 1;
  }
  const service =
    d.service === null
      ? null
      : (d.service ?? (await agentService({ platform, home: d.home, env, exec: d.exec, ...(d.uid !== undefined ? { uid: d.uid } : {}) })));
  // Note: the restart interrupts sessions other sites are running (documented in CONNECT_HELP).
  if (service && (await service.restart().catch(() => false))) d.out('✓ Background agent restarted: the website can use this computer now.');
  else d.out('The background agent is not running. Start it with: uncage agent (or install it: uncage agent install)');
  await notify({ ok: true, domain: registrableDomain(new URL(site.url).hostname) });
  return 0;
}
