import { ATTACHMENT_LIMITS, type RuntimeCapabilities } from '@uncage/protocol';
import { Plus } from 'lucide-react';
import { useRef, type JSX } from 'react';
import { useUi } from '../../context.js';

/** The `accept` list for the runtime's attachment kinds, e.g. `.png,.jpg,…,.pdf`. */
export function acceptList(caps: RuntimeCapabilities['attachments'] | undefined): string {
  if (!caps) return '';
  const exts = [...(caps.images ? ATTACHMENT_LIMITS.imageExt : []), ...(caps.files ? ATTACHMENT_LIMITS.fileExt : [])];
  return exts.map((e) => `.${e}`).join(',');
}

/** "+" button opening the file picker (multiple files, filtered to what the runtime accepts). */
export function AttachButton({
  accept,
  disabled = false,
  onFiles,
}: {
  accept: string;
  disabled?: boolean;
  onFiles(files: File[]): void;
}): JSX.Element {
  const { t } = useUi();
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className="uc-btn uc-btn-ghost uc-tool uc-tool-icon"
        aria-label={t.attach}
        title={t.attach}
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <Plus aria-hidden />
      </button>
      <input
        ref={input}
        type="file"
        className="uc-file-input"
        aria-label={t.attach}
        tabIndex={-1}
        multiple
        accept={accept}
        disabled={disabled}
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          // Reset so picking the same file again fires change.
          e.target.value = '';
          if (files.length > 0) onFiles(files);
        }}
      />
    </>
  );
}
