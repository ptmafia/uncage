/**
 * The `/device` page's `?code=` parameter. Only a single string is a code: a repeated parameter
 * (`?code=a&code=b`, which Next.js hands over as an array) is treated as an invalid link, never
 * `.trim()`-ed (it used to throw: 500). A link code must also be exactly what the CLI prints
 * (`ABCD-EFGH` / `ABCDEFGH`): padding such as `ABCD-EFGH----` could put the hidden last 4
 * characters on screen. (Same check as @uncage/react's isWellFormedDeviceCode, inlined: the page is
 * a Server Component and @uncage/react imports React client hooks, which Next.js refuses there.)
 */
export function deviceLinkParam(raw: unknown): { code: string; invalid: boolean } {
  if (raw === undefined || raw === '') return { code: '', invalid: false };
  const code = typeof raw === 'string' ? raw : '';
  if (!/^[A-Z0-9]{4}-?[A-Z0-9]{4}$/i.test(code.trim())) return { code: '', invalid: true };
  return { code, invalid: false };
}
