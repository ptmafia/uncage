/** Only same-site relative paths (no `//host`, no scheme): avoids an open redirect after sign-in. */
export function safeNext(raw: unknown): string {
  return typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\') ? raw : '/';
}
