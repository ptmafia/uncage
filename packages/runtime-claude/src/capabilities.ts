import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';
import { ATTACHMENT_LIMITS, type ModelOption, type PermissionMode, type RuntimeCapabilities } from '@uncage/protocol';

/**
 * Used until (or whenever) `supportedModels()` can't be read: the CLI default plus the model
 * aliases the SDK documents (`Options.model` / `AgentDefinition.model`).
 */
export const CLAUDE_FALLBACK_MODELS: ModelOption[] = [
  { id: 'default', label: 'Default' },
  { id: 'fable', label: 'Fable' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
];

export const CLAUDE_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const SAFE_PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto'];

export function claudeCapabilities(o: { models: ModelOption[]; allowBypass: boolean; modelsAuthoritative?: boolean }): RuntimeCapabilities {
  return {
    streaming: true,
    approval: { once: true, session: false, types: ['shell', 'file', 'network', 'mcp', 'other'] },
    nativeResume: true,
    diffEvents: false,
    mcp: true,
    skills: 'supported',
    // Site tools run as the in-process `site` MCP server (see site-tools.ts).
    siteTools: true,
    models: o.models,
    ...(o.modelsAuthoritative ? { modelsAuthoritative: true } : {}),
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    permissionModes: o.allowBypass ? [...SAFE_PERMISSION_MODES, 'bypassPermissions'] : [...SAFE_PERMISSION_MODES],
    // The Anthropic API rejects images over 5 MB.
    attachments: { images: true, files: true, maxBytes: ATTACHMENT_LIMITS.maxBytes, maxImageBytes: CLAUDE_MAX_IMAGE_BYTES },
  };
}

/** Maps `supportedModels()` rows; `default` (the CLI's own choice) is always offered, first. */
export function toModelOptions(infos: Array<Pick<ModelInfo, 'value' | 'displayName' | 'description'>>): ModelOption[] {
  const models = infos.map((m) => ({
    id: m.value,
    label: m.displayName || m.value,
    ...(m.description ? { description: m.description } : {}),
  }));
  return models.some((m) => m.id === 'default') ? models : [CLAUDE_FALLBACK_MODELS[0]!, ...models];
}
