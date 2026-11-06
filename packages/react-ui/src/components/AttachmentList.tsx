import { useAttachments, useStoreSelector, type DraftAttachment } from '@uncage/react';
import { FileText, Image as ImageIcon, X } from 'lucide-react';
import type { JSX } from 'react';
import { useUi } from '../context.js';
import { errorText, formatBytes } from '../i18n.js';

function Chip({ item, uploading, disabled }: { item: DraftAttachment; uploading: boolean; disabled: boolean }): JSX.Element {
  const { t } = useUi();
  const { remove } = useAttachments();
  const status = item.status === 'error' ? t.uploadFailed : uploading ? t.uploading : undefined;
  return (
    <li
      className="uc-attachment"
      data-status={item.status}
      aria-label={[item.name, formatBytes(item.size), status].filter(Boolean).join(', ')}
      {...(item.error ? { title: errorText(t, item.error).message } : {})}
    >
      <span className="uc-attachment-thumb" aria-hidden>
        {item.previewUrl ? <img src={item.previewUrl} alt="" /> : item.kind === 'image' ? <ImageIcon /> : <FileText />}
        {uploading && (
          <span className="uc-attachment-busy">
            <span className="uc-spinner" />
          </span>
        )}
      </span>
      <span className="uc-attachment-text">
        <span className="uc-attachment-name">{item.name}</span>
        <span className="uc-attachment-meta">{item.status === 'error' ? t.uploadFailed : formatBytes(item.size)}</span>
      </span>
      <button
        type="button"
        className="uc-attachment-remove"
        aria-label={t.removeAttachment(item.name)}
        disabled={disabled}
        onClick={() => remove(item.localId)}
      >
        <X aria-hidden />
      </button>
    </li>
  );
}

/**
 * The composer's pending attachments: image thumbnails (40px) or a file icon, name and size, a
 * spinner while uploading, a red border when the upload failed, × to remove.
 */
export function AttachmentList({ disabled = false }: { disabled?: boolean }): JSX.Element | null {
  const { t } = useUi();
  const { items } = useAttachments();
  // Files queued in a draft are not uploading yet (they upload once the session exists).
  const bound = useStoreSelector((s) => s.attachments.sessionId !== undefined);
  if (items.length === 0) return null;
  return (
    <ul className="uc-attachments" aria-label={t.attachmentsLabel}>
      {items.map((item) => (
        <Chip key={item.localId} item={item} uploading={bound && item.status === 'uploading'} disabled={disabled} />
      ))}
    </ul>
  );
}
