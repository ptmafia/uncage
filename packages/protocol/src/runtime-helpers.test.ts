import { describe, expect, it } from 'vitest';
import { neutralizeSkillMarkdown, siteApprovalRequest } from './index.js';

const tool = { name: 'echo_text', description: 'Echo the given text back.' };

describe('siteApprovalRequest', () => {
  it('uses the description as title, category mcp, and a compact command', () => {
    expect(siteApprovalRequest(tool, { text: 'hi' }, 'toolu_1', '/w')).toEqual({
      toolId: 'toolu_1',
      category: 'mcp',
      title: 'Echo the given text back.',
      target: { command: 'echo_text({"text":"hi"})', cwd: '/w' },
    });
  });

  it('caps the title at 120 chars and the args at 200; falls back to the name', () => {
    const r = siteApprovalRequest({ ...tool, description: 'd'.repeat(300) }, { text: 'x'.repeat(500) }, 't', '/w');
    expect(r.title.length).toBeLessThanOrEqual(120);
    const args = r.target.command!.slice('echo_text('.length, -1);
    expect(args.length).toBeLessThanOrEqual(200);
    expect(args.endsWith('…')).toBe(true);
    expect(siteApprovalRequest({ ...tool, description: ' ' }, {}, 't', '/w').title).toBe('echo_text');
  });

  it('survives unserializable args', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(siteApprovalRequest(tool, cyclic, 't', '/w').target.command).toBe('echo_text([object Object])');
  });
});

describe('neutralizeSkillMarkdown', () => {
  it('escapes inline !`cmd` and turns ```! fences into text fences', () => {
    const out = neutralizeSkillMarkdown('Run !`touch /tmp/pwn` now.\n```!\nrm -rf ~\n```\n  ~~~ !\nls\n~~~\nok: `code`');
    expect(out).not.toMatch(/(^|[^\\])!`/m);
    expect(out).toContain('\\!`touch /tmp/pwn`');
    expect(out).toContain('```text\nrm -rf ~');
    expect(out).toContain('~~~text\nls');
    expect(out).toContain('ok: `code`');
  });
});
