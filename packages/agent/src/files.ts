import { open, lstat, readdir, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { UncageError } from '@uncage/core';
import { RelativePathSchema, type AgentFrame } from '@uncage/protocol';

/** Per-file cap of a `file_pull` (the protocol's `file_done` limit). */
export const MAX_PULL_FILE_BYTES = 10 * 1024 * 1024;
/** Default (and maximum) total of a `file_pull`. */
export const MAX_PULL_TOTAL_BYTES = 50 * 1024 * 1024;
/** Raw bytes per `file_chunk` (256 KiB). */
export const PULL_CHUNK_BYTES = 256 * 1024;
/** Most files one pull may return. */
export const MAX_PULL_FILES = 10_000;

const isWithin = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

const toPosix = (p: string): string => p.split(sep).join('/');

interface PullFile {
  abs: string;
  /** Relative to the session workspace, forward slashes. */
  rel: string;
  size: number;
  /** Identity at planning time: the opened file must be the same inode. */
  dev: number;
  ino: number;
}

export interface PullPlan {
  /** Realpath of the session workspace. */
  root: string;
  /** Total byte cap for this pull. */
  limit: number;
  files: PullFile[];
}

const tooLarge = (path: string, limit: number) =>
  new UncageError('invalid_request', { message: `"${path}" is larger than the ${limit}-byte limit for one pull.`, details: { maxBytes: limit } });
const fileTooLarge = (rel: string, size: number) =>
  new UncageError('invalid_request', {
    message: `"${rel}" is ${size} bytes; files larger than ${MAX_PULL_FILE_BYTES} bytes cannot be pulled.`,
    details: { path: rel, size, maxFileBytes: MAX_PULL_FILE_BYTES },
  });
const hardLinked = (rel: string) =>
  new UncageError('invalid_request', {
    message: `"${rel}" has more than one hard link and cannot be pulled (a hard link may point outside the workspace).`,
    details: { path: rel },
  });
const changed = (rel: string) => new UncageError('invalid_request', { message: `"${rel}" changed while it was being pulled.` });

/**
 * Resolves what a `file_pull` of `path` covers inside `workspace`, refusing anything outside it.
 * `path` must pass `RelativePathSchema`, and its realpath must stay inside the workspace's
 * realpath (so a symlink pointing out is refused). Walking a directory never follows symlinks:
 * they are skipped, and before each `readdir` the directory's realpath and inode are re-checked
 * (a directory swapped for a symlink mid-walk is refused). Caps (`maxBytes` total, 10 MiB per
 * file, 10 000 files) are checked before any byte is sent, and again on the bytes actually read.
 */
export async function planPull(workspace: string, path: string, maxBytes: number): Promise<PullPlan> {
  if (!RelativePathSchema.safeParse(path).success) {
    throw new UncageError('invalid_request', { message: `Invalid path "${path}".` });
  }
  const limit = Math.min(maxBytes, MAX_PULL_TOTAL_BYTES);
  const root = await realpath(workspace);
  let target: string;
  try {
    target = await realpath(join(root, ...path.split('/')));
  } catch {
    throw new UncageError('not_found', { message: `"${path}" does not exist in the session workspace.` });
  }
  if (!isWithin(target, root)) {
    throw new UncageError('invalid_request', { message: `"${path}" is outside the session workspace.` });
  }

  const files: PullFile[] = [];
  let total = 0;
  const add = async (abs: string, st: { size: number; dev: number; ino: number; nlink: number }) => {
    const rel = toPosix(relative(root, abs));
    if ((await realpath(abs).catch(() => null)) !== abs) throw changed(rel);
    if (st.nlink > 1) throw hardLinked(rel);
    if (st.size > MAX_PULL_FILE_BYTES) throw fileTooLarge(rel, st.size);
    total += st.size;
    if (total > limit) throw tooLarge(path, limit);
    if (files.length >= MAX_PULL_FILES) {
      throw new UncageError('invalid_request', { message: `"${path}" has more than ${MAX_PULL_FILES} files.`, details: { maxFiles: MAX_PULL_FILES } });
    }
    if (!RelativePathSchema.safeParse(rel).success) return; // a name the protocol cannot carry: skip
    files.push({ abs, rel, size: st.size, dev: st.dev, ino: st.ino });
  };

  /** `dir` is canonical (built from the root realpath + real names); `id` is its lstat identity. */
  const walk = async (dir: string, id: { dev: number; ino: number }): Promise<void> => {
    const [real, now] = await Promise.all([realpath(dir).catch(() => null), lstat(dir).catch(() => null)]);
    if (real !== dir || !now?.isDirectory() || now.dev !== id.dev || now.ino !== id.ino || !isWithin(real, root)) {
      throw changed(toPosix(relative(root, dir)) || '.');
    }
    const entries = await readdir(dir, { withFileTypes: true });
    if ((await realpath(dir).catch(() => null)) !== dir) throw changed(toPosix(relative(root, dir)) || '.');
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      if (!ent.isDirectory() && !ent.isFile()) continue; // symlinks, sockets, devices: skipped
      const st = await lstat(abs);
      if (st.isDirectory()) await walk(abs, st);
      else if (st.isFile()) await add(abs, st);
    }
  };

  const st = await lstat(target);
  if (st.isDirectory()) await walk(target, st);
  else if (st.isFile()) await add(target, st);
  else throw new UncageError('invalid_request', { message: `"${path}" is not a file or directory.` });
  return { root, limit, files };
}

/**
 * Streams the planned files as `file_chunk` frames (256 KiB raw per chunk, `seq` per file from 0,
 * `last` on each file's final chunk; an empty file is one empty chunk), then `file_done`.
 * Each file is opened with `O_NOFOLLOW`, must still be the planned inode, and its realpath must
 * still be inside the workspace (catches swapped intermediate directories). Reads never go past the
 * size seen at open; the per-file and total caps are enforced on the bytes actually read.
 */
export async function sendPull(
  id: string,
  plan: PullPlan,
  send: (f: AgentFrame) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const { constants } = await import('node:fs');
  const done: Array<{ path: string; size: number }> = [];
  let total = 0;
  for (const f of plan.files) {
    if (signal?.aborted) throw new UncageError('machine_offline');
    // Residual race: Node has no openat(2)/O_BENEATH, so an intermediate directory can still be
    // swapped between these checks and open(). The inode + realpath checks before and after open
    // make that window tiny and refuse any file that is not the one planned; it cannot be closed
    // completely from userland Node.
    if ((await realpath(f.abs).catch(() => null)) !== f.abs) throw changed(f.rel);
    let fh;
    try {
      fh = await open(f.abs, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      throw changed(f.rel);
    }
    try {
      const st = await fh.stat();
      if (!st.isFile() || st.dev !== f.dev || st.ino !== f.ino) throw changed(f.rel);
      if (st.nlink > 1) throw hardLinked(f.rel);
      const real = await realpath(f.abs).catch(() => null);
      if (real !== f.abs || !isWithin(real, plan.root)) throw changed(f.rel);
      if (st.size > MAX_PULL_FILE_BYTES) throw fileTooLarge(f.rel, st.size);
      if (total + st.size > plan.limit) throw tooLarge(f.rel, plan.limit);
      const buf = Buffer.alloc(PULL_CHUNK_BYTES);
      let seq = 0;
      let sent = 0;
      for (;;) {
        const want = Math.min(PULL_CHUNK_BYTES, st.size - sent);
        const { bytesRead } = want > 0 ? await fh.read(buf, 0, want, sent) : { bytesRead: 0 };
        sent += bytesRead;
        total += bytesRead;
        if (sent > MAX_PULL_FILE_BYTES) throw fileTooLarge(f.rel, sent);
        if (total > plan.limit) throw tooLarge(f.rel, plan.limit);
        const last = bytesRead < want || sent >= st.size;
        await send({ t: 'file_chunk', id, path: f.rel, seq: seq++, data: buf.subarray(0, bytesRead).toString('base64'), last });
        if (last) break;
      }
      done.push({ path: f.rel, size: sent });
    } finally {
      await fh.close();
    }
  }
  await send({ t: 'file_done', id, files: done });
}
