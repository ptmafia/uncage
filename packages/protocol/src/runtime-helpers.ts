import type { ToolSpec } from './connected.js';
import type { NativeApprovalInput } from './runtime.js';

/** Helpers shared by runtime adapters (site tools and skills in connected mode). */

const TITLE_MAX = 120;
const ARGS_MAX = 200;

const truncate = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

function compactArgs(args: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(args) ?? '';
  } catch {
    s = String(args);
  }
  return truncate(s, ARGS_MAX);
}

/** The approval card for a site tool that requires confirmation (category `mcp`). */
export function siteApprovalRequest(t: Pick<ToolSpec, 'name' | 'description'>, args: unknown, toolId: string, cwd: string): NativeApprovalInput {
  return {
    toolId,
    category: 'mcp',
    title: truncate(t.description.trim() || t.name, TITLE_MAX),
    target: { command: `${t.name}(${compactArgs(args)})`, cwd },
  };
}

/**
 * Claude Code runs `` !`cmd` `` and ```` ```! ```` blocks in skill bodies as shell, before the model
 * sees them and without asking. Hub skills are data, never code: escape the `!` of every inline
 * form (`\!` renders the same) and turn executable fences into plain `text` fences.
 */
export function neutralizeSkillMarkdown(md: string): string {
  return md.replace(/(`{3,}|~{3,})[ \t]*!/g, '$1text').replace(/!(?=`)/g, '\\!');
}
