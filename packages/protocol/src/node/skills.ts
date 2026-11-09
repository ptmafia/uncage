import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { RelativePathSchema, SkillSpecSchema, type SkillSpec } from '../connected.js';
import { neutralizeSkillMarkdown } from '../runtime-helpers.js';

/** A skill written to disk: its folder and files, as forward-slash paths relative to the workspace. */
export interface MaterializedSkill {
  name: string;
  dir: string;
  /** `SKILL.md` first, then the skill's own files in their given order. */
  files: string[];
}

const inside = (root: string, p: string): boolean => {
  const r = relative(root, p);
  return r !== '' && !r.startsWith('..') && !isAbsolute(r);
};

async function ensureDirInside(realCwd: string, path: string, label: string): Promise<string> {
  if (!(await lstat(path).catch(() => undefined))) await mkdir(path);
  const real = await realpath(path);
  if (!inside(realCwd, real)) throw new Error(`${label} resolves outside the workspace`);
  return real;
}

const isMarkdownPath = (p: string): boolean => /\.(md|markdown|mdx)$/i.test(p);

function skillMd(s: SkillSpec): string {
  // A JSON string is a valid YAML double-quoted scalar.
  const md = neutralizeSkillMarkdown(s.markdown);
  const body = md.endsWith('\n') ? md : `${md}\n`;
  return `---\nname: ${s.name}\ndescription: ${JSON.stringify(s.description)}\n---\n\n${body}`;
}

/**
 * Writes each skill to `<cwd>/<root…>/<name>/` (SKILL.md + files), replacing that folder on every
 * run. Nothing outside those folders is touched. Paths are checked lexically and on disk
 * (realpath), every level of `root` must resolve inside the workspace, and files are created
 * exclusively so a symlink is never followed. Markdown is neutralized (no inline shell).
 * `root` defaults to `.claude/skills` (where Claude Code reads project skills).
 */
export async function materializeSkills(cwd: string, skills: SkillSpec[], root: string[] = ['.claude', 'skills']): Promise<MaterializedSkill[]> {
  if (skills.length === 0) return [];
  for (const s of skills) {
    if (!SkillSpecSchema.shape.name.safeParse(s.name).success) throw new Error(`invalid skill name: ${JSON.stringify(s.name)}`);
    for (const f of s.files ?? []) {
      if (!RelativePathSchema.safeParse(f.path).success) throw new Error(`invalid skill file path: ${JSON.stringify(f.path)}`);
      if (f.path.toLowerCase() === 'skill.md') throw new Error('skill file path collides with SKILL.md');
    }
  }
  const realCwd = await realpath(cwd);
  // Check each level before creating anything below it: an existing level (symlink or not) must
  // resolve inside the workspace, otherwise nothing is written anywhere.
  let realRoot = realCwd;
  const labels: string[] = [];
  for (const segment of root) {
    labels.push(segment);
    realRoot = await ensureDirInside(realCwd, join(realRoot, segment), labels.join('/'));
  }
  const rootLabel = root.join('/');
  const rel = (p: string): string => relative(realCwd, p).split(/[\\/]/).join('/');

  const written: MaterializedSkill[] = [];
  for (const s of skills) {
    const dir = join(realRoot, s.name);
    // rm does not follow a symlink at `dir`; it removes the link itself.
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir);
    const realDir = await realpath(dir);
    if (!inside(realRoot, realDir)) throw new Error(`skill folder ${s.name} resolves outside ${rootLabel}`);
    await writeFile(join(realDir, 'SKILL.md'), skillMd(s), { flag: 'wx' });
    const files = [rel(join(realDir, 'SKILL.md'))];
    for (const f of s.files ?? []) {
      const target = resolve(realDir, ...f.path.split('/'));
      if (!inside(realDir, target)) throw new Error(`skill file path escapes the skill folder: ${f.path}`);
      const parent = dirname(target);
      await mkdir(parent, { recursive: true });
      const realParent = await realpath(parent);
      if (realParent !== realDir && !inside(realDir, realParent)) throw new Error(`skill file path escapes the skill folder: ${f.path}`);
      const file = join(realParent, basename(target));
      if (await lstat(file).catch(() => undefined)) throw new Error(`duplicate skill file path: ${f.path}`);
      // 'wx': never write through an existing file or symlink.
      await writeFile(file, isMarkdownPath(f.path) ? neutralizeSkillMarkdown(f.content) : f.content, { flag: 'wx' });
      files.push(rel(file));
    }
    written.push({ name: s.name, dir: rel(realDir), files });
  }
  return written;
}
