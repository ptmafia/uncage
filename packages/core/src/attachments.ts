import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { ATTACHMENT_LIMITS, classifyAttachment, type Attachment, type RuntimeCapabilities } from '@uncage/protocol';
import { UncageError } from './errors.js';
import type { Log } from './logger.js';
import type { WorkspaceConfig } from './sessions.js';
import type { Store } from './store/store.js';
import { resolveWorkspace } from './workspace.js';

const MAX_NAME = 120;
const MAX_EXT = 16;

/**
 * Reduces an untrusted file name to a safe single path segment: basename only (either
 * separator), every char outside `[\w.\- ]` → `_`, runs of `_` collapsed, at most 120 chars
 * (the extension is kept), and never `''`, `.` or `..`.
 */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  let s = base
    .replace(/[^\w.\- ]/g, '_')
    .replace(/_+/g, '_')
    .trim();
  if (s.length > MAX_NAME) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= MAX_EXT ? s.slice(dot) : '';
    s = s.slice(0, MAX_NAME - ext.length) + ext;
  }
  if (s === '' || /^\.+$/.test(s)) return 'file';
  return s;
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

const isWithin = (path: string, dir: string) => path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

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
    const name = sanitizeFileName(input.name);
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
    const dir = join(workspace, '.uncage', 'attachments', sessionId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const realDir = await realpath(dir);
    if (!isWithin(realDir, workspace)) {
      throw new UncageError('invalid_request', { message: 'The attachment directory escapes the workspace.' });
    }

    const id = `att_${randomUUID().replaceAll('-', '')}`;
    const tmp = join(realDir, `.tmp-${id}`);
    const final = join(realDir, `${id}-${name}`);
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
      const real = await realpath(final);
      if (!isWithin(real, realDir)) {
        await rm(final, { force: true });
        throw new UncageError('invalid_request', { message: 'The attachment path escapes its directory.' });
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

  /** Deletes attachments never used by a run and created before `olderThan` (rows and files). */
  async pruneOrphans(olderThan: Date): Promise<number> {
    const rows = await this.store.deleteOrphanAttachments(olderThan);
    await Promise.all(rows.map((r) => rm(r.absPath, { force: true })));
    return rows.length;
  }
}
