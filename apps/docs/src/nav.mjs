// @ts-check
/**
 * The site's reading order: the sidebar (astro.config.mjs) and /llms.txt + /llms-full.txt are built
 * from this one list, so agents read the pages in the same order people do.
 */
export const SITE_URL = 'https://ptmafia.github.io/uncage';

/** @type {Array<{ label: string; zh: string; items: string[] }>} */
export const sections = [
  {
    label: 'Start here',
    zh: '开始',
    items: ['start/how-it-works', 'start/quickstart-connected', 'start/quickstart-local', 'start/for-coding-agents'],
  },
  {
    label: 'Concepts',
    zh: '概念',
    items: ['concepts', 'concepts/trust-model', 'reference/glossary'],
  },
  {
    label: 'Guides',
    zh: '指南',
    items: [
      'guides/mount-the-hub',
      'guides/auth-and-device-approval',
      'guides/define-tools',
      'guides/write-skills',
      'guides/select-manifest',
      'guides/site-storage',
      'guides/multi-node',
      'guides/custom-ui',
      'guides/local-policy',
      'guides/ci-and-releases',
    ],
  },
  {
    label: 'Reference',
    zh: '参考',
    items: [
      'reference/cli',
      'reference/local-mode',
      'reference/http-api',
      'reference/errors',
      'reference/security',
      'reference/troubleshooting',
      'reference/changelog',
    ],
  },
];
