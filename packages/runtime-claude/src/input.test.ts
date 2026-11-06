import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ResolvedAttachment } from '@uncage/protocol';
import { describe, expect, it } from 'vitest';
import { buildPrompt } from './input.js';

const dir = mkdtempSync(join(tmpdir(), 'uncage-input-'));

function att(name: string, kind: 'image' | 'file', mime: string, bytes: Buffer): ResolvedAttachment {
  const absPath = join(dir, `att_${name}`);
  writeFileSync(absPath, bytes);
  return { id: `att_${name}`, sessionId: 's1', name, mime, size: bytes.length, kind, sha256: 'x', createdAt: '2026-11-07T00:00:00.000Z', absPath };
}

async function drain(p: AsyncIterable<SDKUserMessage>): Promise<SDKUserMessage[]> {
  const out: SDKUserMessage[] = [];
  for await (const m of p) out.push(m);
  return out;
}

describe('buildPrompt', () => {
  it('buildPrompt with no attachments returns string', async () => {
    expect(await buildPrompt('hello', [])).toBe('hello');
  });

  it('buildPrompt with png + md returns one user message: image block base64 equals file bytes, text includes md absPath', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const img = att('shot.png', 'image', 'image/png', png);
    const md = att('notes.md', 'file', 'text/markdown', Buffer.from('# notes'));
    const p = await buildPrompt('What does it say?', [md, img]);
    if (typeof p === 'string') throw new Error('expected streaming input');
    const msgs = await drain(p);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } },
          { type: 'text', text: `What does it say?\n\nAttached files (read them with your tools):\n- ${md.absPath}` },
        ],
      },
    });
  });

  it('images only: the text block is the bare prompt', async () => {
    const img = att('a.jpg', 'image', 'image/jpeg; charset=binary', Buffer.from([0xff, 0xd8, 0xff]));
    const p = await buildPrompt('look', [img]);
    if (typeof p === 'string') throw new Error('expected streaming input');
    const [m] = await drain(p);
    const content = m!.message.content as Array<{ type: string; text?: string; source?: { media_type: string } }>;
    expect(content[0]!.source!.media_type).toBe('image/jpeg');
    expect(content[1]).toEqual({ type: 'text', text: 'look' });
  });

  it('lists several files in order', async () => {
    const a = att('a.txt', 'file', 'text/plain', Buffer.from('a'));
    const b = att('b.pdf', 'file', 'application/pdf', Buffer.from('b'));
    const p = await buildPrompt('read', [a, b]);
    if (typeof p === 'string') throw new Error('expected streaming input');
    const [m] = await drain(p);
    expect(m!.message.content).toEqual([{ type: 'text', text: `read\n\nAttached files (read them with your tools):\n- ${a.absPath}\n- ${b.absPath}` }]);
  });
});
