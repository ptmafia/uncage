/**
 * The Connected Mode agent exactly as `uncage agent` runs it (real @uncage/agent: WebSocket to
 * the hub, local PGlite, file channel), but with the testkit fake adapter instead of Claude Code.
 * Reads the site `uncage setup` saved under UNCAGE_HOME.
 *
 * For the landing-page prompt the fake runtime plays what Claude Code does with the demo's
 * `landing-page` skill: writes landing/index.html in the session workspace, calls create_asset,
 * asks for confirmation (the approval card a confirmation tool raises in Claude Code), then calls
 * publish_asset with the assetId it got back.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAgent, createAgentLogger, loadAgentConfig } from '@uncage/agent';
import type { AdapterRunInput } from '@uncage/protocol';
import { createFakeAdapter, type FakeStep } from '@uncage/testkit';

const home = process.env.UNCAGE_HOME;
if (!home) throw new Error('UNCAGE_HOME is required');

export const LANDING_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Uncage</title>
<style>body{font-family:system-ui;margin:0;padding:48px;background:linear-gradient(135deg,#eef2ff,#fff)}h1{font-size:44px}</style>
</head><body><h1>Uncage：把 Claude Code 带进你的网站</h1><p>网站下指令，代码在用户自己的电脑上跑。</p>
<script>document.body.dataset.ready = '1';</script></body></html>`;

function script(input: AdapterRunInput): FakeStep[] {
  if (!input.prompt.includes('落地页')) return [{ text: `fake: ${input.prompt}` }];
  mkdirSync(join(input.cwd, 'landing'), { recursive: true });
  writeFileSync(join(input.cwd, 'landing', 'index.html'), LANDING_HTML);
  return [
    { text: '好的，我先在网站上创建素材。' },
    { callTool: { name: 'create_asset', args: { title: 'Uncage 落地页', kind: 'landing-page' } } },
    {
      // Shaped like runtime-claude's siteApprovalRequest for a requiresConfirmation tool.
      approval: {
        category: 'mcp',
        title: 'Publish a folder of the workspace as the asset\'s files',
        target: { command: 'publish_asset({"dir":"landing"})', cwd: input.cwd },
      },
      onDeny: 'fail',
    },
    {
      callTool: {
        name: 'publish_asset',
        args: (previous: string[]) => ({ assetId: (JSON.parse(previous[0] ?? '{}') as { assetId?: string }).assetId, dir: 'landing' }),
      },
    },
    { text: '落地页已发布，可以在「素材」页面查看。' },
  ];
}

const config = await loadAgentConfig(home);
const agent = await createAgent({
  config,
  home,
  logger: createAgentLogger(process.env.UNCAGE_LOG_LEVEL ?? 'warn'),
  adapters: () => [createFakeAdapter({ id: 'fake', displayName: 'Fake Runtime', script })],
});
console.log(`fake agent ready (${config.sites.length} site(s))`);

const stop = (): void => {
  setTimeout(() => process.exit(1), 10_000).unref();
  agent.close().then(() => process.exit(0), () => process.exit(1));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
