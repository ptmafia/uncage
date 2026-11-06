export const ATTACHMENT_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxPerMessage: 10,
  imageExt: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
  fileExt: [
    'txt', 'md', 'json', 'csv', 'yaml', 'yml', 'xml', 'html', 'css', 'js', 'ts', 'tsx', 'jsx',
    'py', 'go', 'rs', 'java', 'rb', 'sh', 'sql', 'log', 'pdf',
  ],
} as const;

/** The only mime type accepted for each image extension. */
const IMAGE_MIME: Record<(typeof ATTACHMENT_LIMITS.imageExt)[number], string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/**
 * Returns the attachment kind, or null when the extension/mime combination is unsupported. Images
 * must carry their extension's exact mime (case-insensitive, parameters ignored), so e.g.
 * `image/svg+xml` on `.png` is rejected; files must not carry an `image/*` mime.
 */
export function classifyAttachment(name: string, mime: string): 'image' | 'file' | null {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  const type = (mime.split(';')[0] ?? '').trim().toLowerCase();
  if (Object.hasOwn(IMAGE_MIME, ext)) {
    return IMAGE_MIME[ext as keyof typeof IMAGE_MIME] === type ? 'image' : null;
  }
  if ((ATTACHMENT_LIMITS.fileExt as readonly string[]).includes(ext)) {
    return type.startsWith('image/') ? null : 'file';
  }
  return null;
}

const MAX_DISPLAY_NAME = 200;
const MAX_EXT_BYTES = 16;

/** UTF-8 byte length without Buffer/TextEncoder (runs in browsers and Node). */
const utf8Length = (s: string): number => {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
};

/**
 * Display name for an untrusted file name: NFC basename (either separator) with control
 * characters (incl. NUL) removed, trimmed, at most 200 characters (an extension of at most 16
 * UTF-8 bytes is kept); `file` when nothing (or only dots) is left. The server stores and
 * classifies attachments under this name; clients use it to mirror the server's checks.
 */
export function displayFileName(name: string): string {
  const s = (name.normalize('NFC').replace(/\p{Cc}/gu, '').split(/[/\\]/).pop() ?? '').trim();
  let capped = s;
  if ([...s].length > MAX_DISPLAY_NAME) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && utf8Length(s.slice(dot)) <= MAX_EXT_BYTES ? s.slice(dot) : '';
    const stem = s.slice(0, s.length - ext.length);
    capped = [...stem].slice(0, MAX_DISPLAY_NAME - [...ext].length).join('') + ext;
  }
  return capped === '' || /^\.+$/.test(capped) ? 'file' : capped;
}
