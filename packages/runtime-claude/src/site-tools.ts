import {
  createSdkMcpServer,
  tool,
  type AnyZodRawShape,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import { ToolSpecSchema, type RunTool, type ToolCallResult } from '@uncage/protocol';
import { z } from 'zod';

/** In-process MCP server carrying the site's tools; Claude Code names them `mcp__site__<name>`. */
export const SITE_MCP_SERVER = 'site';
export const siteToolFullName = (name: string): string => `mcp__${SITE_MCP_SERVER}__${name}`;

type CallToolResult = Awaited<ReturnType<SdkMcpToolDefinition['handler']>>;
type ObjectSchema = z.ZodObject;

// Moved to @uncage/protocol (shared with runtime-acp); re-exported for existing importers.
export { neutralizeSkillMarkdown, siteApprovalRequest } from '@uncage/protocol';
/** Writes the skills to `<cwd>/.claude/skills/<name>/` (shared with runtime-acp, which uses `.uncage/skills`). */
export { materializeSkills } from '@uncage/protocol/node';

/** Most JSON Schema nodes (objects + arrays) a site tool schema may have before it goes permissive. */
export const SCHEMA_NODE_BUDGET = 2000;
const REF_KEYS = new Set(['$ref', '$defs', 'definitions', '$dynamicRef', '$recursiveRef']);

/**
 * Cheap pre-check, run before zod ever sees the schema: references can fan out exponentially in
 * zod's (synchronous) conversion, so any `$ref`/`$defs` is refused, and so is a schema with more
 * than SCHEMA_NODE_BUDGET nodes.
 */
export function schemaWithinBudget(schema: unknown): boolean {
  const stack: unknown[] = [schema];
  let nodes = 0;
  while (stack.length > 0) {
    const v = stack.pop();
    if (v === null || typeof v !== 'object') continue;
    if (++nodes > SCHEMA_NODE_BUDGET) return false;
    if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
      continue;
    }
    for (const [k, x] of Object.entries(v)) {
      if (REF_KEYS.has(k)) return false;
      stack.push(x);
    }
  }
  return true;
}

/**
 * JSON Schema → zod for the SDK's `tool()`. Uses zod 4 `z.fromJSONSchema` (the SDK accepts zod 4
 * object schemas, which the MCP server validates arguments against). Anything that is not an
 * object schema, uses references, is too large, or that zod cannot convert both ways, becomes a
 * permissive object; the hub validates those arguments itself.
 */
export function siteToolSchema(jsonSchema: Record<string, unknown>): { schema: ObjectSchema; mode: 'converted' | 'permissive' } {
  if (!schemaWithinBudget(jsonSchema)) return { schema: z.looseObject({}), mode: 'permissive' };
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
  /** Tool definitions handed to the server (exposed for tests). */
  definitions: SdkMcpToolDefinition[];
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
  // The full ZodObject is passed where the type says raw shape: the MCP server's registerTool
  // accepts zod 4 object schemas (and keeps required/additionalProperties). Pinned by a test.
  const definitions: SdkMcpToolDefinition[] = tools.map((t) =>
    tool(
      t.name,
      t.description,
      siteToolSchema(t.inputSchema).schema as unknown as AnyZodRawShape,
      siteToolHandler(t),
      // In `auto` mode the classifier may approve an always_ask tool unless it is destructive.
      t.requiresConfirmation ? { annotations: { destructiveHint: true } } : undefined,
    ),
  );
  const server = createSdkMcpServer({ name: SITE_MCP_SERVER, tools: definitions, alwaysLoad: true });
  const confirm = tools.filter((t) => t.requiresConfirmation);
  // always_ask: the CLI asks canUseTool before each call even in modes that would otherwise allow it.
  // Tools without confirmation are allowed by the adapter's canUseTool (no allowedTools entry,
  // which would shadow canUseTool and make the SDK warn).
  if (confirm.length > 0) server.tools = confirm.map((t) => ({ name: t.name, permission_policy: 'always_ask' }));
  return { mcpServers: { [SITE_MCP_SERVER]: server }, definitions, byFullName };
}
