import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isTranslatedId, stripMdx, toMarkdownLinks } from '../src/lib/markdown.ts';
import { ACP_PRESETS } from '@uncage/runtime-acp';
import { SITE_URL, sections } from '../src/nav.mjs';

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
    expect(out).not.toContain("from '");
    expect(out).not.toMatch(/^\s*[A-Z],/m);
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

describe('stripMdx imports', () => {
  it('removes multi-line and side-effect imports completely', () => {
    expect(stripMdx("import {\n  A,\n  B,\n} from 'x';\n\nText\n")).toBe('Text\n');
    expect(stripMdx("import './a.css';\nimport D, { E } from \"y\"\nText\n")).toBe('Text\n');
  });
});

describe('isTranslatedId', () => {
  it('covers zh-cn and ja, not English or api', () => {
    for (const id of ['zh-cn/index', 'ja/start/x', 'ja', 'zh-cn']) expect(isTranslatedId(id)).toBe(true);
    for (const id of ['index', 'start/x', 'api/hub/index', 'jaws/x']) expect(isTranslatedId(id)).toBe(false);
  });
});

describe('the ACP guide', () => {
  it('the ACP guide documents every preset and the capability differences', () => {
    const page = (loc: string) => readFileSync(new URL(`../src/content/docs/${loc}guides/use-any-acp-agent.md`, import.meta.url), 'utf8');
    const en = page('');
    for (const h of ['Configure', 'Presets', 'Differences from the native runtimes', 'Troubleshooting', 'Verify']) {
      expect(en, `heading ${h}`).toMatch(new RegExp(`^## ${h}$`, 'm'));
    }
    for (const text of [en, page('zh-cn/'), page('ja/')]) {
      for (const p of ACP_PRESETS) {
        expect(text).toContain(`\`${p.id}\``);
        expect(text).toContain(p.displayName);
        expect(text).toContain(`\`${p.command.join(' ')}\``);
      }
      for (const field of ['presets', 'autoDetect', 'enable', 'consented', 'disable', 'agents', 'preset', 'displayName', 'command', 'env', 'mcp', 'enabled']) {
        expect(text, `field ${field}`).toMatch(new RegExp(`^\\s*-?\\s*${field}:`, 'm'));
      }
      for (const term of ['skills', 'fs', 'terminal', 'allow_once', 'session/load', 'session/resume', 'not_installed', 'auth_required', 'uncage runtimes']) {
        expect(text, term).toContain(term);
      }
    }
  });
});

describe('the deploy pages', () => {
  const deployPages = ['deploy/node', 'deploy/vercel', 'deploy/cloudflare-workers', 'deploy/other-fetch-platforms'];

  it('every deploy page has the six required sections', () => {
    for (const slug of deployPages) {
      const page = readFileSync(new URL(`../src/content/docs/${slug}.md`, import.meta.url), 'utf8');
      for (const h of ['Prerequisites', 'Code', 'Environment variables', 'Deploy', 'Verify', 'FAQ']) {
        expect(page, `${slug}: heading ${h}`).toMatch(new RegExp(`^## ${h}$`, 'm'));
      }
    }
  });

  it('the deployment-mode page, the deploy pages and the migration page are in the sidebar', () => {
    const items = sections.flatMap((s) => s.items);
    expect(items).toContain('start/choose-deployment-mode');
    expect(items).toContain('reference/migrate-from-0-2');
    for (const slug of deployPages) expect(items).toContain(slug);
  });
});
