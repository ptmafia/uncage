/**
 * File channel (machine → hub): reassembles the `file_chunk` / `file_done` stream of one
 * `file_pull` and hands site tools the files through `ctx.files`.
 */
import { UncageError } from '@uncage/core';
import { MAX_ATTACHMENT_TRANSFER_BYTES, type AgentFrame } from '@uncage/protocol';

/** Default (and largest) total of `ctx.files.pull` — the agent's own cap. */
export const DEFAULT_PULL_MAX_BYTES = 50 * 1024 * 1024;
/** Default cap of `ctx.files.read` (one file is at most 10 MiB on the wire). */
export const DEFAULT_READ_MAX_BYTES = 10 * 1024 * 1024;
/** Largest single file the file channel carries. */
const MAX_FILE_BYTES = MAX_ATTACHMENT_TRANSFER_BYTES;

/** One file from the session workspace; `path` is relative to the workspace, forward slashes. */
export interface PulledFile {
  path: string;
  data: Uint8Array;
}

/** A file a directory pull left out (never read), e.g. one with more than one hard link. */
export interface SkippedFile {
  path: string;
  reason: string;
}

export interface PullOutcome {
  files: PulledFile[];
  skipped: SkippedFile[];
}

/**
 * The result of `ctx.files.pull`: iterate it for the files. The pull is all-or-nothing — files
 * are yielded only after the machine finished sending every one of them, so a pull that fails
 * part-way (an error from the machine, a broken stream, a disconnect, the call ending) yields
 * nothing and throws instead.
 */
export interface FilePull extends AsyncIterable<PulledFile> {
  /** Files the machine skipped; filled in once iteration has finished. */
  readonly skipped: readonly SkippedFile[];
}

/** Starts a pull lazily (on first iteration) and exposes it as a `FilePull`. */
export function filePull(start: () => Promise<PullOutcome>): FilePull {
  const skipped: SkippedFile[] = [];
  let outcome: Promise<PullOutcome> | undefined;
  return {
    skipped,
    async *[Symbol.asyncIterator]() {
      const r = await (outcome ??= start());
      skipped.splice(0, skipped.length, ...r.skipped);
      for (const f of r.files) yield f;
    },
  };
}

const broken = (path: string, why: string) =>
  new UncageError('invalid_request', { message: `The machine sent a broken file stream for "${path}": ${why}.` });

/**
 * Validates and reassembles the chunk stream of one pull: files arrive one after another, each as
 * chunks with `seq` 0, 1, … and `last` on its final chunk; `file_done` must list exactly the files
 * received with their sizes. Caps: `maxBytes` in total, 10 MiB per file.
 */
export class PullAssembler {
  private readonly files: PulledFile[] = [];
  private readonly seen = new Set<string>();
  private cur: { path: string; seq: number; parts: Buffer[]; size: number } | undefined;
  private total = 0;

  constructor(
    private readonly path: string,
    private readonly maxBytes: number,
  ) {}

  /** Throws an `UncageError` when the chunk breaks the stream rules or a cap. */
  chunk(f: Extract<AgentFrame, { t: 'file_chunk' }>): void {
    if (this.cur && this.cur.path !== f.path) throw broken(this.path, `"${this.cur.path}" ended without its last chunk`);
    if (!this.cur) {
      if (this.seen.has(f.path)) throw broken(this.path, `"${f.path}" sent twice`);
      this.cur = { path: f.path, seq: -1, parts: [], size: 0 };
      this.seen.add(f.path);
    }
    const cur = this.cur;
    if (f.seq !== cur.seq + 1) throw broken(this.path, `chunk out of order for "${f.path}" (got ${f.seq}, expected ${cur.seq + 1})`);
    cur.seq = f.seq;
    const bytes = Buffer.from(f.data, 'base64');
    cur.size += bytes.byteLength;
    this.total += bytes.byteLength;
    if (cur.size > MAX_FILE_BYTES) throw new UncageError('invalid_request', { message: `"${f.path}" is larger than ${MAX_FILE_BYTES} bytes.` });
    if (this.total > this.maxBytes) {
      throw new UncageError('invalid_request', {
        message: `Pulling "${this.path}" exceeded maxBytes (${this.maxBytes} bytes).`,
        details: { maxBytes: this.maxBytes },
      });
    }
    cur.parts.push(bytes);
    if (f.last) {
      const data = Buffer.concat(cur.parts, cur.size);
      this.files.push({ path: cur.path, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) });
      this.cur = undefined;
    }
  }

  /** Checks `file_done` against what arrived; resolves the files. */
  done(f: Extract<AgentFrame, { t: 'file_done' }>): PullOutcome {
    if (this.cur) throw broken(this.path, `"${this.cur.path}" ended without its last chunk`);
    const listed = f.files;
    const ok = listed.length === this.files.length && listed.every((x, i) => x.path === this.files[i]!.path && x.size === this.files[i]!.data.byteLength);
    if (!ok) throw broken(this.path, 'file_done does not match the files received');
    return { files: this.files, skipped: f.skipped ?? [] };
  }
}
