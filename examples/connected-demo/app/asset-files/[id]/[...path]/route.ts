import { assetCsp } from '../../../../lib/asset-csp.ts';
import { readAssetFile } from '../../../../lib/assets.ts';
import { publicUrl } from '../../../../lib/config.ts';

/** Published asset files, for /assets/[id]'s sandboxed iframe (see lib/asset-csp.ts). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; path: string[] }> }): Promise<Response> {
  const { id, path } = await params;
  const file = await readAssetFile(id, path.join('/'));
  if (!file) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  return new Response(new Uint8Array(file.data), {
    headers: {
      'content-type': file.contentType,
      // The origin users browse (PUBLIC_URL), so the path-scoped source matches behind proxies too.
      'content-security-policy': assetCsp(publicUrl(), id),
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    },
  });
}
