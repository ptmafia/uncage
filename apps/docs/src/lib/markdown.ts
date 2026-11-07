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

/** `](/uncage/guides/x/#a)` → `](https://…/uncage/guides/x.md#a)`. Other links are left alone. */
export function absolutizeLinks(body: string): string {
  return body.replace(/\]\(\/uncage\/([^)\s#]*?)\/?(#[^)\s]*)?\)/g, (_m, path: string, hash: string | undefined) => {
    const isFile = /\.[a-z]+$/i.test(path);
    const target = isFile ? `${SITE_URL}/${path}` : mdUrl(path);
    return `](${target}${hash ?? ''})`;
  });
}

export function toMarkdown(entry: DocsEntry): string {
  const { title, description } = entry.data;
  const body = absolutizeLinks((entry.body ?? '').trim());
  const head = `# ${title}\n\n${description ? `> ${description}\n\n` : ''}`;
  const source = `<!-- ${htmlUrl(slugOf(entry))} -->\n\n`;
  return `${head}${source}${body}\n`;
}

export const isApiPage = (entry: DocsEntry): boolean => entry.id.startsWith('api/');
export const isZhPage = (entry: DocsEntry): boolean => entry.id.startsWith('zh-cn/');
