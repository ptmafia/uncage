import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import type { ExecFn } from '@uncage/agent';
import { findCommand as defaultFindCommand, systemTool } from '@uncage/protocol/node';
import type { ServiceSpec } from './types.js';

/**
 * The OS handler for `uncage://connect?url=…` links: it runs the pinned Node + CLI
 * `connect <link>`, which asks the user (native dialog) before any pairing.
 */

export const URL_SCHEME = 'uncage';
export const MAC_BUNDLE_ID = 'dev.uncage.connect';
export const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
export const DESKTOP_FILE = 'uncage-connect.desktop';

export interface UrlHandlerDeps {
  platform: NodeJS.Platform;
  home: string;
  exec: ExecFn;
  /** XDG_DATA_HOME / XDG_CONFIG_HOME (Linux), SystemRoot (Windows), PATH. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Finds xdg-mime (Linux). Default `findCommand` from @uncage/protocol/node. */
  findCommand?: (cmd: string) => Promise<string | null>;
  /** The URL scheme (tests use a throwaway one). Default `uncage`. */
  scheme?: string;
}

export interface RegisterResult {
  /** Whether the OS now opens the scheme with us. */
  registered: boolean;
  /** The bundle, .desktop file or registry key ('' when nothing was written). */
  location: string;
  /** Hints to print (why it is not registered). */
  notes: string[];
}

const errText = (e: unknown): string => (e as { stderr?: string }).stderr?.trim() || (e instanceof Error ? e.message : String(e));

function assertNoLineBreaks(spec: ServiceSpec): void {
  for (const [what, v] of [
    ['Node path', spec.nodePath],
    ['CLI path', spec.cliEntry],
    ['logs folder', spec.logsDir],
    ['PATH', spec.env.PATH],
  ] as const) {
    if (/[\r\n\0]/.test(v)) throw new Error(`Cannot register the uncage:// link handler: the ${what} contains a line break (${JSON.stringify(v)}).`);
  }
}

// ---------- macOS: a compiled AppleScript applet (URLs arrive as Apple Events, not argv) ----------

const macDir = (home: string): string => posix.join(home, 'Library', 'Application Support', 'Uncage');
export const macAppPath = (home: string): string => posix.join(macDir(home), 'UncageConnect.app');
const macSourcePath = (home: string): string => posix.join(macDir(home), 'UncageConnect.applescript');

/** POSIX shell single quoting. */
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
/** An AppleScript string literal's content. */
const asq = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * The applet: `on open location` runs `<node> <cli> connect <url>` (URL shell-quoted by AppleScript's
 * `quoted form of`) in the background with the service PATH, logging to `connect.log`.
 */
export function appleScriptSource(spec: ServiceSpec): string {
  assertNoLineBreaks(spec);
  const cmd = `PATH=${shq(spec.env.PATH)} ${shq(spec.nodePath)} ${shq(spec.cliEntry)} connect `;
  const tail = ` >> ${shq(posix.join(spec.logsDir, 'connect.log'))} 2>&1 &`;
  return [
    'on open location theURL',
    `\tdo shell script "${asq(cmd)}" & quoted form of theURL & "${asq(tail)}"`,
    'end open location',
    '',
    'on run',
    'end run',
    '',
  ].join('\n');
}

const plistString = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** osacompile's Info.plist + our bundle id, the URL scheme and no Dock icon (idempotent). */
export function patchInfoPlist(text: string, scheme: string): string {
  let out = text.replace(/(<key>CFBundleIdentifier<\/key>\s*<string>)[^<]*(<\/string>)/, `$1${MAC_BUNDLE_ID}$2`);
  out = out.replace(/\s*<key>CFBundleURLTypes<\/key>\s*<array>[\s\S]*?<\/array>\s*<\/dict>\s*<\/array>/, '');
  out = out.replace(/\s*<key>LSUIElement<\/key>\s*<(true|false)\/>/, '');
  const add = [
    '\t<key>CFBundleURLTypes</key>',
    '\t<array>',
    '\t\t<dict>',
    '\t\t\t<key>CFBundleURLName</key>',
    `\t\t\t<string>${MAC_BUNDLE_ID}</string>`,
    '\t\t\t<key>CFBundleURLSchemes</key>',
    '\t\t\t<array>',
    `\t\t\t\t<string>${plistString(scheme)}</string>`,
    '\t\t\t</array>',
    '\t\t</dict>',
    '\t</array>',
    '\t<key>LSUIElement</key>',
    '\t<true/>',
  ].join('\n');
  const end = out.lastIndexOf('</dict>');
  if (end < 0) throw new Error('Unexpected Info.plist from osacompile (no <dict>).');
  return `${out.slice(0, end).trimEnd()}\n${add}\n${out.slice(end)}`;
}

async function registerMac(d: UrlHandlerDeps, spec: ServiceSpec, scheme: string): Promise<RegisterResult> {
  const app = macAppPath(d.home);
  const src = macSourcePath(d.home);
  await mkdir(macDir(d.home), { recursive: true });
  await writeFile(src, appleScriptSource(spec), { mode: 0o644 });
  await rm(app, { recursive: true, force: true });
  try {
    await d.exec('/usr/bin/osacompile', ['-o', app, src]);
    const plistPath = posix.join(app, 'Contents', 'Info.plist');
    await writeFile(plistPath, patchInfoPlist(await readFile(plistPath, 'utf8'), scheme));
  } catch (e) {
    await rm(app, { recursive: true, force: true });
    return { registered: false, location: '', notes: [`Could not build the uncage:// link handler (osacompile): ${errText(e)}`] };
  }
  const notes: string[] = [];
  // Info.plist changed after osacompile signed the applet: sign it again (ad hoc).
  await d.exec('/usr/bin/codesign', ['--force', '--sign', '-', app]).catch((e: unknown) => notes.push(`Could not re-sign the link handler: ${errText(e)}`));
  try {
    await d.exec(LSREGISTER, ['-f', app]);
  } catch (e) {
    return { registered: false, location: app, notes: [...notes, `Could not register the uncage:// link handler with LaunchServices: ${errText(e)}`] };
  }
  return { registered: true, location: app, notes };
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

async function unregisterMac(d: UrlHandlerDeps): Promise<{ removed: boolean }> {
  const app = macAppPath(d.home);
  const had = await exists(app);
  if (had) await d.exec(LSREGISTER, ['-u', app]).catch(() => undefined);
  await rm(app, { recursive: true, force: true });
  await rm(macSourcePath(d.home), { force: true });
  return { removed: had };
}

// ---------- Linux: a .desktop file + xdg-mime ----------

const xdgDir = (env: NodeJS.ProcessEnv, name: 'XDG_DATA_HOME' | 'XDG_CONFIG_HOME', fallback: string): string => {
  const v = env[name];
  return v && posix.isAbsolute(v) ? v : fallback;
};
const desktopPath = (home: string, env: NodeJS.ProcessEnv): string =>
  posix.join(xdgDir(env, 'XDG_DATA_HOME', posix.join(home, '.local', 'share')), 'applications', DESKTOP_FILE);

/** One Exec argument (Desktop Entry spec): quoted when needed, `%` doubled, then string-escaped. */
function execArg(a: string): string {
  const pct = a.replace(/%/g, '%%');
  const quoted = /^[A-Za-z0-9_\-./+,:=@%]+$/.test(pct) ? pct : `"${pct.replace(/(["`$\\])/g, '\\$1')}"`;
  return quoted.replace(/\\/g, '\\\\');
}

/** `uncage-connect.desktop`: `Exec=<node> <cli> connect %u`, hidden from menus. */
export function desktopEntry(spec: ServiceSpec, scheme: string = URL_SCHEME): string {
  assertNoLineBreaks(spec);
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Uncage Connect',
    'Comment=Connect this computer to a website that uses Uncage',
    `Exec=${execArg(spec.nodePath)} ${execArg(spec.cliEntry)} connect %u`,
    `MimeType=x-scheme-handler/${scheme};`,
    'NoDisplay=true',
    'Terminal=false',
    '',
  ].join('\n');
}

async function registerLinux(d: UrlHandlerDeps, spec: ServiceSpec, scheme: string, env: NodeJS.ProcessEnv): Promise<RegisterResult> {
  const file = desktopPath(d.home, env);
  await mkdir(posix.dirname(file), { recursive: true });
  await writeFile(file, desktopEntry(spec, scheme), { mode: 0o644 });
  const find = d.findCommand ?? ((c: string) => defaultFindCommand(c, { platform: 'linux', env }));
  const xdgMime = await find('xdg-mime');
  if (!xdgMime) return { registered: false, location: file, notes: [`xdg-mime not found: uncage:// links will not open "uncage connect" (install xdg-utils, then run "uncage agent install" again).`] };
  try {
    await d.exec(xdgMime, ['default', DESKTOP_FILE, `x-scheme-handler/${scheme}`]);
  } catch (e) {
    return { registered: false, location: file, notes: [`xdg-mime could not register the uncage:// link handler: ${errText(e)}`] };
  }
  return { registered: true, location: file, notes: [] };
}

async function unregisterLinux(d: UrlHandlerDeps, scheme: string, env: NodeJS.ProcessEnv): Promise<{ removed: boolean }> {
  const file = desktopPath(d.home, env);
  const had = await exists(file);
  await rm(file, { force: true });
  // Drop our default from mimeapps.list (xdg-mime has no "unset"); other lines stay untouched.
  const list = posix.join(xdgDir(env, 'XDG_CONFIG_HOME', posix.join(d.home, '.config')), 'mimeapps.list');
  const text = await readFile(list, 'utf8').catch(() => null);
  if (text !== null) {
    const ours = `x-scheme-handler/${scheme}=${DESKTOP_FILE}`;
    const kept = text.split('\n').filter((l) => l.trim() !== ours);
    if (kept.length !== text.split('\n').length) await writeFile(list, kept.join('\n'));
  }
  return { removed: had };
}

// ---------- Windows: HKCU\Software\Classes\<scheme> ----------

const winKey = (scheme: string): string => `HKCU\\Software\\Classes\\${scheme}`;

/** `"<node>" "<cli>" connect "%1"` (paths cannot hold `"` on Windows; refused anyway). */
export function windowsCommand(spec: ServiceSpec): string {
  assertNoLineBreaks(spec);
  for (const p of [spec.nodePath, spec.cliEntry]) {
    if (p.includes('"')) throw new Error(`Cannot register the uncage:// link handler: ${p} contains a quote.`);
  }
  return `"${spec.nodePath}" "${spec.cliEntry}" connect "%1"`;
}

async function registerWindows(d: UrlHandlerDeps, spec: ServiceSpec, scheme: string, env: NodeJS.ProcessEnv): Promise<RegisterResult> {
  const reg = systemTool('reg', { platform: 'win32', env });
  const key = winKey(scheme);
  try {
    await d.exec(reg, ['add', key, '/ve', '/d', 'URL:Uncage Connect', '/f']);
    await d.exec(reg, ['add', key, '/v', 'URL Protocol', '/d', '', '/f']);
    await d.exec(reg, ['add', `${key}\\shell\\open\\command`, '/ve', '/d', windowsCommand(spec), '/f']);
  } catch (e) {
    return { registered: false, location: key, notes: [`Could not register the uncage:// link handler (reg add ${key}): ${errText(e)}`] };
  }
  return { registered: true, location: key, notes: [] };
}

async function unregisterWindows(d: UrlHandlerDeps, scheme: string, env: NodeJS.ProcessEnv): Promise<{ removed: boolean }> {
  return d.exec(systemTool('reg', { platform: 'win32', env }), ['delete', winKey(scheme), '/f']).then(
    () => ({ removed: true }),
    () => ({ removed: false }),
  );
}

// ---------- entry points ----------

/**
 * Makes `uncage://` links run `<node> <cli> connect <link>` for this user (no admin rights):
 * macOS `~/Library/Application Support/Uncage/UncageConnect.app` (registered with lsregister),
 * Linux `uncage-connect.desktop` + `xdg-mime default`, Windows `HKCU\Software\Classes\uncage`.
 * Never throws for an OS refusal: `registered: false` with notes.
 */
export async function registerUrlHandler(d: UrlHandlerDeps & { spec: ServiceSpec }): Promise<RegisterResult> {
  const scheme = d.scheme ?? URL_SCHEME;
  const env = d.env ?? process.env;
  if (d.platform === 'darwin') return registerMac(d, d.spec, scheme);
  if (d.platform === 'linux') return registerLinux(d, d.spec, scheme, env);
  if (d.platform === 'win32') return registerWindows(d, d.spec, scheme, env);
  return { registered: false, location: '', notes: [`uncage:// links are not supported on ${d.platform}; run "uncage connect <url>" instead.`] };
}

/** Removes what `registerUrlHandler` wrote (`uncage agent uninstall`). */
export async function unregisterUrlHandler(d: UrlHandlerDeps): Promise<{ removed: boolean }> {
  const scheme = d.scheme ?? URL_SCHEME;
  const env = d.env ?? process.env;
  if (d.platform === 'darwin') return unregisterMac(d);
  if (d.platform === 'linux') return unregisterLinux(d, scheme, env);
  if (d.platform === 'win32') return unregisterWindows(d, scheme, env);
  return { removed: false };
}
