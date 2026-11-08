import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { isApiPage, slugOf, toMarkdown } from '../lib/markdown';
import { SITE_URL, sections } from '../nav.mjs';

/**
 * All English guide pages in reading order, as one plain-markdown file. The generated API
 * reference is not included (it is large and linked from /llms.txt); neither are translations.
 */
export const GET: APIRoute = async () => {
  const entries = await getCollection('docs');
  const bySlug = new Map(entries.map((e) => [slugOf(e), e]));
  const order = ['', ...sections.flatMap((s) => s.items)];
  const parts = order.map((slug) => {
    const e = bySlug.get(slug);
    if (!e || isApiPage(e)) throw new Error(`llms-full.txt: no page "${slug}"`);
    return toMarkdown(e);
  });
  const head = `# Uncage documentation (all pages)\n\n> Source: ${SITE_URL}/ · Index: ${SITE_URL}/llms.txt · Generated API reference: ${SITE_URL}/api/hub/ and siblings.\n\n`;
  return new Response(head + parts.join('\n\n---\n\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
