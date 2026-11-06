import type { Attachment } from '@uncage/protocol';
import { useAttachmentUrl, useStoreSelector, type MessageView } from '@uncage/react';
import { FileText } from 'lucide-react';
import type { JSX } from 'react';
import { useUi } from '../context.js';
import { formatBytes } from '../i18n.js';

/** An image sent with the prompt: a thumbnail that opens the full image in a new tab. */
function ImageThumb({ attachment }: { attachment: Attachment }): JSX.Element {
  const { t } = useUi();
  const url = useAttachmentUrl(attachment.id);
  return (
    <a className="uc-user-thumb" href={url} target="_blank" rel="noopener noreferrer" title={t.openImage(attachment.name)}>
      <img src={url} alt={attachment.name} loading="lazy" />
    </a>
  );
}

/** The user's prompt: a right-aligned bubble, plain text (never Markdown), with its attachments. */
export function UserMessage({ message }: { message: MessageView }): JSX.Element {
  const attachments = useStoreSelector((s) => s.active?.runs[message.runId]?.attachments);
  const images = attachments?.filter((a) => a.kind === 'image') ?? [];
  const files = attachments?.filter((a) => a.kind === 'file') ?? [];
  return (
    <div className="uc-user">
      {attachments && attachments.length > 0 && (
        <div className="uc-user-attachments">
          {images.map((a) => (
            <ImageThumb key={a.id} attachment={a} />
          ))}
          {files.map((a) => (
            <span key={a.id} className="uc-file-chip">
              <FileText aria-hidden />
              <span className="uc-file-chip-name">{a.name}</span>
              <span className="uc-file-chip-size">{formatBytes(a.size)}</span>
            </span>
          ))}
        </div>
      )}
      <div className="uc-user-bubble">{message.text}</div>
    </div>
  );
}
