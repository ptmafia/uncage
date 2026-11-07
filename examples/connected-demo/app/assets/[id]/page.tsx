import { notFound } from 'next/navigation';
import { getAsset } from '../../../lib/assets.ts';
import { requireUser } from '../../../lib/session.ts';

export const dynamic = 'force-dynamic';

export default async function AssetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser(`/assets/${id}`);
  const asset = await getAsset(id);
  if (!asset || asset.owner !== user.id) notFound();
  return (
    <div className="demo-page">
      <h1>
        {asset.title}
        <span className="demo-badge" data-status={asset.status}>
          {asset.status === 'published' ? '已发布' : '草稿'}
        </span>
      </h1>
      <p className="demo-note">
        <a href={`/?session=${encodeURIComponent(asset.sessionId)}`}>查看生成过程</a>
        {asset.files ? ` · ${asset.files.length} 个文件：${asset.files.map((f) => f.path).join('、')}` : null}
      </p>
      {asset.status === 'published' ? (
        // The page was written by an AI agent: render it in an opaque-origin sandbox (no cookies,
        // no access to this site), from a separate path whose CSP also blocks all network access.
        <iframe
          className="demo-preview"
          title={`预览：${asset.title}`}
          sandbox="allow-scripts"
          src={`/asset-files/${asset.id}/index.html`}
        />
      ) : (
        <p>还没有发布。</p>
      )}
    </div>
  );
}
