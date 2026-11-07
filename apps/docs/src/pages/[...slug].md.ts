import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';
import { slugOf, toMarkdown, type DocsEntry } from '../lib/markdown';

/** Every page as plain markdown: `/guides/define-tools.md`, `/index.md`, `/zh-cn/concepts.md`. */
export const getStaticPaths = (async () => {
  const entries = await getCollection('docs');
  return entries.map((entry) => ({ params: { slug: slugOf(entry) || 'index' }, props: { entry } }));
}) satisfies GetStaticPaths;

export const GET: APIRoute<{ entry: DocsEntry }> = ({ props }) =>
  new Response(toMarkdown(props.entry), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
