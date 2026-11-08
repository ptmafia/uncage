import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { McpCapabilities, McpServer } from '@agentclientprotocol/sdk';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { siteApprovalRequest, ToolSpecSchema, type AdapterRunContext, type ApprovalOutcome, type RunTool, type ToolCallResult } from '@uncage/protocol';

/** The MCP server name the agent sees; agents usually expose its tools as `mcp__site__<name>`. */
export const SITE_MCP_SERVER = 'site';
/** Env var carrying the bearer token to the stdio bridge (never on its command line). */
export const BRIDGE_TOKEN_ENV = 'UNCAGE_MCP_TOKEN';
export const DECLINED_TEXT = 'The user declined this action.';

/**
 * The stdio → HTTP bridge script. Next to the bundle in `dist/`; when running from `src/`
 * (tests) the built copy in `../dist/` is used.
 */
export const bridgePath: string = (() => {
  const local = fileURLToPath(new URL('./mcp-stdio-bridge.js', import.meta.url));
  return existsSync(local) ? local : fileURLToPath(new URL('../dist/mcp-stdio-bridge.js', import.meta.url));
})();

export interface SiteMcpServer {
  /** `http://127.0.0.1:<port>/mcp` (Streamable HTTP). */
  url: string;
  /** Bearer token: 32 random bytes, base64url. */
  token: string;
  close(): Promise<void>;
}

export interface SiteMcpOptions {
  requestApproval: AdapterRunContext['requestApproval'];
  cwd: string;
  /** The run's signal: pending confirmations end (declined) when it fires. */
  signal: AbortSignal;
}

function toMcpResult(r: ToolCallResult): CallToolResult {
  return {
    content: r.content.map((c) => ({ type: 'text' as const, text: c.type === 'text' ? c.text : (JSON.stringify(c.json) ?? 'null') })),
    ...(r.isError !== undefined ? { isError: r.isError } : {}),
  };
}

const errorResult = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** MCP needs an object schema at the top; anything else is offered as a permissive object (the hub validates). */
function inputSchemaOf(t: RunTool): { type: 'object'; [k: string]: unknown } {
  return t.inputSchema.type === 'object' ? (t.inputSchema as { type: 'object' }) : { type: 'object' };
}

/** Resolves with the outcome, or `cancelled` as soon as the signal fires. */
function untilAborted(p: Promise<ApprovalOutcome>, signal: AbortSignal): Promise<ApprovalOutcome> {
  if (signal.aborted) return Promise.resolve({ decision: 'cancelled' });
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve({ decision: 'cancelled' });
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function mcpServerFor(tools: Map<string, RunTool>, o: SiteMcpOptions): Server {
  const server = new Server({ name: SITE_MCP_SERVER, version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: inputSchemaOf(t),
      ...(t.requiresConfirmation ? { annotations: { destructiveHint: true } } : {}),
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<CallToolResult> => {
    const t = tools.get(req.params.name);
    if (!t) return errorResult(`Unknown site tool: ${req.params.name}`);
    const args = req.params.arguments ?? {};
    if (t.requiresConfirmation) {
      let outcome: ApprovalOutcome;
      try {
        outcome = await untilAborted(
          o.requestApproval(siteApprovalRequest(t, args, `site_${randomUUID()}`, o.cwd)),
          AbortSignal.any([o.signal, extra.signal]),
        );
      } catch {
        // The approval could not be asked: deny.
        outcome = { decision: 'deny' };
      }
      if (outcome.decision !== 'allow') return errorResult(DECLINED_TEXT);
    }
    try {
      return toMcpResult(await t.call(args));
    } catch (err) {
      return errorResult(`Tool ${t.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return server;
}

function reply(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/**
 * Serves the run's site tools as a Streamable-HTTP MCP server on 127.0.0.1 (random port), stateless
 * (one MCP server per request), guarded by a bearer token. A tool with `requiresConfirmation` asks
 * `requestApproval` before each call; anything but `allow` returns an MCP error result and the site
 * is not called. Throws on an invalid or duplicate tool name.
 */
export async function startSiteMcpServer(tools: RunTool[], o: SiteMcpOptions): Promise<SiteMcpServer> {
  const byName = new Map<string, RunTool>();
  for (const t of tools) {
    if (!ToolSpecSchema.shape.name.safeParse(t.name).success) throw new Error(`invalid site tool name: ${JSON.stringify(t.name)}`);
    if (byName.has(t.name)) throw new Error(`duplicate site tool: ${t.name}`);
    byName.set(t.name, t);
  }
  const token = randomBytes(32).toString('base64url');
  const expected = Buffer.from(`Bearer ${token}`);
  const authorized = (req: IncomingMessage): boolean => {
    const got = Buffer.from(req.headers.authorization ?? '');
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== '/mcp') return reply(res, 404, 'Not found');
    if (!authorized(req)) return reply(res, 401, 'Unauthorized', { 'www-authenticate': 'Bearer' });
    // Stateless: no server-initiated stream (GET) and no session to delete.
    if (req.method !== 'POST') return reply(res, 405, 'Method not allowed', { allow: 'POST' });
    const server = mcpServerFor(byName, o);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  const http = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) reply(res, 500, err instanceof Error ? err.message : String(err));
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => {
      http.off('error', reject);
      resolve();
    });
  });
  const { port } = http.address() as AddressInfo;
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    close() {
      closing ??= new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
      return closing;
    },
  };
}

/**
 * How the agent reaches the site server: `type: 'http'` when the agent supports HTTP MCP
 * (`auto` + `mcpCapabilities.http`, or forced `http`), else the stdio bridge (which every ACP
 * agent must accept), with the token in its environment.
 */
export function siteMcpDeclaration(s: SiteMcpServer, caps: McpCapabilities | null | undefined, mode: 'auto' | 'http' | 'stdio'): McpServer {
  if (mode === 'http' || (mode === 'auto' && caps?.http === true)) {
    return { type: 'http', name: SITE_MCP_SERVER, url: s.url, headers: [{ name: 'Authorization', value: `Bearer ${s.token}` }] };
  }
  return { name: SITE_MCP_SERVER, command: process.execPath, args: [bridgePath, s.url], env: [{ name: BRIDGE_TOKEN_ENV, value: s.token }] };
}
