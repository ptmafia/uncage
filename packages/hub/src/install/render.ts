import { INSTALL_SH_TEMPLATE } from './embedded.js';
import { INSTALL_MESSAGES, type InstallLocale, type InstallMessageKey } from './messages.js';

/** npm version ranges accepted for `cliVersionRange` (no shell metacharacters can get through). */
const RANGE = /^(latest|next|[\^~]?\d+(\.\d+){0,2}(-[0-9A-Za-z.]+)?)$/;

export function assertVersionRange(range: string): string {
  if (!RANGE.test(range)) throw new Error(`createHub: invalid cliVersionRange "${range}" (use e.g. ^0.2, ~0.2.1, 0.2.0 or latest)`);
  return range;
}

/** `^<major>.<minor>` of a version: `0.2.3` → `^0.2`. */
export function defaultCliRange(version: string): string {
  const m = /^(\d+)\.(\d+)/.exec(version);
  return m ? `^${m[1]}.${m[2]}` : 'latest';
}

const SCRIPT_URL = /^(https?):\/\/(\[::1\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?(\/[A-Za-z0-9._~/-]*)?$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The site URL embedded in the installers (`uncage setup <url>`): `https://host[:port][/path]` with
 * `[A-Za-z0-9._~/-]` only, so it is inert inside any shell or PowerShell quoting. Plain http only
 * for localhost / 127.0.0.1 / [::1] (the CLI refuses anything else). Throws otherwise.
 */
export function assertScriptUrl(url: string): string {
  const m = SCRIPT_URL.exec(url);
  const ok = m !== null && (m[3] === undefined || Number(m[3]) <= 65_535) && (m[1] === 'https' || LOOPBACK.has(m[2]!.toLowerCase()));
  if (!ok) {
    throw new Error(
      `createHub: the site URL "${url}" cannot be embedded in the install script (use https://host[:port][/path] with letters, digits and . _ ~ / - only; plain http only for localhost)`,
    );
  }
  return url;
}

export interface InstallScriptExtension {
  /** Bash run after the CLI is installed, before the agent check (static text, ≤ 16 KiB, no NUL). */
  shAfterCli?: string;
  /** PowerShell for install.ps1 at the same point (ASCII only, ≤ 16 KiB). */
  ps1AfterCli?: string;
  /** Replaces the "no agent found" help (one line per locale; en required). */
  agentHelp?: { en: string; zh?: string; ja?: string };
}

export interface InstallScriptOptions {
  cliRange: string;
  siteUrl: string;
  extend?: InstallScriptExtension;
}

const MAX_EXTENSION_BYTES = 16 * 1024;
const MAX_AGENT_HELP_CHARS = 500;
const EXT_EOF = 'UNCAGE_EXTENSION_EOF';

const byteLength = (s: string): number => new TextEncoder().encode(s).length;

/** Validates a developer extension (static text only; never request data). */
export function assertInstallExtension(ext: InstallScriptExtension | undefined): InstallScriptExtension {
  if (ext === undefined) return {};
  const bad = (what: string): never => {
    throw new Error(`createHub: invalid installScript.${what}`);
  };
  if (ext.shAfterCli !== undefined) {
    const s = ext.shAfterCli;
    if (typeof s !== 'string' || byteLength(s) > MAX_EXTENSION_BYTES) bad('shAfterCli (a string of at most 16 KiB)');
    if (s.includes('\0')) bad('shAfterCli (must not contain NUL)');
    if (s.split(/\r?\n/).some((l) => l.trim() === EXT_EOF)) bad(`shAfterCli (must not contain a line "${EXT_EOF}")`);
  }
  if (ext.ps1AfterCli !== undefined) {
    const s = ext.ps1AfterCli;
    if (typeof s !== 'string' || byteLength(s) > MAX_EXTENSION_BYTES) bad('ps1AfterCli (a string of at most 16 KiB)');
    // eslint-disable-next-line no-control-regex
    if (!/^[\x01-\x7f]*$/.test(s)) bad('ps1AfterCli (ASCII only, no NUL)');
  }
  if (ext.agentHelp !== undefined) {
    const h = ext.agentHelp;
    if (typeof h !== 'object' || h === null || typeof h.en !== 'string' || h.en.trim() === '') bad('agentHelp (en is required)');
    for (const [k, v] of Object.entries(h)) {
      if (!['en', 'zh', 'ja'].includes(k)) bad(`agentHelp.${k} (only en, zh, ja)`);
      if (v === undefined) continue;
      if (typeof v !== 'string' || v.length > MAX_AGENT_HELP_CHARS || /[\r\n\0]/.test(v)) bad(`agentHelp.${k} (one line of at most ${MAX_AGENT_HELP_CHARS} characters)`);
    }
  }
  return ext;
}

/** Bash single-quoted literal. */
const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
/** Literal text as a printf format. */
const printfLiteral = (s: string): string => s.replace(/\\/g, '\\\\').replace(/%/g, '%%');

function shMessages(agentHelp: InstallScriptExtension['agentHelp']): string {
  const locales: InstallLocale[] = ['en', 'zh', 'ja'];
  const out: string[] = [
    '# Messages (generated from packages/hub/src/install/messages.ts): uncage_msg <key> sets M.',
    'uncage_msg() {',
    '  case "${UL:-en}" in',
    '    zh) uncage_msg_zh "$1" ;;',
    '    ja) uncage_msg_ja "$1" ;;',
    '    *) uncage_msg_en "$1" ;;',
    '  esac',
    '}',
  ];
  for (const l of locales) {
    const table: Record<string, string> = { ...INSTALL_MESSAGES[l] };
    if (agentHelp) table['no_agent' satisfies InstallMessageKey] = printfLiteral(agentHelp[l] ?? agentHelp.en);
    out.push('', `uncage_msg_${l}() {`, '  case "$1" in');
    for (const [k, v] of Object.entries(table)) out.push(`    ${k}) M=${shQuote(v)} ;;`);
    out.push('    *) M="$1" ;;', '  esac', '}');
  }
  return out.join('\n');
}

function shExtension(text: string | undefined): string {
  if (!text) return ["# The website's own install step (HubOptions.installScript.shAfterCli): none.", 'uncage_extension() {', "  UNCAGE_EXT=''", '}'].join('\n');
  return [
    "# The website's own install step (HubOptions.installScript.shAfterCli), run after the CLI install.",
    'uncage_extension() {',
    `  IFS= read -r -d '' UNCAGE_EXT <<'${EXT_EOF}' || true`,
    text.replace(/\r\n/g, '\n').replace(/\n$/, ''),
    EXT_EOF,
    '}',
  ].join('\n');
}

const replaceOnce = (s: string, token: string, value: string): string => {
  if (!s.includes(token)) throw new Error(`install script template: missing ${token}`);
  return s.split(token).join(value);
};

/**
 * The bash installer served at `<basePath>/install.sh`. Fixed content: it only varies by the
 * validated CLI range, the validated site URL and the developer's static extension text. It never
 * runs anything the website sends at run time.
 */
export function installScript(o: InstallScriptOptions): string {
  const range = assertVersionRange(o.cliRange);
  const url = assertScriptUrl(o.siteUrl);
  const ext = assertInstallExtension(o.extend);
  let s = INSTALL_SH_TEMPLATE;
  s = replaceOnce(s, '# @@MESSAGES@@', shMessages(ext.agentHelp));
  s = replaceOnce(s, '# @@EXTENSION@@', shExtension(ext.shAfterCli));
  s = replaceOnce(s, '@@CLI_RANGE@@', range);
  s = replaceOnce(s, '@@SITE_URL@@', url);
  return s;
}
