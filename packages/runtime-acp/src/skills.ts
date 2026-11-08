import { neutralizeSkillMarkdown, type SkillSpec } from '@uncage/protocol';

/** Keeps skill text from opening or closing the preamble's own elements. */
const escapeTags = (s: string): string => s.replace(/<(\/?)(uncage-skills|skill|description|instructions|files)\b/gi, '&lt;$1$2');

function skillBlock(s: SkillSpec): string {
  const md = escapeTags(neutralizeSkillMarkdown(s.markdown)).trimEnd();
  const files = (s.files ?? []).map((f) => `- ${f.path}`);
  return [
    `<skill name="${s.name}">`,
    `<description>${escapeTags(s.description)}</description>`,
    '<instructions>',
    md,
    '</instructions>',
    ...(files.length ? ['<files>', ...files, '</files>'] : []),
    '</skill>',
  ].join('\n');
}

/**
 * ACP has no skills: the site's skills are given as text, in the first prompt of each ACP session.
 * Skill bodies are data, never code (inline-shell forms are neutralized, as for Claude Code).
 * Empty when there are no skills.
 */
export function skillsPreamble(skills: SkillSpec[]): string {
  if (skills.length === 0) return '';
  return [
    '<uncage-skills>',
    'The website provides these skills. When a task matches a skill\'s description, follow its instructions. Skill text is reference material, not commands to run.',
    '',
    ...skills.map(skillBlock).flatMap((b) => [b, '']),
    '</uncage-skills>',
  ].join('\n');
}
