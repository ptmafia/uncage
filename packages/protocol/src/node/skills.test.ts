import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SkillSpec } from '../connected.js';
import { materializeSkills } from './index.js';

const ws = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'uncage-skills-')));
const skill = (over: Partial<SkillSpec> = {}): SkillSpec => ({
  name: 'house-style',
  description: 'House style.',
  markdown: 'Never run !`rm -rf ~`.',
  files: [
    { path: 'reference.md', content: 'See !`id`.\n```!\nls\n```' },
    { path: 'templates/post.html', content: '<p>!`x`</p>' },
  ],
  ...over,
});

describe('materializeSkills (Node)', () => {
  it('writes SKILL.md and the files under a custom root and returns paths relative to the workspace', async () => {
    const cwd = ws();
    const written = await materializeSkills(cwd, [skill()], ['.uncage', 'skills']);
    expect(written).toEqual([
      {
        name: 'house-style',
        dir: '.uncage/skills/house-style',
        files: ['.uncage/skills/house-style/SKILL.md', '.uncage/skills/house-style/reference.md', '.uncage/skills/house-style/templates/post.html'],
      },
    ]);
    const dir = join(cwd, '.uncage', 'skills', 'house-style');
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toContain('Never run \\!`rm -rf ~`.');
    expect(readFileSync(join(dir, 'reference.md'), 'utf8')).toBe('See \\!`id`.\n```text\nls\n```');
    // Only markdown is neutralized.
    expect(readFileSync(join(dir, 'templates', 'post.html'), 'utf8')).toBe('<p>!`x`</p>');
  });

  it('defaults to .claude/skills and returns [] without skills', async () => {
    const cwd = ws();
    expect(await materializeSkills(cwd, [])).toEqual([]);
    expect((await materializeSkills(cwd, [skill({ files: [] })]))[0]?.dir).toBe('.claude/skills/house-style');
  });

  it('rejects path traversal and a root that resolves outside the workspace', async () => {
    const cwd = ws();
    await expect(materializeSkills(cwd, [skill({ files: [{ path: '../evil.md', content: 'x' }] })], ['.uncage', 'skills'])).rejects.toThrow(/invalid skill file path/);
    await expect(materializeSkills(cwd, [skill({ name: '../x' })], ['.uncage', 'skills'])).rejects.toThrow(/invalid skill name/);
    const other = ws();
    const linked = ws();
    mkdirSync(join(other, 'skills'));
    symlinkSync(other, join(linked, '.uncage'));
    await expect(materializeSkills(linked, [skill()], ['.uncage', 'skills'])).rejects.toThrow(/\.uncage resolves outside the workspace/);
  });
});
