import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { APIRoute } from 'astro';

/** The skill committed at `skills/uncage/SKILL.md` in the repository, served as is. */
export const GET: APIRoute = async () => {
  // Astro builds from apps/docs; the skill lives at the repository root.
  const text = await readFile(resolve(process.cwd(), '../../skills/uncage/SKILL.md'), 'utf8');
  return new Response(text, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
};
