import { describe, expect, it } from 'vitest';
import { ERROR_CATALOG, ErrorCodeSchema } from './index.js';

describe('ERROR_CATALOG', () => {
  it('has a complete entry for every ErrorCode', () => {
    for (const code of ErrorCodeSchema.options) {
      const entry = ERROR_CATALOG[code];
      expect(entry, code).toBeDefined();
      expect(entry.message.length, code).toBeGreaterThan(0);
      expect(entry.hint.length, code).toBeGreaterThan(0);
    }
  });

  it('maps well-known statuses', () => {
    expect(ERROR_CATALOG.session_busy.status).toBe(409);
    expect(ERROR_CATALOG.approval_already_resolved.status).toBe(409);
    expect(ERROR_CATALOG.approval_expired.status).toBe(410);
    expect(ERROR_CATALOG.unauthorized.status).toBe(401);
    expect(ERROR_CATALOG.forbidden_origin.status).toBe(403);
  });
});
