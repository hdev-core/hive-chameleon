import { describe, expect, it } from 'vitest';

import { assertUuidV7, createUuidV7, isUuidV7 } from './uuid-v7.js';

describe('UUIDv7 convention', () => {
  it('creates UUIDv7 values accepted by the shared validator', () => {
    const id = createUuidV7();

    expect(isUuidV7(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect(() => assertUuidV7(id)).not.toThrow();
  });

  it('rejects UUIDv4 and malformed values', () => {
    expect(isUuidV7('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
    expect(isUuidV7('not-a-uuid')).toBe(false);
    expect(() => assertUuidV7('not-a-uuid', 'roundId')).toThrow(
      'roundId must be an RFC 9562 UUIDv7',
    );
  });
});
