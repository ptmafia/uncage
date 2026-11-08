// @ts-check
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';
// One origin rule for the whole domain (env SITE_URL, else the default deployment), shared with the help site.
import { SITE_ORIGIN } from '../docs/src/nav.mjs';

export default defineConfig({
  site: SITE_ORIGIN,
  trailingSlash: 'ignore',
  build: { format: 'directory' },
  i18n: {
    locales: ['en', 'zh', 'ja'],
    defaultLocale: 'en',
    routing: { prefixDefaultLocale: false },
  },
  integrations: [
    sitemap({
      i18n: { defaultLocale: 'en', locales: { en: 'en', zh: 'zh-CN', ja: 'ja' } },
      filter: (page) => !page.endsWith('/404/'),
    }),
  ],
});
