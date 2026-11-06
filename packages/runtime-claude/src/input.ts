import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ResolvedAttachment } from '@uncage/protocol';

type ContentBlocks = Exclude<SDKUserMessage['message']['content'], string>;
type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** `image/png; x=y` → `image/png`. Core only resolves images whose mime matches their extension. */
const mediaType = (mime: string): ImageMediaType => mime.split(';')[0]!.trim().toLowerCase() as ImageMediaType;

/**
 * The SDK prompt for one run. Without attachments it is the plain prompt string; otherwise a single
 * streaming-input user message: the images inline (base64), then the prompt text, with any other
 * files listed by absolute path for Claude to read with its tools. Rejects when an attachment
 * can't be read.
 */
export async function buildPrompt(prompt: string, atts: ResolvedAttachment[]): Promise<string | AsyncIterable<SDKUserMessage>> {
  if (atts.length === 0) return prompt;
  const images = atts.filter((a) => a.kind === 'image');
  const files = atts.filter((a) => a.kind !== 'image');
  // Claude reads files itself later; fail now (before spawning) if one is already gone.
  await Promise.all(files.map((f) => access(f.absPath, constants.R_OK)));
  const content: ContentBlocks = await Promise.all(
    images.map(async (a) => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: mediaType(a.mime), data: (await readFile(a.absPath)).toString('base64') },
    })),
  );
  const listing = files.length
    ? `\n\nAttached files (read them with your tools):\n${files.map((f) => `- ${f.absPath}`).join('\n')}`
    : '';
  content.push({ type: 'text', text: prompt + listing });
  const message: SDKUserMessage = { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
  return (async function* () {
    yield message;
  })();
}
