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
}

/**
 * Resolves what a `file_pull` of `path` covers inside `workspace`, refusing anything outside it.
 * `path` must pass `RelativePathSchema`, and its realpath must stay inside the workspace's
 * realpath (so a symlink pointing out is refused). Walking a directory never follows symlinks:
 * they are skipped. Caps (`maxBytes` total, 10 MiB per file, 10 000 files) are checked before any
 * byte is sent.
 */
export async function planPull(workspace: string, path: string, maxBytes: number): Promise<PullFile[]> {
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
  const add = (abs: string, size: number) => {
    const rel = toPosix(relative(root, abs));
    if (size > MAX_PULL_FILE_BYTES) {
      throw new UncageError('invalid_request', {
        message: `"${rel}" is ${size} bytes; files larger than ${MAX_PULL_FILE_BYTES} bytes cannot be pulled.`,
        details: { path: rel, size, maxFileBytes: MAX_PULL_FILE_BYTES },
      });
    }
    total += size;
    if (total > limit) {
      throw new UncageError('invalid_request', {
        message: `"${path}" is larger than the ${limit}-byte limit for one pull.`,
        details: { maxBytes: limit },
      });
    }
    if (files.length >= MAX_PULL_FILES) {
      throw new UncageError('invalid_request', { message: `"${path}" has more than ${MAX_PULL_FILES} files.`, details: { maxFiles: MAX_PULL_FILES } });
    }
    if (!RelativePathSchema.safeParse(rel).success) return; // a name the protocol cannot carry: skip
    files.push({ abs, rel, size });
  };

  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) await walk(abs);
      else if (ent.isFile()) add(abs, (await lstat(abs)).size);
      // symlinks, sockets, devices: skipped
    }
  };

  const st = await lstat(target);
  if (st.isDirectory()) await walk(target);
  else if (st.isFile()) add(target, st.size);
  else throw new UncageError('invalid_request', { message: `"${path}" is not a file or directory.` });
  return files;
}

/**
 * Streams the planned files as `file_chunk` frames (256 KiB raw per chunk, `seq` per file from 0,
 * `last` on each file's final chunk; an empty file is one empty chunk), then `file_done`. Files
 * are opened with `O_NOFOLLOW` and re-checked so a file swapped for a symlink mid-pull is refused.
 */
export async function sendPull(
  id: string,
  files: PullFile[],
  send: (f: AgentFrame) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const { constants } = await import('node:fs');
  const done: Array<{ path: string; size: number }> = [];
  for (const f of files) {
    if (signal?.aborted) throw new UncageError('machine_offline');
    const fh = await open(f.abs, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = await fh.stat();
      if (!st.isFile() || st.size > MAX_PULL_FILE_BYTES) {
        throw new UncageError('invalid_request', { message: `"${f.rel}" changed while it was being pulled.` });
      }
      const buf = Buffer.alloc(PULL_CHUNK_BYTES);
      let seq = 0;
      let sent = 0;
      for (;;) {
        const { bytesRead } = await fh.read(buf, 0, PULL_CHUNK_BYTES, sent);
        sent += bytesRead;
        const last = bytesRead < PULL_CHUNK_BYTES || sent >= st.size;
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
