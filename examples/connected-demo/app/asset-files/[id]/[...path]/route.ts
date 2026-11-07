import { readAssetFile } from '../../../../lib/assets.ts';

/**
 * Published asset files, shown in /assets/[id]'s sandboxed iframe. Agent-written HTML is untrusted:
 * the CSP sandboxes it (opaque origin even when opened directly), allows only inline styles/scripts
 * and data: images, blocks every network request, and lets only this site frame it.
 */
const ASSET_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "frame-ancestors 'self'",
  'sandbox allow-scripts',
].join('; ');

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; path: string[] }> }): Promise<Response> {
  const { id, path } = await params;
  const file = await readAssetFile(id, path.join('/'));
  if (!file) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  return new Response(new Uint8Array(file.data), {
    headers: {
      'content-type': file.contentType,
      'content-security-policy': ASSET_CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    },
  });
}
