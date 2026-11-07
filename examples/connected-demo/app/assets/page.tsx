import { listAssets } from '../../lib/assets.ts';
import { requireUser } from '../../lib/session.ts';

export const dynamic = 'force-dynamic';

export default async function AssetsPage() {
  const user = await requireUser('/assets');
  const assets = await listAssets(user.id);
  return (
    <div className="demo-page">
      <h1>素材</h1>
      <p className="demo-note">
        你电脑上的 Claude Code 通过网站工具 create_asset / publish_asset 创建并发布的页面。文件保存在网站上（演示数据目录），不在你的电脑上。
      </p>
      {assets.length === 0 ? (
        <p data-testid="assets-empty">还没有素材。回到对话，让 Claude Code 做一个落地页并发布。</p>
      ) : (
        <ul className="demo-grid" data-testid="assets">
          {assets.map((a) => (
            <li key={a.id} className="demo-card" data-asset-id={a.id}>
              <a href={`/assets/${a.id}`}>{a.title}</a>
              <span className="demo-badge" data-status={a.status}>
                {a.status === 'published' ? '已发布' : '草稿'}
              </span>
              <p className="demo-note">{new Date(a.createdAt).toLocaleString('zh-CN')}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
