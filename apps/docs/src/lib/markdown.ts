/**
 * Plain-markdown versions of the pages, for coding agents: `/<page>.md`, `/llms.txt`,
 * `/llms-full.txt`. The source of every page is already markdown (no MDX), so the raw body is
 * served as is, with the title and description on top and site links made absolute (pointing at
 * the `.md` version of the target page).
 */
import type { CollectionEntry } from 'astro:content';
import { SITE_URL } from '../nav.mjs';

export type DocsEntry = CollectionEntry<'docs'>;

/** `index` → '', `zh-cn/index` → 'zh-cn', anything else unchanged. */
export function slugOf(entry: DocsEntry): string {
  return entry.id.replace(/(^|\/)index$/, '');
}

/** Path of the markdown version, relative to the site root: '' → 'index.md'. */
export function mdPathOf(slug: string): string {
  return slug === '' ? 'index.md' : `${slug}.md`;
}

export const htmlUrl = (slug: string): string => `${SITE_URL}/${slug === '' ? '' : `${slug}/`}`;
export const mdUrl = (slug: string): string => `${SITE_URL}/${mdPathOf(slug)}`;

/** `](/docs/guides/x/#a)` → `](https://…/docs/guides/x.md#a)`. Other links are left alone. */
export function toMarkdownLinks(body: string): string {
  return body.replace(/\]\(\/docs\/([^)\s#]*?)\/?(#[^)\s]*)?\)/g, (_m, path: string, hash: string | undefined) => {
    const isFile = /\.[a-z]+$/i.test(path);
    const target = isFile ? `${SITE_URL}/${path}` : mdUrl(path);
    return `](${target}${hash ?? ''})`;
  });
}

/** MDX pages (imports, `<Image>`, components) become plain markdown: screenshots turn into their alt text. */
export function stripMdx(body: string): string {
  return body
    .replace(/^import .*$\n?/gm, '')
    .replace(/<Image\b[^>]*?\balt="([^"]*)"[^>]*?\/>/g, '*(Screenshot: $1)*')
    .replace(/^<[A-Z]\w*\s*\/>\s*$\n?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '');
}

export function toMarkdown(entry: DocsEntry): string {
  const { title, description } = entry.data;
  const body = toMarkdownLinks(stripMdx((entry.body ?? '').trim()));
  const head = `# ${title}\n\n${description ? `> ${description}\n\n` : ''}`;
  const source = `<!-- ${htmlUrl(slugOf(entry))} -->\n\n`;
  return `${head}${source}${body}\n`;
}

export const isApiPage = (entry: DocsEntry): boolean => entry.id.startsWith('api/');
export const isZhPage = (entry: DocsEntry): boolean => entry.id.startsWith('zh-cn/');
