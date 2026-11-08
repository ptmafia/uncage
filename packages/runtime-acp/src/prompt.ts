import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { AdapterRunInput, ResolvedAttachment } from '@uncage/protocol';

const link = (a: ResolvedAttachment): ContentBlock => ({
  type: 'resource_link',
  uri: pathToFileURL(a.absPath).href,
  name: a.name,
  mimeType: a.mime,
  size: a.size,
});

/**
 * The `session/prompt` blocks for a run: the text, then images as base64 when the agent accepts
 * them (`promptCapabilities.image`), then every other attachment as a `file://` resource link
 * (every ACP agent must accept text and resource links).
 */
export async function toPromptBlocks(input: AdapterRunInput, caps: { image: boolean }): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [{ type: 'text', text: input.prompt }];
  const images = caps.image ? input.attachments.filter((a) => a.kind === 'image') : [];
  for (const a of images) {
    blocks.push({ type: 'image', data: (await readFile(a.absPath)).toString('base64'), mimeType: a.mime });
  }
  for (const a of input.attachments) if (!images.includes(a)) blocks.push(link(a));
  return blocks;
}
