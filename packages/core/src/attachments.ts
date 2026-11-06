import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ATTACHMENT_LIMITS, classifyAttachment, type Attachment, type RuntimeCapabilities } from '@uncage/protocol';
import { UncageError } from './errors.js';
import type { Log } from './logger.js';
import type { WorkspaceConfig } from './sessions.js';
import type { Store } from './store/store.js';
import { resolveWorkspace } from './workspace.js';

const MAX_DISK_NAME_BYTES = 120;
const MAX_EXT_BYTES = 16;
const MAX_DISPLAY_NAME = 200;

const basenameOf = (name: string) => name.split(/[/\\]/).pop() ?? '';
const utf8Bytes = (s: string) => Buffer.byteLength(s, 'utf8');

/** Longest prefix of `s` (whole code points) that fits in `maxBytes` UTF-8 bytes. */
const truncateBytes = (s: string, maxBytes: number): string => {
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const n = utf8Bytes(ch);
    if (bytes + n > maxBytes) break;
    out += ch;
    bytes += n;
  }
  return out;
};

/** Returns `s` when it `fits`; otherwise `cut`s the stem to the budget left after a short extension. */
const capKeepingExt = (s: string, fits: (x: string) => boolean, cut: (x: string, budget: string) => string): string => {
  if (fits(s)) return s;
  const dot = s.lastIndexOf('.');
  const ext = dot > 0 && utf8Bytes(s.slice(dot)) <= MAX_EXT_BYTES ? s.slice(dot) : '';
  return cut(s.slice(0, s.length - ext.length), ext) + ext;
};

/**
 * On-disk name for an untrusted file name: NFC basename only (either separator), every char
 * outside letters/digits/`_.- ` → `_`, runs of `_` collapsed, at most 120 UTF-8 bytes (the
 * extension is kept), and never `''`, `.` or `..`.
 */
export function sanitizeFileName(name: string): string {
  const s = basenameOf(name.normalize('NFC'))
    .replace(/[^\p{L}\p{N}_.\- ]/gu, '_')
    .replace(/_+/g, '_')
    .trim();
  const capped = capKeepingExt(
    s,
    (x) => utf8Bytes(x) <= MAX_DISK_NAME_BYTES,
    (stem, ext) => truncateBytes(stem, MAX_DISK_NAME_BYTES - utf8Bytes(ext)),
  );
  if (capped === '' || /^\.+$/.test(capped)) return 'file';
  return capped;
}

/**
 * Display name for an untrusted file name: NFC basename with control characters (incl. NUL)
 * removed, at most 200 characters (the extension is kept); `file` when nothing is left.
 */
export function displayFileName(name: string): string {
  const s = basenameOf(name.normalize('NFC').replace(/\p{Cc}/gu, '')).trim();
  const capped = capKeepingExt(
    s,
    (x) => [...x].length <= MAX_DISPLAY_NAME,
    (stem, ext) => [...stem].slice(0, MAX_DISPLAY_NAME - [...ext].length).join(''),
  );
  return capped === '' || /^\.+$/.test(capped) ? 'file' : capped;
}

/** Strips storage-only fields (`absPath`, `referencedByRun`) from an attachment record. */
export const publicAttachment = (a: Attachment): Attachment => ({
  id: a.id,
  sessionId: a.sessionId,
  name: a.name,
  mime: a.mime,
  size: a.size,
  kind: a.kind,
  sha256: a.sha256,
  createdAt: a.createdAt,
});

export type AttachmentBody = AsyncIterable<Uint8Array> | Uint8Array;

const escapes = () =>
  new UncageError('invalid_request', {
    message: 'The attachment directory is not a plain directory inside the workspace.',
    hint: 'Remove any symlink at .uncage or .uncage/attachments in the workspace.',
  });

/**
 * Creates `<workspace>/.uncage/attachments/<sessionId>` one level at a time (0700), refusing any
 * existing symlink or non-directory, and requires the result to resolve to exactly that path.
 */
async function ensureAttachmentDir(workspace: string, sessionId: string): Promise<string> {
  let dir = workspace;
  for (const segment of ['.uncage', 'attachments', sessionId]) {
    dir = join(dir, segment);
    for (let attempt = 0; ; attempt++) {
      try {
        const st = await lstat(dir);
        if (st.isSymbolicLink() || !st.isDirectory()) throw escapes();
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || attempt > 0) throw e;
        try {
          await mkdir(dir, { mode: 0o700 });
        } catch (me) {
          if ((me as NodeJS.ErrnoException).code !== 'EEXIST') throw me;
        }
      }
    }
  }
  if ((await realpath(dir)) !== dir) throw escapes();
  return dir;
}

const TMP_PREFIX = '.tmp-';

/** Attachment files live at `<workspace>/.uncage/attachments/<sessionId>/<attachmentId>-<safeName>`. */
export class AttachmentService {
  constructor(
    private readonly store: Store,
    private readonly workspace: WorkspaceConfig,
    /** The session runtime's current capabilities. */
    private readonly capabilitiesOf: (sessionId: string) => Promise<RuntimeCapabilities>,
    private readonly logger: Log,
  ) {}

  async add(sessionId: string, input: { name: string; mime: string; body: AttachmentBody }): Promise<Attachment> {
    const session = await this.store.getSession(sessionId);
    if (!session) throw new UncageError('not_found', { message: `Session ${sessionId} not found.` });
    if (session.readOnly) throw new UncageError('session_read_only', { hint: 'Start a new session' });
    const name = displayFileName(input.name);
    const kind = classifyAttachment(name, input.mime);
    if (kind === null) throw new UncageError('attachment_type_unsupported', { details: { name, mime: input.mime } });
    const caps = (await this.capabilitiesOf(sessionId)).attachments;
    if (kind === 'image' ? !caps.images : !caps.files) {
      throw new UncageError('unsupported_capability', {
        message: `This runtime does not accept ${kind === 'image' ? 'image' : 'file'} attachments.`,
        details: { kind },
      });
    }
    const maxBytes = caps.maxBytes > 0 ? Math.min(caps.maxBytes, ATTACHMENT_LIMITS.maxBytes) : ATTACHMENT_LIMITS.maxBytes;

    const workspace = await resolveWorkspace(session.workspace, this.workspace).catch((e: unknown) => {
      throw new UncageError('invalid_workspace', {
        message: "This session's workspace is outside the allowed roots.",
        details: { workspace: session.workspace },
        cause: e,
      });
    });
    const dir = await ensureAttachmentDir(workspace, sessionId);

    const id = `att_${randomUUID().replaceAll('-', '')}`;
    const tmp = join(dir, `${TMP_PREFIX}${id}`);
    const final = join(dir, `${id}-${sanitizeFileName(input.name)}`);
    const hash = createHash('sha256');
    let size = 0;
    const fh = await open(tmp, 'wx', 0o600);
    try {
      try {
        const chunks: AsyncIterable<Uint8Array> | Uint8Array[] =
          input.body instanceof Uint8Array ? [input.body] : input.body;
        for await (const chunk of chunks) {
          size += chunk.byteLength;
          if (size > maxBytes) {
            throw new UncageError('attachment_too_large', { details: { maxBytes } });
          }
          hash.update(chunk);
          await fh.write(chunk);
        }
      } finally {
        await fh.close();
      }
      await rename(tmp, final);
      if ((await realpath(final)) !== final) {
        await rm(final, { force: true });
        throw escapes();
      }
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }

    const attachment: Attachment = {
      id,
      sessionId,
      name,
      mime: input.mime,
      size,
      kind,
      sha256: hash.digest('hex'),
      createdAt: new Date().toISOString(),
    };
    try {
      await this.store.createAttachment({ ...attachment, absPath: final });
    } catch (e) {
      await rm(final, { force: true });
      throw e;
    }
    this.logger.info({ attachmentId: id, sessionId, kind, size }, 'attachment stored');
    return attachment;
  }

  async get(id: string): Promise<{ attachment: Attachment; absPath: string }> {
    const row = await this.store.getAttachment(id);
    if (!row) throw new UncageError('not_found', { message: `Attachment ${id} not found.` });
    return { attachment: publicAttachment(row), absPath: row.absPath };
  }

  /**
   * Deletes attachments never used by a run and created before `olderThan` (rows and files) and
   * sweeps abandoned `.tmp-*` upload files older than it. Returns the number of attachments deleted.
   */
  async pruneOrphans(olderThan: Date): Promise<number> {
    const rows = await this.store.deleteOrphanAttachments(olderThan);
    const results = await Promise.allSettled(rows.map((r) => rm(r.absPath, { force: true })));
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) this.logger.warn({ failed }, 'some pruned attachment files could not be deleted');
    const swept = await this.sweepTempFiles(olderThan);
    if (swept > 0) this.logger.info({ swept }, 'removed abandoned attachment uploads');
    return rows.length;
  }

  private async sweepTempFiles(olderThan: Date): Promise<number> {
    let swept = 0;
    for (const s of await this.store.listSessions()) {
      const dir = join(s.workspace, '.uncage', 'attachments', s.id);
      // Only plain, non-symlinked directories are swept.
      const real = await realpath(dir).catch(() => null);
      if (real !== dir) continue;
      const names = await readdir(dir).catch(() => [] as string[]);
      for (const n of names) {
        if (!n.startsWith(TMP_PREFIX)) continue;
        const path = join(dir, n);
        const st = await lstat(path).catch(() => null);
        if (!st?.isFile() || st.mtime >= olderThan) continue;
        await rm(path, { force: true }).then(
          () => swept++,
          () => undefined,
        );
      }
    }
    return swept;
  }
}
