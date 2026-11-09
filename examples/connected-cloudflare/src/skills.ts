import type { SkillSpec } from '@uncage/protocol';

/** Tells the user's Claude Code when and how to use this website's `save_note` tool. */
export const notesSkill: SkillSpec = {
  name: 'notes',
  description: 'Save notes to the website with the save_note tool.',
  markdown: `# Notes on this website

Use this when the user asks you to save, remember or write down a note on the website.

## Steps
1. Pick a short title (at most 120 characters) and write the note's body (plain text or Markdown,
   at most 4 000 characters) in the user's language.
2. Call \`save_note\` with \`{ "title": "<title>", "body": "<body>" }\`.
3. Tell the user the note is saved; it shows on the website's /notes page.

Do not call \`save_note\` for anything the user did not ask to save.
`,
};
