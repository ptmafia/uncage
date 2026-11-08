import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isTranslatedId, stripMdx, toMarkdownLinks } from '../src/lib/markdown.ts';
import { SITE_URL } from '../src/nav.mjs';

describe('toMarkdownLinks', () => {
  it('rewrites only /docs/ page links to absolute .md URLs', () => {
    const out = toMarkdownLinks('[a](/docs/guides/x/#h) [b](/api/uncage/agent)');
    expect(out).toBe(`[a](${SITE_URL}/guides/x.md#h) [b](/api/uncage/agent)`);
    expect(out).toContain('/docs/guides/x.md#h');
  });

  it('keeps file links as they are, without .md', () => {
    expect(toMarkdownLinks('[s](/docs/skills/uncage/SKILL.md)')).toBe(`[s](${SITE_URL}/skills/uncage/SKILL.md)`);
  });
});

describe('stripMdx', () => {
  it('drops imports and components, keeps screenshot alt text', () => {
    const out = stripMdx("import { Image } from 'astro:assets';\n\nHi\n\n<DemoLink />\n\n<Image src={a} alt=\"A card\" />\n");
    expect(out).toBe('Hi\n\n*(Screenshot: A card)*\n');
  });
});

describe('stripMdx robustness', () => {
  it('handles multi-line imports, props and single-quoted or expression alt', () => {
    const src = "import {\n  A,\n  B,\n} from 'x';\nimport c from './c.png';\n\n<Demo url=\"x\" />\n\n<Image src={c} alt='Single' width={3} />\n<Image\n  src={c}\n  alt={\"Braced\"}\n/>\n\nText\n";
    const out = stripMdx(src);
    expect(out).not.toMatch(/^import/m);
    expect(out).not.toMatch(/<[A-Z]/);
    expect(out).toContain('*(Screenshot: Single)*');
    expect(out).toContain('*(Screenshot: Braced)*');
  });

  it('leaves no import or component in the try-the-demo page', () => {
    const mdx = readFileSync(new URL('../src/content/docs/start/try-the-demo.mdx', import.meta.url), 'utf8');
    const out = stripMdx(mdx.replace(/^---[\s\S]*?---\n/, ''));
    expect(out).not.toMatch(/^import/m);
    expect(out).not.toMatch(/<[A-Z]/);
  });
});

describe('isTranslatedId', () => {
  it('covers zh-cn and ja, not English or api', () => {
    for (const id of ['zh-cn/index', 'ja/start/x', 'ja', 'zh-cn']) expect(isTranslatedId(id)).toBe(true);
    for (const id of ['index', 'start/x', 'api/hub/index', 'jaws/x']) expect(isTranslatedId(id)).toBe(false);
  });
});
