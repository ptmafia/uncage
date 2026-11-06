import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Markdown } from './components/Markdown.js';

afterEach(cleanup);

describe('Markdown', () => {
  it('<script>, <img onerror>, [x](javascript:alert(1)) render inert', () => {
    const text = [
      '<script>alert(1)</script>',
      '',
      '<img src=x onerror="alert(1)">',
      '',
      '[x](javascript:alert(1)) [y](JaVaScRiPt:alert(1)) [z](data:text/html,<b>) [w](vbscript:msgbox)',
      '',
      '![pic](javascript:alert(1)) ![remote](https://evil.example/leak.png)',
    ].join('\n');
    const { container } = render(<Markdown text={text} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    for (const a of container.querySelectorAll('a')) {
      expect(a.getAttribute('href') ?? '').not.toMatch(/^\s*(javascript|data|vbscript):/i);
    }
    // The raw HTML is shown as text, not executed.
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('keeps http(s), mailto, relative and #anchor links; external links open in a new tab', () => {
    const { container } = render(
      <Markdown text="[a](https://example.com) [b](mailto:x@example.com) [c](./docs/readme.md) [d](#top)" />,
    );
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['https://example.com', 'mailto:x@example.com', './docs/readme.md', '#top']);
    const ext = container.querySelector('a[href="https://example.com"]')!;
    expect(ext.getAttribute('target')).toBe('_blank');
    expect(ext.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('renders GFM tables and code', () => {
    const { container } = render(<Markdown text={'| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```'} />);
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelector('pre code')?.textContent).toBe('const x = 1;\n');
  });
});
