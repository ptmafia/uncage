import { en } from './en.ts';
import { ja, pending as jaPending } from './ja.ts';
import type { Dict } from './schema.ts';
import { zh, pending as zhPending } from './zh.ts';

export type { Dict } from './schema.ts';

export const locales = ['en', 'zh', 'ja'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = 'en';

export interface LocaleInfo {
  /** BCP 47 tag for `<html lang>` and `hreflang`. */
  lang: string;
  /** The language's own name, for the switcher. */
  label: string;
  /** Short label for compact UI. */
  short: string;
  /** Open Graph locale. */
  og: string;
  /** The help site's locale directory under /docs/ ('' = English root). */
  docs: string;
}

export const localeInfo: Record<Locale, LocaleInfo> = {
  en: { lang: 'en', label: 'English', short: 'EN', og: 'en_US', docs: '' },
  zh: { lang: 'zh-CN', label: '简体中文', short: '中文', og: 'zh_CN', docs: 'zh-cn/' },
  ja: { lang: 'ja', label: '日本語', short: '日本語', og: 'ja_JP', docs: 'ja/' },
};

const dicts: Record<Locale, Dict> = { en, zh, ja };

/** Locales whose dictionary is still an English placeholder (see zh.ts / ja.ts). */
export const pendingLocales: Locale[] = [...(zhPending ? (['zh'] as const) : []), ...(jaPending ? (['ja'] as const) : [])];

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (locales as readonly string[]).includes(v);
}

export function getDict(locale: Locale): Dict {
  return dicts[locale];
}

const trimLeadingSlashes = (p: string) => p.replace(/^\/+/, '');

/** A path on this site in `locale`: `localePath('en', '/')` → `/`, `localePath('zh', '/')` → `/zh/`. */
export function localePath(locale: Locale, path = '/'): string {
  const prefix = locale === defaultLocale ? '/' : `/${locale}/`;
  return prefix + trimLeadingSlashes(path);
}

/** A help-site path in `locale`: `docsPath('zh')` → `/docs/zh-cn/`, `docsPath('ja', 'start/try-the-demo/')` → `/docs/ja/start/try-the-demo/`. */
export function docsPath(locale: Locale, path = ''): string {
  return `/docs/${localeInfo[locale].docs}${trimLeadingSlashes(path)}`;
}

/** English-only help-site pages (API reference, changelog): the same URL in every locale. */
export function docsPathEnglish(path = ''): string {
  return docsPath('en', path);
}

/**
 * Every "Try the demo" CTA links to `docsPath(locale, TRY_DEMO)`: the help site's Try-the-demo page
 * owns the live demo URL (PUBLIC_DEMO_URL) and explains the prerequisites first.
 */
export const TRY_DEMO = 'start/try-the-demo/';

export const GITHUB_URL = 'https://github.com/ptmafia/uncage';
export const NPM_URL = 'https://www.npmjs.com/org/uncage';

export interface HeadlinePart {
  text: string;
  em: boolean;
}

/**
 * Splits `hero.title` into unbreakable phrases (separated by `|`), each a list of parts with
 * `*emphasis*` resolved: `headline('A |*b c.*')` → `[[{A , em:false}], [{b c., em:true}]]`.
 * The page and the OG image render each phrase as a no-wrap span with `<wbr>` between phrases.
 */
export function headline(title: string): HeadlinePart[][] {
  let em = false;
  return title.split('|').map((phrase) =>
    phrase
      .split('*')
      .map((text, i) => {
        if (i > 0) em = !em;
        return { text, em };
      })
      .filter((p) => p.text),
  );
}
