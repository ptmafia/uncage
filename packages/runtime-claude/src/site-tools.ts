import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  createSdkMcpServer,
  tool,
  type AnyZodRawShape,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import {
  RelativePathSchema,
  SkillSpecSchema,
  ToolSpecSchema,
  type NativeApprovalInput,
  type RunTool,
  type SkillSpec,
  type ToolCallResult,
} from '@uncage/protocol';
import { z } from 'zod';

/** In-process MCP server carrying the site's tools; Claude Code names them `mcp__site__<name>`. */
export const SITE_MCP_SERVER = 'site';
export const siteToolFullName = (name: string): string => `mcp__${SITE_MCP_SERVER}__${name}`;

type CallToolResult = Awaited<ReturnType<SdkMcpToolDefinition['handler']>>;
type ObjectSchema = z.ZodObject;

const TITLE_MAX = 120;
const ARGS_MAX = 200;

const truncate = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

/**
 * JSON Schema → zod for the SDK's `tool()`. Uses zod 4 `z.fromJSONSchema` (the SDK accepts zod 4
 * object schemas, which the MCP server validates arguments against). Anything that is not an
 * object schema, or that zod cannot convert both ways, becomes a permissive object; the hub
 * validates those arguments itself.
 */
export function siteToolSchema(jsonSchema: Record<string, unknown>): { schema: ObjectSchema; mode: 'converted' | 'permissive' } {
  try {
    const s = z.fromJSONSchema(jsonSchema);
    if (s instanceof z.ZodObject) {
      // The SDK leaves out (with only a warning) a tool whose schema can't go back to JSON Schema.
      z.toJSONSchema(s, { io: 'input' });
      return { schema: s, mode: 'converted' };
    }
  } catch {
    // fall through
  }
  return { schema: z.looseObject({}), mode: 'permissive' };
}

export function toMcpResult(r: ToolCallResult): CallToolResult {
  return {
    content: r.content.map((c) => ({ type: 'text' as const, text: c.type === 'text' ? c.text : (JSON.stringify(c.json) ?? 'null') })),
    ...(r.isError !== undefined ? { isError: r.isError } : {}),
  };
}

/** A failing call (including `tool_failed`/`run_ended` on cancel) becomes an MCP error result, never a crash. */
export function siteToolHandler(t: RunTool): (args: unknown) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return toMcpResult(await t.call(args));
    } catch (err) {
      return { content: [{ type: 'text', text: `Tool ${t.name} failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  };
}

export interface SiteMcpOptions {
  mcpServers: Record<string, McpSdkServerConfigWithInstance>;
  /** Full names of tools that run without an approval card. */
  allowedTools: string[];
  byFullName: Map<string, RunTool>;
}

/**
 * Builds the `site` MCP server. Names are re-checked against the protocol rule (lowercase,
 * no `__`), so a site tool can never shadow a Claude Code built-in or another server's tool.
 * Throws on an invalid or duplicate name.
 */
export function siteMcpOptions(tools: RunTool[]): SiteMcpOptions {
  const byFullName = new Map<string, RunTool>();
  for (const t of tools) {
    if (!ToolSpecSchema.shape.name.safeParse(t.name).success) throw new Error(`invalid site tool name: ${JSON.stringify(t.name)}`);
    const full = siteToolFullName(t.name);
    if (byFullName.has(full)) throw new Error(`duplicate site tool: ${t.name}`);
    byFullName.set(full, t);
  }
  const defs = tools.map((t) =>
    tool(t.name, t.description, siteToolSchema(t.inputSchema).schema as unknown as AnyZodRawShape, siteToolHandler(t)),
  );
  const server = createSdkMcpServer({ name: SITE_MCP_SERVER, tools: defs, alwaysLoad: true });
  const confirm = tools.filter((t) => t.requiresConfirmation);
  // always_ask: the CLI asks canUseTool before each call even in modes that would otherwise allow it.
  if (confirm.length > 0) server.tools = confirm.map((t) => ({ name: t.name, permission_policy: 'always_ask' }));
  return {
    mcpServers: { [SITE_MCP_SERVER]: server },
    allowedTools: tools.filter((t) => !t.requiresConfirmation).map((t) => siteToolFullName(t.name)),
    byFullName,
  };
}

function compactArgs(args: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(args) ?? '';
  } catch {
    s = String(args);
  }
  return truncate(s, ARGS_MAX);
}

export function siteApprovalRequest(t: RunTool, args: unknown, toolId: string, cwd: string): NativeApprovalInput {
  return {
    toolId,
    category: 'mcp',
    title: truncate(t.description.trim() || t.name, TITLE_MAX),
    target: { command: `${t.name}(${compactArgs(args)})`, cwd },
  };
}

const inside = (root: string, p: string): boolean => {
  const r = relative(root, p);
  return r !== '' && !r.startsWith('..') && !isAbsolute(r);
};

function skillMd(s: SkillSpec): string {
  // A JSON string is a valid YAML double-quoted scalar.
  const body = s.markdown.endsWith('\n') ? s.markdown : `${s.markdown}\n`;
  return `---\nname: ${s.name}\ndescription: ${JSON.stringify(s.description)}\n---\n\n${body}`;
}

/**
 * Writes each skill to `<cwd>/.claude/skills/<name>/` (SKILL.md + files), replacing that folder
 * on every run. Nothing outside those folders is touched. Paths are checked lexically and on disk
 * (realpath), and files are created exclusively so a symlink is never followed.
 */
export async function materializeSkills(cwd: string, skills: SkillSpec[]): Promise<void> {
  if (skills.length === 0) return;
  const realCwd = await realpath(cwd);
  const root = join(realCwd, '.claude', 'skills');
  await mkdir(root, { recursive: true });
  const realRoot = await realpath(root);
  if (!inside(realCwd, realRoot)) throw new Error('.claude/skills resolves outside the workspace');

  for (const s of skills) {
    if (!SkillSpecSchema.shape.name.safeParse(s.name).success) throw new Error(`invalid skill name: ${JSON.stringify(s.name)}`);
    for (const f of s.files ?? []) {
      if (!RelativePathSchema.safeParse(f.path).success) throw new Error(`invalid skill file path: ${JSON.stringify(f.path)}`);
      if (f.path.toLowerCase() === 'skill.md') throw new Error('skill file path collides with SKILL.md');
    }
  }

  for (const s of skills) {
    const dir = join(realRoot, s.name);
    // rm does not follow a symlink at `dir`; it removes the link itself.
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir);
    const realDir = await realpath(dir);
    if (!inside(realRoot, realDir)) throw new Error(`skill folder ${s.name} resolves outside .claude/skills`);
    await writeFile(join(realDir, 'SKILL.md'), skillMd(s), { flag: 'wx' });
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
      await writeFile(file, f.content, { flag: 'wx' });
    }
  }
}
