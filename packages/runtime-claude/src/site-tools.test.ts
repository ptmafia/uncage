import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunTool, SkillSpec, ToolCallResult } from '@uncage/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  materializeSkills,
  siteApprovalRequest,
  siteMcpOptions,
  siteToolHandler,
  siteToolSchema,
  toMcpResult,
} from './site-tools.js';

const echo = (over: Partial<RunTool> = {}): RunTool => ({
  name: 'echo_text',
  description: 'Echo the given text back.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  requiresConfirmation: false,
  call: vi.fn(async (args: unknown): Promise<ToolCallResult> => ({ content: [{ type: 'text', text: JSON.stringify(args) }] })),
  ...over,
});

describe('siteToolSchema', () => {
  it('converts an object JSON Schema with zod 4 fromJSONSchema (validates args)', () => {
    const { schema, mode } = siteToolSchema(echo().inputSchema);
    expect(mode).toBe('converted');
    expect(schema.safeParse({ text: 'hi' }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it.each([[{}], [{ type: 'string' }], [{ type: 'object', properties: { a: { $ref: '#/nope' } } }]])(
    'falls back to a permissive object for %j',
    (s) => {
      const { schema, mode } = siteToolSchema(s);
      expect(mode).toBe('permissive');
      expect(schema.parse({ any: 1 })).toEqual({ any: 1 });
    },
  );
});

describe('toMcpResult', () => {
  it('maps text and json parts and keeps isError', () => {
    expect(toMcpResult({ content: [{ type: 'text', text: 'a' }, { type: 'json', json: { b: 1 } }] })).toEqual({
      content: [{ type: 'text', text: 'a' }, { type: 'text', text: '{"b":1}' }],
    });
    expect(toMcpResult({ content: [{ type: 'text', text: 'x' }], isError: true })).toEqual({
      content: [{ type: 'text', text: 'x' }],
      isError: true,
    });
  });
});

describe('siteToolHandler', () => {
  it('calls the tool and maps its result', async () => {
    const t = echo();
    await expect(siteToolHandler(t)({ text: 'hi' })).resolves.toEqual({ content: [{ type: 'text', text: '{"text":"hi"}' }] });
    expect(t.call).toHaveBeenCalledWith({ text: 'hi' });
  });

  it('a rejected call becomes an MCP error result', async () => {
    const t = echo({ call: () => Promise.reject(new Error('run_ended')) });
    await expect(siteToolHandler(t)({})).resolves.toEqual({
      content: [{ type: 'text', text: 'Tool echo_text failed: run_ended' }],
      isError: true,
    });
  });
});

describe('siteMcpOptions', () => {
  it('builds the site server; only non-confirmation tools are pre-allowed', () => {
    const o = siteMcpOptions([echo(), echo({ name: 'delete_page', requiresConfirmation: true })]);
    expect(Object.keys(o.mcpServers)).toEqual(['site']);
    expect(o.mcpServers.site).toMatchObject({ type: 'sdk', name: 'site' });
    expect(o.mcpServers.site!.tools).toEqual([{ name: 'delete_page', permission_policy: 'always_ask' }]);
    expect(o.allowedTools).toEqual(['mcp__site__echo_text']);
    expect([...o.byFullName.keys()]).toEqual(['mcp__site__echo_text', 'mcp__site__delete_page']);
  });

  it.each(['Bash', 'Read', 'mcp__x__y', 'a__b', 'bad-name', '', 'x'.repeat(49)])('rejects tool name %j', (name) => {
    expect(() => siteMcpOptions([echo({ name })])).toThrow(/invalid site tool name/);
  });

  it('rejects duplicate names', () => {
    expect(() => siteMcpOptions([echo(), echo()])).toThrow(/duplicate site tool/);
  });
});

describe('siteApprovalRequest', () => {
  it('uses the description as title, category mcp, and a compact command', () => {
    const t = echo({ requiresConfirmation: true });
    expect(siteApprovalRequest(t, { text: 'hi' }, 'toolu_1', '/w')).toEqual({
      toolId: 'toolu_1',
      category: 'mcp',
      title: 'Echo the given text back.',
      target: { command: 'echo_text({"text":"hi"})', cwd: '/w' },
    });
  });

  it('caps the title at 120 chars and the args at 200', () => {
    const t = echo({ description: 'd'.repeat(300) });
    const r = siteApprovalRequest(t, { text: 'x'.repeat(500) }, 'toolu_1', '/w');
    expect(r.title.length).toBeLessThanOrEqual(120);
    const args = r.target!.command!.slice('echo_text('.length, -1);
    expect(args.length).toBeLessThanOrEqual(200);
    expect(args.endsWith('…')).toBe(true);
  });

  it('falls back to the tool name when there is no description', () => {
    expect(siteApprovalRequest(echo({ description: '' }), {}, 't', '/w').title).toBe('echo_text');
  });
});

describe('materializeSkills', () => {
  const ws = () => realpathSync(mkdtempSync(join(tmpdir(), 'uncage-skills-')));
  const skill = (over: Partial<SkillSpec> = {}): SkillSpec => ({
    name: 'seo-audit',
    description: 'Audit: "SEO" things\nfor pages',
    markdown: '# SEO\nAlways be kind.',
    ...over,
  });

  it('writes SKILL.md with frontmatter and the skill files', async () => {
    const cwd = ws();
    await materializeSkills(cwd, [skill({ files: [{ path: 'ref/checklist.md', content: 'c' }] })]);
    const dir = join(cwd, '.claude', 'skills', 'seo-audit');
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toBe(
      '---\nname: seo-audit\ndescription: "Audit: \\"SEO\\" things\\nfor pages"\n---\n\n# SEO\nAlways be kind.\n',
    );
    expect(readFileSync(join(dir, 'ref', 'checklist.md'), 'utf8')).toBe('c');
  });

  it('overwrites the skill folder on each run and leaves other skills alone', async () => {
    const cwd = ws();
    mkdirSync(join(cwd, '.claude', 'skills', 'mine'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'skills', 'mine', 'SKILL.md'), 'user owned');
    await materializeSkills(cwd, [skill({ files: [{ path: 'old.md', content: 'o' }] })]);
    await materializeSkills(cwd, [skill({ markdown: 'v2' })]);
    const dir = join(cwd, '.claude', 'skills', 'seo-audit');
    expect(readdirSync(dir)).toEqual(['SKILL.md']);
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toContain('v2');
    expect(readFileSync(join(cwd, '.claude', 'skills', 'mine', 'SKILL.md'), 'utf8')).toBe('user owned');
  });

  it.each(['../escape.md', '/abs.md', 'a/../../x', 'a\\b', 'SKILL.md', 'skill.md'])('rejects file path %j', async (path) => {
    const cwd = ws();
    await expect(materializeSkills(cwd, [skill({ files: [{ path, content: 'x' }] })])).rejects.toThrow(/skill file/);
    expect(existsSync(join(cwd, 'escape.md'))).toBe(false);
  });

  it('rejects invalid skill names', async () => {
    await expect(materializeSkills(ws(), [skill({ name: '../x' })])).rejects.toThrow(/invalid skill name/);
  });

  it('refuses a .claude/skills that resolves outside the workspace', async () => {
    const cwd = ws();
    const outside = ws();
    mkdirSync(join(cwd, '.claude'));
    symlinkSync(outside, join(cwd, '.claude', 'skills'));
    await expect(materializeSkills(cwd, [skill()])).rejects.toThrow(/outside the workspace/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('never follows a symlinked directory inside the skill folder', async () => {
    const cwd = ws();
    const outside = ws();
    // A symlink placed by an earlier file write cannot exist (the folder is recreated), but a
    // parent directory symlinked from a sibling path must still be refused.
    mkdirSync(join(cwd, '.claude', 'skills'), { recursive: true });
    symlinkSync(outside, join(cwd, '.claude', 'skills', 'seo-audit'));
    await materializeSkills(cwd, [skill({ files: [{ path: 'a/b.md', content: 'x' }] })]);
    expect(readdirSync(outside)).toEqual([]);
    expect(readFileSync(join(cwd, '.claude', 'skills', 'seo-audit', 'a', 'b.md'), 'utf8')).toBe('x');
  });
});
