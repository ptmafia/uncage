/**
 * stdio MCP ↔ the run's loopback Streamable-HTTP site server, for ACP agents without HTTP MCP.
 * Usage: node mcp-stdio-bridge.js <url>, with the bearer token in UNCAGE_MCP_TOKEN.
 * Messages are proxied unchanged in both directions.
 */
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

const url = process.argv[2];
const token = process.env.UNCAGE_MCP_TOKEN;
if (!url || !token) {
  process.stderr.write('usage: UNCAGE_MCP_TOKEN=<token> mcp-stdio-bridge <url>\n');
  process.exit(2);
}

const upstream = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
const local = new StdioServerTransport();
const initializeIds = new Set<string | number>();

local.onmessage = (m: JSONRPCMessage) => {
  if ('method' in m && m.method === 'initialize' && 'id' in m) initializeIds.add(m.id);
  upstream.send(m).catch((err: unknown) => {
    if (!('method' in m) || !('id' in m)) return;
    const message = `Uncage site tools are unavailable: ${err instanceof Error ? err.message : String(err)}`;
    void local.send({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message } });
  });
};
upstream.onmessage = (m: JSONRPCMessage) => {
  // Later requests must carry the negotiated protocol version header.
  if ('id' in m && m.id !== undefined && initializeIds.delete(m.id) && 'result' in m) {
    const v = (m.result as { protocolVersion?: unknown }).protocolVersion;
    if (typeof v === 'string') upstream.setProtocolVersion(v);
  }
  void local.send(m);
};
upstream.onerror = (err) => process.stderr.write(`uncage mcp bridge: ${err.message}\n`);
const exit = (): void => void upstream.close().finally(() => process.exit(0));
local.onclose = exit;
process.stdin.on('end', exit);

await upstream.start();
await local.start();
