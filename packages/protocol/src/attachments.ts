export const ATTACHMENT_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxPerMessage: 10,
  imageExt: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
  fileExt: [
    'txt', 'md', 'json', 'csv', 'yaml', 'yml', 'xml', 'html', 'css', 'js', 'ts', 'tsx', 'jsx',
    'py', 'go', 'rs', 'java', 'rb', 'sh', 'sql', 'log', 'pdf',
  ],
} as const;

/** Returns the attachment kind, or null when the extension/mime combination is unsupported. */
export function classifyAttachment(name: string, mime: string): 'image' | 'file' | null {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  const isImageMime = mime.toLowerCase().startsWith('image/');
  if ((ATTACHMENT_LIMITS.imageExt as readonly string[]).includes(ext)) {
    return isImageMime ? 'image' : null;
  }
  if ((ATTACHMENT_LIMITS.fileExt as readonly string[]).includes(ext)) {
    return isImageMime ? null : 'file';
  }
  return null;
}
