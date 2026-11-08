import { assetCsp } from '../../../../lib/asset-csp.ts';
import { canReadAsset, getAsset, readAssetFile } from '../../../../lib/assets.ts';
import { userFromRequest } from '../../../../lib/auth.ts';
import { isPublicDemo, publicUrl } from '../../../../lib/config.ts';

/** Published asset files, for /assets/[id]'s sandboxed iframe (see lib/asset-csp.ts). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; path: string[] }> }): Promise<Response> {
  const { id, path } = await params;
  const notFound = () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  const asset = await getAsset(id);
  // The same 404 for unknown, unpublished and not-yours, so existence does not leak.
  if (!asset || !canReadAsset(asset, userFromRequest(req)?.name ?? null, isPublicDemo())) return notFound();
  const file = await readAssetFile(id, path.join('/'));
  if (!file) return notFound();
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
