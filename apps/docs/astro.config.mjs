// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import mermaid from 'astro-mermaid';
import starlightLinksValidator from 'starlight-links-validator';
import { createStarlightTypeDocPlugin } from 'starlight-typedoc';
import { SITE_ORIGIN, sections } from './src/nav.mjs';

/**
 * Public packages documented in the generated API reference (typedoc → markdown at build time,
 * into src/content/docs/api/<name>/, which is gitignored). Each one is type-checked from its own
 * src entry point with its own tsconfig.
 */
const apiPackages = [
  { name: 'hub', label: '@uncage/hub', entry: 'hub/src/index.ts' },
  { name: 'react-ui', label: '@uncage/react-ui', entry: 'react-ui/src/index.ts' },
  { name: 'react', label: '@uncage/react', entry: 'react/src/index.ts' },
  { name: 'client', label: '@uncage/client', entry: 'client/src/index.ts' },
  { name: 'server', label: '@uncage/server', entry: ['server/src/index.ts', 'server/src/proxy.ts'] },
  { name: 'protocol', label: '@uncage/protocol', entry: 'protocol/src/index.ts' },
  { name: 'core', label: '@uncage/core', entry: 'core/src/index.ts' },
  { name: 'agent', label: '@uncage/agent', entry: 'agent/src/index.ts' },
];

const apiPlugins = apiPackages.map((p) => {
  const [plugin, sidebarGroup] = createStarlightTypeDocPlugin();
  const entries = (Array.isArray(p.entry) ? p.entry : [p.entry]).map((e) => `../../packages/${e}`);
  return {
    sidebarGroup,
    label: p.label,
    plugin: plugin({
      entryPoints: entries,
      tsconfig: `../../packages/${p.name}/tsconfig.json`,
      output: `api/${p.name}`,
      sidebar: { label: p.label, collapsed: true },
      typeDoc: {
        excludePrivate: true,
        excludeInternal: true,
        excludeExternals: true,
        skipErrorChecking: true,
        hideGenerator: true,
        readme: 'none',
        entryFileName: 'index',
        parametersFormat: 'table',
        interfacePropertiesFormat: 'table',
        enumMembersFormat: 'table',
        typeDeclarationFormat: 'table',
        useCodeBlocks: true,
        sort: ['kind', 'instance-first', 'alphabetical-ignoring-documents'],
      },
    }),
  };
});

export default defineConfig({
  site: SITE_ORIGIN,
  base: '/docs',
  trailingSlash: 'ignore',
  // Mermaid's renderer is one large client chunk, loaded only on pages with diagrams.
  vite: { build: { chunkSizeWarningLimit: 4096 } },
  integrations: [
    mermaid({ theme: 'neutral', autoTheme: true }),
    starlight({
      title: 'Uncage',
      description:
        'Let your website drive Claude Code on your users’ own computers: approvals, streaming, site tools and skills, with the process and the results kept on your site.',
      logo: { light: './src/assets/logo-light.svg', dark: './src/assets/logo-dark.svg', replacesTitle: false },
      // brand/favicon.svg (adapts to prefers-color-scheme); Starlight prefixes the base path.
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/ptmafia/uncage' }],
      editLink: { baseUrl: 'https://github.com/ptmafia/uncage/edit/main/apps/docs/' },
      lastUpdated: false,
      // The 404 page is src/content/docs/404.md (rendered by the docs route).
      disable404Route: true,
      customCss: ['./src/styles/custom.css'],
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        'zh-cn': { label: '简体中文', lang: 'zh-CN' },
        ja: { label: '日本語', lang: 'ja' },
      },
      components: {
        PageTitle: './src/components/PageTitle.astro',
      },
      head: [
        { tag: 'link', attrs: { rel: 'alternate', type: 'text/plain', title: 'llms.txt', href: '/docs/llms.txt' } },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', sizes: '180x180', href: '/docs/apple-touch-icon.png' } },
      ],
      plugins: [
        ...apiPlugins.map((p) => p.plugin),
        starlightLinksValidator({ errorOnFallbackPages: false, exclude: ['/docs/llms*.txt', '/docs/skills/**', '/docs/**/*.md'] }),
      ],
      sidebar: [
        ...sections.map((sec) => ({
          label: sec.label,
          translations: { 'zh-CN': sec.zh, ja: sec.ja },
          items: sec.items.map((slug) => ({ slug })),
        })),
        {
          label: 'API (generated)',
          translations: { 'zh-CN': 'API（自动生成）', ja: 'API（自動生成）' },
          collapsed: true,
          items: apiPlugins.map((p) => p.sidebarGroup),
        },
      ],
    }),
  ],
});
