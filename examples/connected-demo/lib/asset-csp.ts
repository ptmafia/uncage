/**
 * CSP for published asset files, shown in /assets/[id]'s sandboxed iframe. Agent-written HTML is
 * untrusted: the page runs in an opaque origin (`sandbox allow-scripts`, also when opened
 * directly), so `'self'` would match nothing. It may use inline code and its OWN files (the
 * path-scoped source `<origin>/asset-files/<id>/`, e.g. `css/app.css`), nothing else: no other
 * asset, no other path of this site, no network requests (`connect-src 'none'`), and only this
 * site may frame it.
 */
export function assetCsp(origin: string, assetId: string): string {
  const own = `${new URL(origin).origin}/asset-files/${assetId}/`;
  return [
    "default-src 'none'",
    `style-src 'unsafe-inline' ${own}`,
    `script-src 'unsafe-inline' ${own}`,
    `img-src data: blob: ${own}`,
    `font-src data: ${own}`,
    `media-src data: blob: ${own}`,
    "connect-src 'none'",
    "frame-ancestors 'self'",
    'sandbox allow-scripts',
  ].join('; ');
}
