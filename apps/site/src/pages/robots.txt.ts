import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ site }) => {
  if (!site) throw new Error('astro.config.mjs must set `site` (SITE_ORIGIN): robots.txt lists absolute sitemap URLs.');
  const origin = site.origin;
  const body = ['User-agent: *', 'Allow: /', '', `Sitemap: ${origin}/sitemap-index.xml`, `Sitemap: ${origin}/docs/sitemap-index.xml`, ''].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
};
