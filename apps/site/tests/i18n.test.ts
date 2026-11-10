import { describe, expect, it } from 'vitest';
import { docsPath, getDict, headline, localePath, locales, pendingLocales, type Locale } from '../src/i18n/index.ts';

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

describe('headline', () => {
  it('a single phrase with emphasis (en)', () => {
    expect(headline('Run your coding agent *everywhere.*')).toEqual([
      [
        { text: 'Run your coding agent ', em: false },
        { text: 'everywhere.', em: true },
      ],
    ]);
  });

  it('splits phrases at | and drops the empty parts', () => {
    expect(headline('你的 coding agent，|*无处不在。*')).toEqual([[{ text: '你的 coding agent，', em: false }], [{ text: '无处不在。', em: true }]]);
  });

  it('carries emphasis across a |', () => {
    expect(headline('a *b|c* d')).toEqual([
      [
        { text: 'a ', em: false },
        { text: 'b', em: true },
      ],
      [
        { text: 'c', em: true },
        { text: ' d', em: false },
      ],
    ]);
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
 * Keys whose translation may legitimately equal the English text. Decided per key and locale:
 * - `flow.browserTitle`: the example domain "your.site" (a URL, not copy).
 * - ja `flow.allow` / `flow.deny`: the approval buttons as the real UI shows them. @uncage/react-ui has
 *   no Japanese strings, so a Japanese visitor sees "Allow once" / "Deny" (zh has 允许执行 / 拒绝).
 * - `hero.eyebrow` is NOT allowed: "v0.3" stays, but the sentence is translated.
 * - Brand names, "GitHub", "npm", "MIT", commands and code are not in the dictionaries at all
 *   (they live in the components), so they need no entry here.
 */
const sameAsEnglishAllowed: Record<Exclude<Locale, 'en'>, Set<string>> = {
  zh: new Set(['flow.browserTitle']),
  ja: new Set(['flow.browserTitle', 'flow.allow', 'flow.deny']),
};

const english = leaves(getDict('en'));

describe.each(locales.filter((l) => l !== 'en') as Exclude<Locale, 'en'>[])('%s dictionary', (locale) => {
  const dict = leaves(getDict(locale));

  it('is not marked pending (an English placeholder)', () => {
    expect(pendingLocales).not.toContain(locale);
  });

  it('has every English key, as a non-empty string', () => {
    for (const key of english.keys()) {
      const v = dict.get(key);
      expect(typeof v, key).toBe('string');
      expect((v as string).trim().length, key).toBeGreaterThan(0);
    }
    expect([...dict.keys()].sort()).toEqual([...english.keys()].sort());
  });

  it('is translated: no value equals the English one (allow-list aside)', () => {
    const untranslated = [...english].filter(([k, v]) => !sameAsEnglishAllowed[locale].has(k) && dict.get(k) === v).map(([k]) => k);
    expect(untranslated).toEqual([]);
  });
});

describe('features', () => {
  it('every locale has the ACP feature card', () => {
    const [en, zh, ja] = (['en', 'zh', 'ja'] as const).map((l) => getDict(l));
    for (const d of [en!, zh!, ja!]) {
      expect(d.features.available).toHaveLength(11);
      expect(d.features.available[6].title).toMatch(/ACP/);
      expect(d.features.available[7].title).toMatch(/macOS.*Windows.*Linux/);
    }
  });

  it('no locale still lists serverless transport as coming soon', () => {
    for (const d of [getDict('en'), getDict('zh'), getDict('ja')]) {
      expect(JSON.stringify(d.features.soon)).not.toMatch(/Serverless|无服务器|サーバーレス|Vercel/);
      expect(d.features.soon).toHaveLength(2);
    }
  });

  it('every locale says one command, one approval and lists Windows and Linux as available', () => {
    const [en, zh, ja] = [getDict('en'), getDict('zh'), getDict('ja')];
    for (const d of [en, zh, ja]) {
      expect(d.features.available).toHaveLength(11);
      expect(d.features.soon).toHaveLength(2);
      expect(JSON.stringify(d.features.soon)).not.toMatch(/Windows|Linux/);
      expect(JSON.stringify(d.how.steps[0])).not.toMatch(/Two commands|两条命令|コマンドを2つ/);
    }
    expect(en.hero.installLabel).toBe('One command, one approval');
    expect(zh.hero.installLabel).toBe('一条命令，一次批准');
    expect(ja.hero.installLabel).toBe('コマンド1つ、承認1回');
  });
});
