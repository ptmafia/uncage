import { describe, expect, it } from 'vitest';
import { docsPath, getDict, localePath, locales, pendingLocales, type Locale } from '../src/i18n/index.ts';

describe('paths', () => {
  it('localePath', () => {
    expect(localePath('en', '/')).toBe('/');
    expect(localePath('en')).toBe('/');
    expect(localePath('zh', '/')).toBe('/zh/');
    expect(localePath('ja', '/')).toBe('/ja/');
    expect(localePath('zh', '#features')).toBe('/zh/#features');
  });

  it('docsPath', () => {
    expect(docsPath('ja', 'start/try-the-demo/')).toBe('/docs/ja/start/try-the-demo/');
    expect(docsPath('zh')).toBe('/docs/zh-cn/');
    expect(docsPath('en')).toBe('/docs/');
    expect(docsPath('en', '/start/quickstart-connected/')).toBe('/docs/start/quickstart-connected/');
  });
});

/** Every string leaf, keyed by its dotted path (`features.available.0.title`). */
function leaves(v: unknown, path = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (v !== null && typeof v === 'object') {
    for (const [k, child] of Object.entries(v)) {
      for (const [p, leaf] of leaves(child, path ? `${path}.${k}` : k)) out.set(p, leaf);
    }
  } else {
    out.set(path, v);
  }
  return out;
}

/**
 * Keys whose translation may legitimately equal the English text. Decided per key:
 * - `flow.browserTitle`: the example domain "your.site" (a URL, not copy).
 * - `hero.eyebrow` is NOT allowed: "v0.2" stays, but the sentence is translated.
 * - Brand names, "GitHub", "npm", "MIT", commands and code are not in the dictionaries at all
 *   (they live in the components), so they need no entry here.
 */
const sameAsEnglishAllowed = new Set(['flow.browserTitle']);

const english = leaves(getDict('en'));

describe.each(locales.filter((l) => l !== 'en') as Locale[])('%s dictionary', (locale) => {
  const dict = leaves(getDict(locale));

  it('has every English key, as a non-empty string', () => {
    for (const key of english.keys()) {
      const v = dict.get(key);
      expect(typeof v, key).toBe('string');
      expect((v as string).trim().length, key).toBeGreaterThan(0);
    }
    expect([...dict.keys()].sort()).toEqual([...english.keys()].sort());
  });

  // Skipped while the dictionary is an English placeholder (zh.ts / ja.ts export `pending = true`
  // until the translation lands in Task 5 of the website plan).
  it.skipIf(pendingLocales.includes(locale))('is translated: no value equals the English one (allow-list aside)', () => {
    const untranslated = [...english].filter(([k, v]) => !sameAsEnglishAllowed.has(k) && dict.get(k) === v).map(([k]) => k);
    expect(untranslated).toEqual([]);
  });
});
