import { existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ApprovalOutcome, NativeApprovalInput, RunTool } from '@uncage/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { bridgePath, siteMcpDeclaration, startSiteMcpServer, type SiteMcpServer } from './site-mcp.js';

const servers: SiteMcpServer[] = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

function tools() {
  const calls: Record<string, unknown[]> = {};
  const make = (name: string, requiresConfirmation: boolean, description = `Do ${name}.`): RunTool => ({
    name,
    description,
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    requiresConfirmation,
    call: (args) => {
      (calls[name] ??= []).push(args);
      if (name === 'boom') return Promise.reject(new Error('site down'));
      return Promise.resolve({ content: [{ type: 'text', text: `${name} ok` }, { type: 'json', json: { n: 1 } }] });
    },
  });
  return { calls, list: [make('save_note', false), make('publish', true, 'Publish the page.'), make('boom', false)] };
}

async function start(outcome: ApprovalOutcome | (() => Promise<ApprovalOutcome>) = { decision: 'allow' }, signal = new AbortController().signal) {
  const t = tools();
  const requests: NativeApprovalInput[] = [];
  const server = await startSiteMcpServer(t.list, {
    cwd: '/w',
    signal,
    requestApproval: (i) => {
      requests.push(i);
      return typeof outcome === 'function' ? outcome() : Promise.resolve(outcome);
    },
  });
  servers.push(server);
  return { ...t, server, requests };
}

async function httpClient(s: SiteMcpServer): Promise<Client> {
  const client = new Client({ name: 'test', version: '1' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers: { Authorization: `Bearer ${s.token}` } } }));
  return client;
}

const texts = (r: unknown): string[] => ((r as { content: Array<{ text: string }> }).content ?? []).map((c) => c.text);

describe('startSiteMcpServer', () => {
  it('listens on 127.0.0.1 with a 32-byte base64url bearer token', async () => {
    const { server } = await start();
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(server.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('lists the site tools with their JSON schemas and calls them', async () => {
    const { server, calls, requests } = await start();
    const client = await httpClient(server);
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual(['boom', 'publish', 'save_note']);
    expect(listed.tools.find((t) => t.name === 'save_note')).toMatchObject({
      description: 'Do save_note.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    });
    const r = await client.callTool({ name: 'save_note', arguments: { text: 'hi' } });
    expect(texts(r)).toEqual(['save_note ok', '{"n":1}']);
    expect(calls.save_note).toEqual([{ text: 'hi' }]);
    expect(requests).toEqual([]);
  });

  it('requiresConfirmation asks first; deny returns an MCP error and never calls the site', async () => {
    const { server, calls, requests } = await start({ decision: 'deny' });
    const client = await httpClient(server);
    const r = await client.callTool({ name: 'publish', arguments: { text: 'x' } });
    expect(r).toMatchObject({ isError: true });
    expect(texts(r)).toEqual(['The user declined this action.']);
    expect(calls.publish).toBeUndefined();
    expect(requests).toEqual([
      { toolId: expect.stringMatching(/^site_/), category: 'mcp', title: 'Publish the page.', target: { command: 'publish({"text":"x"})', cwd: '/w' } },
    ]);
  });

  it('allow calls the site; a failing approval or call is an MCP error result', async () => {
    const allowed = await start({ decision: 'allow' });
    let client = await httpClient(allowed.server);
    expect(texts(await client.callTool({ name: 'publish', arguments: { text: 'x' } }))).toEqual(['publish ok', '{"n":1}']);
    expect(await client.callTool({ name: 'boom', arguments: { text: 'x' } })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('site down') }] });
    expect(await client.callTool({ name: 'nope', arguments: {} })).toMatchObject({ isError: true });

    const failing = await start(() => Promise.reject(new Error('store down')));
    client = await httpClient(failing.server);
    expect(await client.callTool({ name: 'publish', arguments: { text: 'x' } })).toMatchObject({ isError: true });
    expect(failing.calls.publish).toBeUndefined();
  });

  it('a pending confirmation ends (declined) when the run is aborted', async () => {
    const controller = new AbortController();
    const { server, calls } = await start(() => new Promise(() => undefined), controller.signal);
    const client = await httpClient(server);
    const pending = client.callTool({ name: 'publish', arguments: { text: 'x' } });
    setTimeout(() => controller.abort(), 20);
    expect(await pending).toMatchObject({ isError: true });
    expect(calls.publish).toBeUndefined();
  });

  it('refuses a missing or wrong bearer with 401, and stops listening once closed', async () => {
    const { server } = await start();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    expect((await fetch(server.url, { method: 'POST', headers, body })).status).toBe(401);
    expect((await fetch(server.url, { method: 'POST', headers: { ...headers, authorization: 'Bearer nope' }, body })).status).toBe(401);
    await server.close();
    await expect(fetch(server.url, { method: 'POST', headers, body })).rejects.toThrow();
  });

  it('rejects invalid or duplicate tool names', async () => {
    const o = { cwd: '/w', signal: new AbortController().signal, requestApproval: () => Promise.resolve({ decision: 'allow' as const }) };
    const t = tools().list[0]!;
    await expect(startSiteMcpServer([{ ...t, name: 'Bad__name' }], o)).rejects.toThrow(/invalid site tool/);
    await expect(startSiteMcpServer([t, t], o)).rejects.toThrow(/duplicate site tool/);
  });
});

describe('siteMcpDeclaration', () => {
  const s = { url: 'http://127.0.0.1:1234/mcp', token: 'tok', close: () => Promise.resolve() };
  const http = { type: 'http', name: 'site', url: s.url, headers: [{ name: 'Authorization', value: 'Bearer tok' }] };
  const stdio = { name: 'site', command: process.execPath, args: [bridgePath, s.url], env: [{ name: 'UNCAGE_MCP_TOKEN', value: 'tok' }] };

  it('auto: http when the agent has mcpCapabilities.http, else the stdio bridge', () => {
    expect(siteMcpDeclaration(s, { http: true }, 'auto')).toEqual(http);
    expect(siteMcpDeclaration(s, { sse: true }, 'auto')).toEqual(stdio);
    expect(siteMcpDeclaration(s, undefined, 'auto')).toEqual(stdio);
  });

  it('http and stdio are forced by the entry', () => {
    expect(siteMcpDeclaration(s, undefined, 'http')).toEqual(http);
    expect(siteMcpDeclaration(s, { http: true }, 'stdio')).toEqual(stdio);
  });
});

describe('mcp-stdio-bridge', () => {
  it('proxies stdio MCP to the site server with the token from the environment', async () => {
    expect(existsSync(bridgePath)).toBe(true);
    const { server, calls } = await start();
    const decl = siteMcpDeclaration(server, undefined, 'stdio') as { command: string; args: string[]; env: Array<{ name: string; value: string }> };
    const client = new Client({ name: 'test', version: '1' });
    clients.push(client);
    await client.connect(
      new StdioClientTransport({ command: decl.command, args: decl.args, env: { ...getDefaultEnvironment(), ...Object.fromEntries(decl.env.map((e) => [e.name, e.value])) } }),
    );
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['boom', 'publish', 'save_note']);
    expect(texts(await client.callTool({ name: 'save_note', arguments: { text: 'via stdio' } }))[0]).toBe('save_note ok');
    expect(calls.save_note).toEqual([{ text: 'via stdio' }]);
  });
});
