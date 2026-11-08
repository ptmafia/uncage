import { describe, expect, it } from 'vitest';
import { RuntimeCapabilitiesSchema } from './domain.js';

describe('RuntimeCapabilitiesSchema', () => {
  it('skills capability accepts prompt', () => expect(RuntimeCapabilitiesSchema.shape.skills.parse('prompt')).toBe('prompt'));

  it('skills capability still rejects unknown values', () => {
    expect(RuntimeCapabilitiesSchema.shape.skills.safeParse('text').success).toBe(false);
  });
});
