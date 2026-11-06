import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_LIMITS,
  ERROR_CATALOG,
  SessionSchema,
  StartRunBodySchema,
  UpdateSessionSettingsBodySchema,
  classifyAttachment,
} from './index.js';

const caps = {
  streaming: true,
  approval: { once: true, session: false, types: [] },
  nativeResume: true,
  diffEvents: false,
  mcp: false,
  skills: 'unknown',
  models: [],
  efforts: [],
  permissionModes: ['default'],
  attachments: { images: false, files: false, maxBytes: ATTACHMENT_LIMITS.maxBytes },
};
const session = {
  id: 's',
  runtimeId: 'r',
  workspace: '/w',
  title: 't',
  status: 'ready',
  readOnly: false,
  createdAt: 'now',
  capabilities: caps,
};

describe('classifyAttachment', () => {
  it('classifies by extension and mime', () => {
    expect(classifyAttachment('a.PNG', 'image/png')).toBe('image');
    expect(classifyAttachment('a.png', 'text/plain')).toBeNull();
    expect(classifyAttachment('a.ts', 'video/mp2t')).toBe('file');
    expect(classifyAttachment('a.exe', 'application/octet-stream')).toBeNull();
    expect(classifyAttachment('noext', 'text/plain')).toBeNull();
  });
});

describe('schemas', () => {
  it('SessionSchema requires settings', () => {
    expect(SessionSchema.safeParse(session).success).toBe(false);
    expect(
      SessionSchema.safeParse({ ...session, settings: { permissionMode: 'default' } }).success,
    ).toBe(true);
  });
  it('StartRunBodySchema caps attachmentIds at 10', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `a${i}`);
    expect(StartRunBodySchema.safeParse({ prompt: 'x', attachmentIds: ids(10) }).success).toBe(true);
    expect(StartRunBodySchema.safeParse({ prompt: 'x', attachmentIds: ids(11) }).success).toBe(false);
    expect(StartRunBodySchema.safeParse({ prompt: 'x' }).success).toBe(true);
  });
  it('UpdateSessionSettingsBodySchema needs a valid key', () => {
    expect(UpdateSessionSettingsBodySchema.safeParse({}).success).toBe(false);
    expect(UpdateSessionSettingsBodySchema.safeParse({ permissionMode: 'yolo' }).success).toBe(false);
    expect(UpdateSessionSettingsBodySchema.safeParse({ effort: 'max' }).success).toBe(true);
  });
  it('catalogs attachment errors', () => {
    expect(ERROR_CATALOG.attachment_too_large.status).toBe(413);
    expect(ERROR_CATALOG.attachment_type_unsupported.status).toBe(415);
    expect(ERROR_CATALOG.attachment_too_large.hint).toBeTruthy();
    expect(ERROR_CATALOG.attachment_type_unsupported.hint).toBeTruthy();
  });
});
