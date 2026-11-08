#!/usr/bin/env node
/**
 * A fake ACP agent for tests: newline-delimited JSON-RPC over stdio (stable ACP v1, official SDK).
 * Scenarios: see ./scenarios.ts. Env:
 *   FAKE_ACP_CAPS            JSON `agentCapabilities` for `initialize` (default `{"loadSession":true}`)
 *   FAKE_ACP_PROTOCOL        `protocolVersion` to answer `initialize` with (default 1)
 *   FAKE_ACP_IGNORE_CANCEL=1 ignore `session/cancel`
 *   FAKE_ACP_AUTH=required   `session/new` fails with -32000 (auth required)
 *   FAKE_ACP_MODES           comma-separated session mode ids (current: the first); `session/set_mode` switches
 *   FAKE_ACP_RECORD          append every received JSON-RPC message (requests, notifications and the client's
 *                            responses) to this JSONL file; the first line is `{"fake":"start","pid":<pid>}`; scenario notes
 *                            are lines with a `fake` key (e.g. `{"fake":"mcp","listedTools":[…]}`)
 */
import { appendFileSync, writeSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { createFakeAcpAgent } from './scenarios.js';

const env = process.env;
const record = env.FAKE_ACP_RECORD;
if (record) appendFileSync(record, `${JSON.stringify({ fake: 'start', pid: process.pid })}\n`);

/** Passes stdin through unchanged, appending each complete line to the record file. */
function recorder(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = '';
  return new TransformStream({
    transform(chunk, controller) {
      if (record) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line !== '') appendFileSync(record, `${line}\n`);
        }
      }
      controller.enqueue(chunk);
    },
  });
}

const app = createFakeAcpAgent({
  ...(env.FAKE_ACP_CAPS ? { caps: JSON.parse(env.FAKE_ACP_CAPS) as Record<string, unknown> } : {}),
  ...(env.FAKE_ACP_PROTOCOL ? { protocolVersion: Number(env.FAKE_ACP_PROTOCOL) } : {}),
  ignoreCancel: env.FAKE_ACP_IGNORE_CANCEL === '1',
  authRequired: env.FAKE_ACP_AUTH === 'required',
  ...(env.FAKE_ACP_MODES ? { modes: env.FAKE_ACP_MODES.split(',') } : {}),
  note: (entry) => {
    if (record) appendFileSync(record, `${JSON.stringify(entry)}\n`);
  },
  crash: () => process.exit(1),
  writeRaw: (messages) => void writeSync(1, `${messages.map((m) => JSON.stringify(m)).join('\n')}\n`),
});

const input = (Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>).pipeThrough(recorder());
const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout), input));
void connection.closed.then(() => process.exit(0));
