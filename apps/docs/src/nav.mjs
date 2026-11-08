// @ts-check
/**
 * The site's reading order: the sidebar (astro.config.mjs) and /llms.txt + /llms-full.txt are built
 * from this one list, so agents read the pages in the same order people do.
 */
/** The deployment origin: env SITE_URL (an empty value counts as unset; trailing slashes are dropped), else the default. */
export const SITE_ORIGIN = (process.env.SITE_URL || 'https://uncage.vercel.app').replace(/\/+$/, '');
export const SITE_URL = `${SITE_ORIGIN}/docs`;

/** Locale directories of the translated pages (English is the root). */
export const translatedLocales = ['zh-cn', 'ja'];

/**
 * Pages that exist in English only (generated or release-process content). zh-cn and ja fall back to
 * the English page automatically (Starlight shows it with a notice); scripts/check-i18n.ts skips them.
 */
export const englishOnly = ['reference/changelog', 'guides/ci-and-releases'];
export const isEnglishOnly = (/** @type {string} */ slug) => slug.startsWith('api/') || englishOnly.includes(slug);

/** @type {Array<{ label: string; zh: string; ja: string; items: string[] }>} */
export const sections = [
  {
    label: 'Start here',
    zh: '开始',
    ja: 'はじめに',
    items: ['start/how-it-works', 'start/quickstart-connected', 'start/quickstart-local', 'start/try-the-demo', 'start/for-coding-agents'],
  },
  {
    label: 'Concepts',
    zh: '概念',
    ja: 'コンセプト',
    items: ['concepts', 'concepts/trust-model', 'reference/glossary'],
  },
  {
    label: 'Guides',
    zh: '指南',
    ja: 'ガイド',
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
    ja: 'リファレンス',
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
