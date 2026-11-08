import { describe, expect, it } from 'vitest';
import { stripMdx, toMarkdownLinks } from '../src/lib/markdown.ts';
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
