import { loadAgentConfig, normalizeHubUrl, type ExecFn } from '@uncage/agent';
import { confirmConnect, type ConfirmDeps } from './confirm-dialog.js';
import { agentService, type AgentService } from './service/index.js';
import { pairSite, type PairDeps } from './setup.js';
import { registrableDomain, siteIdentity, type SiteIdentity } from './site-identity.js';

export const CONNECT_HELP = `uncage connect - connect this computer to another website in one click

Usage:
  uncage connect <url | uncage://connect?url=…> [--no-browser] [--no-qr]

What "uncage://" links run. Shows who the website is (its registered domain, full address and
warnings: international characters, a bare IP address, a first connection, a look-alike of a
site you already use) in a dialog on this computer. Only after you click Connect does it start
the usual approval (the website's /device page), save the site in ~/.uncage/agent.yaml and
restart the background agent.

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
}

/**
 * `uncage connect`: parse → site identity (known = registrable domains in agent.yaml) → native
 * confirmation → device flow → restart the background agent if installed. 0 connected,
 * 1 cancelled / refused, 2 bad link. No device flow ever starts without a yes.
 */
export async function runConnect(d: ConnectDeps): Promise<0 | 1 | 2> {
  const parsed = parseConnectLink(d.link);
  if ('error' in parsed) {
    d.out(`Not connected: ${parsed.error}`);
    return 2;
  }
  const platform = d.platform ?? process.platform;
  const env = d.env ?? process.env;
  const isTTY = d.isTTY ?? process.stdout.isTTY === true;
  const config = await loadAgentConfig(d.home);
  const known = [...new Set(config.sites.map((s) => registrableDomain(new URL(s.url).hostname)))];
  const identity = siteIdentity(parsed.url, known);
  const confirm =
    d.confirm ??
    ((i: SiteIdentity) => confirmConnect(i, { platform, exec: d.exec, isTTY, env, out: d.out, ...(d.prompt ? { prompt: d.prompt } : {}) }));
  const yes = await confirm(identity).catch(() => false);
  if (!yes) {
    d.out(`Not connected to ${identity.registrableDomain} (cancelled).`);
    return 1;
  }
  await pairSite({
    url: parsed.url,
    home: d.home,
    fetch: d.fetch,
    exec: d.exec,
    out: d.out,
    platform,
    isTTY,
    expectOrigin: identity.origin,
    ...(d.noBrowser ? { noBrowser: true } : {}),
    ...(d.noQr ? { noQr: true } : {}),
    ...(d.machine ? { machine: d.machine } : {}),
    ...(d.sleep ? { sleep: d.sleep } : {}),
  });
  const service =
    d.service === null
      ? null
      : (d.service ?? (await agentService({ platform, home: d.home, env, exec: d.exec, ...(d.uid !== undefined ? { uid: d.uid } : {}) })));
  if (service && (await service.restart().catch(() => false))) d.out('✓ Background agent restarted: the website can use this computer now.');
  else d.out('The background agent is not running. Start it with: uncage agent (or install it: uncage agent install)');
  return 0;
}
