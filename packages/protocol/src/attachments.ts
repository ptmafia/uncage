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
