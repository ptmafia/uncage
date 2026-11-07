import { ATTACHMENT_LIMITS } from '@uncage/protocol';
import { describe, expect, it } from 'vitest';
import { CLAUDE_FALLBACK_MODELS, claudeCapabilities, toModelOptions } from './capabilities.js';

describe('claudeCapabilities', () => {
  it('capabilities omit bypass unless allowBypass', () => {
    const off = claudeCapabilities({ models: CLAUDE_FALLBACK_MODELS, allowBypass: false });
    expect(off.permissionModes).toEqual(['default', 'acceptEdits', 'plan', 'auto']);
    const on = claudeCapabilities({ models: CLAUDE_FALLBACK_MODELS, allowBypass: true });
    expect(on.permissionModes).toEqual(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
  });

  it('reports efforts, attachments and the given models', () => {
    const models = [{ id: 'default', label: 'Default' }];
    expect(claudeCapabilities({ models, allowBypass: false })).toEqual({
      streaming: true,
      approval: { once: true, session: false, types: ['shell', 'file', 'network', 'mcp', 'other'] },
      nativeResume: true,
      diffEvents: false,
      mcp: true,
      skills: 'supported',
      siteTools: false,
      models,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      permissionModes: ['default', 'acceptEdits', 'plan', 'auto'],
      attachments: { images: true, files: true, maxBytes: ATTACHMENT_LIMITS.maxBytes, maxImageBytes: 5 * 1024 * 1024 },
    });
  });

  it('fallback models start with default', () => {
    expect(CLAUDE_FALLBACK_MODELS[0]).toEqual({ id: 'default', label: 'Default' });
  });
});

describe('toModelOptions', () => {
  it('maps ModelInfo rows and keeps the SDK order', () => {
    expect(
      toModelOptions([
        { value: 'default', displayName: 'Default (recommended)', description: 'Fable 5.1' },
        { value: 'opus', displayName: 'Opus 5.5', description: 'For complex work' },
      ]),
    ).toEqual([
      { id: 'default', label: 'Default (recommended)', description: 'Fable 5.1' },
      { id: 'opus', label: 'Opus 5.5', description: 'For complex work' },
    ]);
  });

  it('prepends default when the SDK list lacks it, and drops empty descriptions', () => {
    expect(toModelOptions([{ value: 'sonnet', displayName: 'Sonnet', description: '' }])).toEqual([
      { id: 'default', label: 'Default' },
      { id: 'sonnet', label: 'Sonnet' },
    ]);
  });
});
