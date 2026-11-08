import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PermissionModeSchema, type PermissionMode } from '@uncage/protocol';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { replaceFile, restrictToUser } from './perms.js';

/** Site ids and host names become directory names: keep them boring. */
export const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const safeName = z
  .string()
  .regex(SAFE_NAME)
  .refine((s) => !s.includes('..'), { message: 'must not contain ".."' });

export const AgentSiteSchema = z.object({
  id: safeName,
  name: z.string().max(200),
  /** Hub base URL incl. base path, e.g. `https://app.example.com/api/uncage`. */
  url: z.string().url(),
  machineId: z.string().min(1),
  /** Machine token (secret). Only ever stored here, in a 0600 file. */
  token: z.string().min(1),
  /** Random 32-byte base64url id sent at pairing so re-pairing keeps the same machine. */
  machineKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
  /** Set when the hub revoked this machine (close 4401 / HTTP 401): the agent stops dialing it. */
  revokedAt: z.string().optional(),
});
export type AgentSite = z.infer<typeof AgentSiteSchema>;

export const LocalPolicySchema = z
  .object({
    /** Only the user can enable `bypassPermissions`, here. The hub never can. */
    allowBypass: z.boolean().default(false),
    /** Optional cap: permission modes a website may use. Others → `policy_denied`. */
    allowedPermissionModes: z.array(PermissionModeSchema).optional(),
  })
  .strict();

const AgentConfigSchema = z
  .object({
    sites: z.array(AgentSiteSchema).default([]),
    localPolicy: LocalPolicySchema.default({ allowBypass: false }),
  })
  .strict();

export interface AgentConfig {
  sites: AgentSite[];
  localPolicy: { allowBypass: boolean; allowedPermissionModes?: PermissionMode[] };
}

export const agentDir = (home: string = homedir()): string => join(home, '.uncage');
export const agentConfigPath = (home: string = homedir()): string => join(agentDir(home), 'agent.yaml');
export const siteDir = (home: string, siteId: string): string => join(agentDir(home), 'sites', siteId);
export const activityLogPath = (home: string, siteId: string): string => join(siteDir(home, siteId), 'activity.log');

/** A fresh `machineKey`: 32 random bytes, base64url (43 chars). */
export const newMachineKey = (): string => randomBytes(32).toString('base64url');

const EMPTY: AgentConfig = { sites: [], localPolicy: { allowBypass: false } };

async function readRaw(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Could not read ${path}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

/**
 * Loads `~/.uncage/agent.yaml` (missing → no sites, bypass off). The file holds machine tokens, so
 * a group/world-readable file is tightened to 0600.
 */
export async function loadAgentConfig(home: string = homedir()): Promise<AgentConfig> {
  const path = agentConfigPath(home);
  const raw = await readRaw(path);
  if (raw === null) return structuredClone(EMPTY);
  // POSIX mode bits only: on Windows the ACL is set when the file is written (restrictToUser).
  if (process.platform !== 'win32' && ((await stat(path)).mode & 0o077) !== 0) await chmod(path, 0o600);
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) throw new Error(`Invalid ${path}: ${doc.errors[0]!.message}`);
  const parsed = AgentConfigSchema.safeParse(doc.toJS() ?? {});
  if (!parsed.success) {
    const i = parsed.error.issues[0]!;
    throw new Error(`Invalid ${path}: ${i.path.join('.') || '(root)'}: ${i.message}`);
  }
  const { sites, localPolicy } = parsed.data;
  return {
    sites,
    localPolicy: {
      allowBypass: localPolicy.allowBypass,
      ...(localPolicy.allowedPermissionModes ? { allowedPermissionModes: localPolicy.allowedPermissionModes } : {}),
    },
  };
}

/**
 * Creates `~/.uncage` (0700), tightening an existing, group/world-accessible one. On Windows a newly
 * created folder gets a user-only ACL (icacls); an existing one is left as it is.
 */
export async function ensureAgentDir(home: string): Promise<string> {
  const dir = agentDir(home);
  const created = await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    if (created !== undefined) await restrictToUser(dir, { dir: true });
  } else if (((await stat(dir)).mode & 0o077) !== 0) await chmod(dir, 0o700);
  return dir;
}

export const agentConfigLockPath = (home: string = homedir()): string => `${agentConfigPath(home)}.lock`;
/** A lock older than this is presumed left by a crashed process and broken. */
export const CONFIG_LOCK_STALE_MS = 10_000;
const CONFIG_LOCK_WAIT_MS = 15_000;

/**
 * Serializes read-modify-write of agent.yaml across processes (the CLI and the running agent):
 * an exclusive `agent.yaml.lock` file, broken when older than 10 s.
 */
export async function withAgentConfigLock<T>(home: string, fn: () => Promise<T>): Promise<T> {
  await ensureAgentDir(home);
  const lock = agentConfigLockPath(home);
  const token = `${process.pid} ${randomBytes(12).toString('hex')} ${new Date().toISOString()}\n`;
  const start = Date.now();
  for (;;) {
    let created = false;
    try {
      const fh = await open(lock, 'wx', 0o600);
      created = true;
      try {
        await fh.writeFile(token);
      } finally {
        await fh.close();
      }
      break;
    } catch (e) {
      if (created) {
        // Could not write our token: never leave an anonymous lock behind.
        await unlink(lock).catch(() => undefined);
        throw e;
      }
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const first = await stat(lock).catch(() => null);
      if (first && Date.now() - first.mtimeMs > CONFIG_LOCK_STALE_MS) {
        // Re-stat right before breaking it: only remove the very lock we judged stale, not one a
        // live process just created in its place.
        const again = await stat(lock).catch(() => null);
        if (again && again.ino === first.ino && again.mtimeMs === first.mtimeMs) await unlink(lock).catch(() => undefined);
        continue;
      }
      if (Date.now() - start > CONFIG_LOCK_WAIT_MS) {
        throw new Error(`${agentConfigPath(home)} is locked by another uncage process (${lock}).`, { cause: e });
      }
      await new Promise((r) => setTimeout(r, 25 + Math.random() * 25));
    }
  }
  try {
    return await fn();
  } finally {
    // Only release the lock if it is still ours (it may have been broken as stale and re-taken).
    if ((await readFile(lock, 'utf8').catch(() => null)) === token) await unlink(lock).catch(() => undefined);
  }
}

/**
 * Re-reads the file, applies `fn` to its `sites`, and writes it back atomically, user-only (0600 / ACL),
 * under the agent.yaml lock. Comments and `localPolicy` (hand-edited by the user) are preserved.
 */
export function updateAgentSites(home: string, fn: (sites: AgentSite[]) => AgentSite[]): Promise<AgentSite[]> {
  return withAgentConfigLock(home, async () => {
    const path = agentConfigPath(home);
    const current = await loadAgentConfig(home);
    const next = fn(current.sites.map((s) => ({ ...s }))).map((s) => AgentSiteSchema.parse(s));
    const raw = await readRaw(path);
    const doc = parseDocument(raw ?? '');
    if (raw === null || doc.contents === null) {
      doc.contents = doc.createNode({ sites: [], localPolicy: { allowBypass: false } }) as never;
      doc.commentBefore =
        ' Uncage agent config. Holds machine tokens: keep it private (0600).\n' +
        ' localPolicy.allowBypass: true lets websites use bypassPermissions (only you can turn it on).\n' +
        ' localPolicy.allowedPermissionModes: optional list capping the modes websites may use.';
    }
    doc.set('sites', doc.createNode(next));
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, doc.toString(), { mode: 0o600 });
    try {
      await restrictToUser(tmp); // chmod 600, or a user-only ACL on Windows (kept by the rename)
      await replaceFile(tmp, path);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
    return next;
  });
}
