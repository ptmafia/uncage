import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isImageDataUri, sanitizeRuntimeIcon, type RuntimeIcon } from '@uncage/protocol';
import { z } from 'zod';
import snapshot from './registry-snapshot.json' with { type: 'json' };

/**
 * The official ACP Registry (https://github.com/agentclientprotocol/registry, FORMAT.md):
 * `{ version, agents: [{ id, name, version, description, repository?, website?, authors, license,
 * icon (SVG URL), distribution: { binary?: { <platform>: { archive, sha256?, cmd, args?, env? } },
 * npx?: { package, args?, env? }, uvx?: { package, args?, env? } } }] }`.
 */
export const ACP_REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';

export const ACP_PLATFORMS = [
  'darwin-aarch64',
  'darwin-x86_64',
  'linux-aarch64',
  'linux-aarch64-musl',
  'linux-x86_64',
  'linux-x86_64-musl',
  'windows-aarch64',
  'windows-x86_64',
] as const;
export type AcpPlatform = (typeof ACP_PLATFORMS)[number];

export interface AcpRegistryCommand {
  /** Executable name looked up on PATH (the registry's `cmd` basename, without `.exe`). */
  cmd: string;
  args: string[];
  env: Record<string, string>;
}
export interface AcpRegistryPackage {
  /** npm / PyPI package spec, e.g. `@google/gemini-cli@0.67.0`. */
  package: string;
  args: string[];
  env: Record<string, string>;
}
export interface AcpRegistryAgent {
  id: string;
  name: string;
  version: string;
  description?: string;
  website?: string;
  repository?: string;
  /** In a snapshot: the official icon as a base64 data URI. In a raw registry: its URL. */
  icon?: string;
  distribution: { binary?: Partial<Record<AcpPlatform, AcpRegistryCommand>>; npx?: AcpRegistryPackage; uvx?: AcpRegistryPackage };
}
export interface AcpRegistry {
  version: string;
  /** When the registry was downloaded (ISO). */
  fetchedAt: string;
  /** `bundled`: the snapshot shipped with Uncage; `cache`: a refresh downloaded on this computer. */
  source: 'bundled' | 'cache';
  agents: AcpRegistryAgent[];
}

/** Registry ids end up in runtime ids and file names. */
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** `./bin/agent`, `agent.exe`, `.\\pkg\\agent.exe`: relative, no `..`, no spaces or shell syntax. */
const CMD = /^(?:\.[\\/])?(?:[\w.+-]+[\\/])*[\w.-]+$/;
/** npm (`@scope/name@1.2.3`) and PyPI (`name==1.2.3`, `name[extra]`) specs; never option-like. */
const PACKAGE = /^(?:@[a-z0-9][\w.-]*\/)?[A-Za-z0-9][\w.-]*(?:\[[\w,.-]+\])?(?:(?:@|==|>=|<=|~=)[\w.+-]+)?$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** C0/C1 control characters (terminal escapes): never in text shown to the user. */
const CONTROL = /\p{Cc}/u;

/**
 * A registry binary must be the agent itself: interpreters, shells and package runners would let a
 * registry entry run arbitrary code (`node -e …`, `sh -c …`, `npx <anything>`).
 */
const REFUSED_COMMANDS = new Set([
  'node', 'nodejs', 'bun', 'deno', 'ruby', 'perl', 'php', 'lua', 'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh',
  'env', 'cmd', 'powershell', 'pwsh', 'wscript', 'cscript', 'npx', 'uvx', 'bunx', 'pnpm', 'pnpx', 'npm', 'yarn', 'uv', 'pip', 'pipx',
  'osascript', 'sudo', 'doas', 'xargs', 'exec', 'nohup', 'open', 'start',
]);
const isRefusedCommand = (name: string): boolean => REFUSED_COMMANDS.has(name.toLowerCase()) || /^python[\d.]*$/i.test(name);
/** Env vars that change how a process loads code or finds programs. */
const isSensitiveEnv = (name: string): boolean =>
  /^(LD_|DYLD_|PYTHON)/i.test(name) || /_PRELOAD$/i.test(name) || ['NODE_OPTIONS', 'NODE_PATH', 'PATH', 'HOME', 'PATHEXT', 'COMSPEC'].includes(name.toUpperCase());

const optionalText = (max: number) =>
  z
    .string()
    .refine((s) => !CONTROL.test(s))
    .transform((s) => s.slice(0, max))
    .optional()
    .catch(undefined);
/** https only: these links are shown and opened by websites. */
const optionalUrl = z
  .string()
  .url()
  .max(500)
  .refine((u) => u.startsWith('https://'))
  .optional()
  .catch(undefined);
const Env = z
  .record(
    z
      .string()
      .regex(ENV_NAME)
      .refine((n) => !isSensitiveEnv(n), { message: 'sensitive environment variable' }),
    z.string().max(4096),
  )
  .default({});
const Args = z.array(z.string().max(1000)).max(50).default([]);

/** `./opencode`, `.\\goose-package\\goose.exe`, `gemini.cmd` → `opencode`, `goose`, `gemini`. */
export function commandName(cmd: string): string {
  const last = cmd.split(/[\\/]/).pop() ?? cmd;
  return last.replace(/\.(exe|cmd|bat|com)$/i, '');
}

const BinaryTarget = z.object({
  cmd: z
    .string()
    .regex(CMD)
    .refine((c) => !c.split(/[\\/]/).includes('..'), { message: 'must not contain ".."' })
    .transform(commandName)
    .refine((c) => !isRefusedCommand(c), { message: 'interpreters, shells and package runners are refused' }),
  args: Args,
  env: Env,
});
const Package = z.object({ package: z.string().regex(PACKAGE).max(200), args: Args, env: Env });

const EntrySchema = z.object({
  id: z.string().regex(ID),
  name: z
    .string()
    .min(1)
    .max(100)
    .refine((n) => !CONTROL.test(n), { message: 'control characters' }),
  version: z.string().regex(/^[\w.+-]{1,64}$/),
  description: optionalText(300),
  website: optionalUrl,
  repository: optionalUrl,
  icon: z.string().max(100_000).optional().catch(undefined),
  distribution: z
    .object({
      binary: z.record(z.string(), BinaryTarget).optional(),
      npx: Package.optional(),
      uvx: Package.optional(),
    })
    .refine((d) => d.binary !== undefined || d.npx !== undefined || d.uvx !== undefined, { message: 'no supported distribution' }),
});

const RegistrySchema = z.object({ version: z.string().max(64).default('unknown'), agents: z.array(z.unknown()).max(1000) });

function toAgent(e: z.infer<typeof EntrySchema>): AcpRegistryAgent {
  const binary: Partial<Record<AcpPlatform, AcpRegistryCommand>> = {};
  for (const p of ACP_PLATFORMS) {
    const t = e.distribution.binary?.[p];
    if (t) binary[p] = t;
  }
  return {
    id: e.id,
    name: e.name,
    version: e.version,
    ...(e.description ? { description: e.description } : {}),
    ...(e.website ? { website: e.website } : {}),
    ...(e.repository ? { repository: e.repository } : {}),
    ...(e.icon ? { icon: e.icon } : {}),
    distribution: {
      ...(Object.keys(binary).length > 0 ? { binary } : {}),
      ...(e.distribution.npx ? { npx: e.distribution.npx } : {}),
      ...(e.distribution.uvx ? { uvx: e.distribution.uvx } : {}),
    },
  };
}

/**
 * Validates a registry document. Entries that fail validation (or repeat an id) are skipped and
 * listed in `skipped`; a document that is not a registry at all throws.
 */
export function parseRegistry(raw: unknown): { version: string; agents: AcpRegistryAgent[]; skipped: string[] } {
  const doc = RegistrySchema.parse(raw);
  const agents: AcpRegistryAgent[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const item of doc.agents) {
    const e = EntrySchema.safeParse(item);
    if (!e.success || seen.has(e.data.id)) {
      const id = (item as { id?: unknown } | null)?.id;
      skipped.push(typeof id === 'string' ? id : '(no id)');
      continue;
    }
    seen.add(e.data.id);
    agents.push(toAgent(e.data));
  }
  return { version: doc.version, agents, skipped };
}

/** A snapshot (bundled or cached): a registry whose icons are data URIs, plus `fetchedAt`. */
function parseSnapshot(raw: unknown, source: AcpRegistry['source']): AcpRegistry {
  const fetchedAt = z.string().datetime().parse((raw as { fetchedAt?: unknown } | null)?.fetchedAt);
  const { version, agents } = parseRegistry(raw);
  return { version, fetchedAt, source, agents: agents.map((a) => (a.icon && !isImageDataUri(a.icon) ? withoutIcon(a) : a)) };
}

function withoutIcon(a: AcpRegistryAgent): AcpRegistryAgent {
  const rest = { ...a };
  delete rest.icon;
  return rest;
}

let bundled: AcpRegistry | undefined;
/** The registry snapshot shipped with this package (`scripts/snapshot-registry.mjs`). */
export function bundledRegistry(): AcpRegistry {
  bundled ??= parseSnapshot(snapshot, 'bundled');
  return structuredClone(bundled);
}

export const registryCachePath = (cacheDir: string): string => join(cacheDir, 'registry.json');
const attemptPath = (cacheDir: string): string => join(cacheDir, 'refresh.json');

/** The refreshed copy in `cacheDir` when valid, else the bundled snapshot. Never touches the network. */
export async function loadRegistry(cacheDir: string | undefined): Promise<AcpRegistry> {
  if (cacheDir) {
    try {
      return parseSnapshot(JSON.parse(await readFile(registryCachePath(cacheDir), 'utf8')), 'cache');
    } catch {
      // Missing or corrupt: the bundled snapshot.
    }
  }
  return bundledRegistry();
}

const LIGHT_INK = '#1f1f1f';
const DARK_INK = '#f2f2f2';

/**
 * The runtime icon for a registry entry. Registry icons are monochrome SVGs drawn with
 * `currentColor`, which an `<img>` cannot inherit: they get an explicit dark ink (light theme) and
 * light ink (dark theme) variant. Other icons are used as they are.
 */
export function registryIcon(agent: Pick<AcpRegistryAgent, 'icon'>): RuntimeIcon | undefined {
  const uri = agent.icon;
  if (!isImageDataUri(uri)) return undefined;
  if (!uri.startsWith('data:image/svg+xml;base64,')) return sanitizeRuntimeIcon({ light: uri });
  const svg = Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64').toString('utf8');
  if (!/currentColor/i.test(svg)) return sanitizeRuntimeIcon({ light: uri });
  const ink = (color: string) => `data:image/svg+xml;base64,${Buffer.from(svg.replace(/currentColor/gi, color)).toString('base64')}`;
  return sanitizeRuntimeIcon({ light: ink(LIGHT_INK), dark: ink(DARK_INK) });
}

/** Largest icon download; its data URI must stay under the 16 KiB runtime icon cap. */
const MAX_ICON_DOWNLOAD = 12 * 1024;
const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;

const isHttps = (u: string): boolean => {
  try {
    return new URL(u).protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * GETs an https URL and reads at most `max` bytes: the body is streamed and the request aborted
 * as soon as it grows past the cap. A redirect to anything but https is refused. Undefined on any
 * failure.
 */
export async function fetchCapped(url: string, fetchFn: typeof fetch, max: number, timeoutMs: number): Promise<Uint8Array | undefined> {
  if (!isHttps(url)) return undefined;
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]);
  try {
    const res = await fetchFn(url, { signal });
    // A constructed Response (tests) has no url; a real fetch reports the final URL after redirects.
    if (!res.ok || (res.url && !isHttps(res.url))) {
      abort.abort();
      return undefined;
    }
    if (Number(res.headers.get('content-length') ?? '0') > max || !res.body) {
      abort.abort();
      return undefined;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        abort.abort();
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  } catch {
    abort.abort();
    return undefined;
  }
}

/** An SVG icon download as a data URI, or undefined (not https, not an SVG, too large, unreachable). */
export async function downloadIcon(url: string, fetchFn: typeof fetch, timeoutMs = 10_000): Promise<string | undefined> {
  const body = await fetchCapped(url, fetchFn, MAX_ICON_DOWNLOAD, timeoutMs);
  if (!body) return undefined;
  const text = new TextDecoder().decode(body);
  if (!/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text)) return undefined;
  const uri = `data:image/svg+xml;base64,${Buffer.from(body).toString('base64')}`;
  return isImageDataUri(uri) ? uri : undefined;
}

/**
 * Downloads the registry and every entry's icon (as data URIs) into a snapshot document. Nothing
 * downloaded is ever executed. `previous` supplies icons when a download fails.
 */
export async function downloadRegistrySnapshot(o: {
  fetch: typeof fetch;
  url?: string;
  timeoutMs?: number;
  now?: () => Date;
  previous?: AcpRegistry;
}): Promise<{ version: string; fetchedAt: string; agents: AcpRegistryAgent[]; skipped: string[] }> {
  const timeoutMs = o.timeoutMs ?? 15_000;
  const url = o.url ?? ACP_REGISTRY_URL;
  if (!isHttps(url)) throw new Error('The ACP registry URL must be https.');
  const body = await fetchCapped(url, o.fetch, MAX_REGISTRY_BYTES, timeoutMs);
  if (!body) throw new Error('ACP registry download failed (unreachable, not https, or larger than 4 MiB).');
  const { version, agents, skipped } = parseRegistry(JSON.parse(new TextDecoder().decode(body)));
  const previous = new Map((o.previous?.agents ?? []).map((a) => [a.id, a.icon]));
  const withIcons = await Promise.all(
    agents.map(async (a) => {
      const icon = (a.icon ? await downloadIcon(a.icon, o.fetch, timeoutMs) : undefined) ?? previous.get(a.id);
      return icon ? { ...a, icon } : withoutIcon(a);
    }),
  );
  return { version, fetchedAt: (o.now?.() ?? new Date()).toISOString(), agents: withIcons, skipped };
}

async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, path);
}

/** Downloads a fresh registry into `cacheDir` (explicit refresh: `uncage runtimes --refresh`). Throws when offline. */
export async function refreshRegistry(o: { cacheDir: string; fetch: typeof fetch; url?: string; timeoutMs?: number; now?: () => Date }): Promise<AcpRegistry> {
  const previous = await loadRegistry(o.cacheDir);
  const { version, fetchedAt, agents } = await downloadRegistrySnapshot({ ...o, previous });
  const stored = { version, fetchedAt, agents };
  await mkdir(o.cacheDir, { recursive: true, mode: 0o700 });
  await writeAtomic(registryCachePath(o.cacheDir), `${JSON.stringify(stored)}\n`);
  return { ...stored, source: 'cache' };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * At most one refresh attempt per `maxAgeMs` (default a day), successful or not, so an offline
 * computer does not retry on every start. Never throws.
 */
export async function refreshRegistryIfStale(o: {
  cacheDir: string;
  fetch: typeof fetch;
  url?: string;
  timeoutMs?: number;
  now?: () => Date;
  maxAgeMs?: number;
}): Promise<'refreshed' | 'fresh' | 'failed'> {
  const now = o.now?.() ?? new Date();
  const maxAge = o.maxAgeMs ?? DAY_MS;
  try {
    const last = JSON.parse(await readFile(attemptPath(o.cacheDir), 'utf8')) as { attemptedAt?: unknown };
    const at = typeof last.attemptedAt === 'string' ? Date.parse(last.attemptedAt) : NaN;
    if (Number.isFinite(at) && now.getTime() - at < maxAge && at <= now.getTime()) return 'fresh';
  } catch {
    // Never attempted.
  }
  try {
    await mkdir(o.cacheDir, { recursive: true, mode: 0o700 });
    await writeAtomic(attemptPath(o.cacheDir), `${JSON.stringify({ attemptedAt: now.toISOString() })}\n`);
    await refreshRegistry({ ...o, now: () => now });
    return 'refreshed';
  } catch {
    return 'failed';
  }
}
