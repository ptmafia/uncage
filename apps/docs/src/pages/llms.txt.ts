import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { isApiPage, mdUrl, slugOf, type DocsEntry } from '../lib/markdown';
import { SITE_URL, sections } from '../nav.mjs';

/** https://llmstxt.org: a title, a summary, then sections of links with one-line descriptions. */
export const GET: APIRoute = async () => {
  const entries = await getCollection('docs');
  const bySlug = new Map(entries.map((e) => [slugOf(e), e]));
  const line = (e: DocsEntry) => `- [${e.data.title}](${mdUrl(slugOf(e))}): ${e.data.description ?? ''}`.trimEnd();

  const out: string[] = [
    '# Uncage',
    '',
    '> Uncage lets a website drive Claude Code (and Codex) on its users’ own computers. The website mounts `@uncage/hub` in its Node backend; each user connects their computer with two commands (`curl … | bash`, `uncage setup <url>`); a background agent dials out to the hub; the website renders `<AgentChat>`. Runs execute locally under the user’s own Claude Code login, with approval cards, streaming, Stop and reload-safe history. Claude Code calls the website’s own tools (`defineTool`) as the signed-in user and reads the website’s skills. Local Mode (`uncage serve` + a same-origin proxy) is the second path, for apps that run on the same machine as the agent.',
    '',
    'Every page is plain markdown at the URLs below. All pages in one file: ' + `${SITE_URL}/llms-full.txt` + '. A ready-made skill for coding agents ("Integrate Uncage into a website"): ' + `${SITE_URL}/skills/uncage/SKILL.md` + '.',
    '',
    'Packages: `@uncage/hub` (website backend, Connected Mode), `@uncage/react-ui` (`<AgentChat>`, `<ConnectMachine>`, `<ApproveDevice>`), `@uncage/react` (headless hooks), `@uncage/client` (browser transport), `@uncage/cli` (`uncage` command for end users and Local Mode), `@uncage/server` (Local Mode daemon and proxy), `@uncage/protocol` (wire types and error codes). macOS only for the agent side; Node.js 22 or newer.',
    '',
  ];
  const home = bySlug.get('');
  if (home) out.push('## Overview', '', line(home), '');
  for (const sec of sections) {
    out.push(`## ${sec.label}`, '');
    for (const slug of sec.items) {
      const e = bySlug.get(slug);
      if (!e) throw new Error(`llms.txt: no page "${slug}"`);
      out.push(line(e));
    }
    out.push('');
  }
  const api = entries.filter((e) => isApiPage(e) && /^api\/[^/]+$/.test(e.id)).sort((a, b) => a.id.localeCompare(b.id));
  out.push('## Optional', '');
  out.push(`- [简体中文 (zh-CN) overview](${mdUrl('zh-cn')}): Chinese versions of the overview, quickstarts and concepts live under /zh-cn/.`);
  out.push(`- [日本語 (ja) overview](${mdUrl('ja')}): Japanese versions of the overview, quickstarts and concepts live under /ja/.`);
  for (const e of api) out.push(`- [API: ${e.data.title}](${mdUrl(slugOf(e))}): Generated TypeScript API reference.`);
  out.push('');
  return new Response(out.join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
