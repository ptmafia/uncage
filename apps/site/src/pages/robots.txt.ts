import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ site }) => {
  const origin = (site ?? new URL('https://uncage.vercel.app')).origin;
  const body = ['User-agent: *', 'Allow: /', '', `Sitemap: ${origin}/sitemap-index.xml`, `Sitemap: ${origin}/docs/sitemap-index.xml`, ''].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
};
