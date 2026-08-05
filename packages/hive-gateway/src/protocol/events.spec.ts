import { describe, expect, it } from 'vitest';

import type { HiveGatewayError } from '../errors.js';
import { COLLECTIBLE_EVENT_FIXTURE } from '../testing/fixtures.js';
import { parseHiveChameleonEvent, serializeHiveChameleonEvent } from './events.js';

describe('Hive Chameleon event protocol', () => {
  it('serializes and parses a canonical, bounded collectible event', () => {
    const payload = serializeHiveChameleonEvent(COLLECTIBLE_EVENT_FIXTURE);

    expect(payload).not.toContain('\n');
    expect(parseHiveChameleonEvent(payload)).toEqual(COLLECTIBLE_EVENT_FIXTURE);
  });

  it('rejects a semantically equivalent non-canonical payload', () => {
    const payload = JSON.stringify(COLLECTIBLE_EVENT_FIXTURE, null, 2);

    expect(() => parseHiveChameleonEvent(payload)).toThrowError(
      expect.objectContaining<Partial<HiveGatewayError>>({ code: 'non_canonical_payload' }),
    );
  });

  it('rejects invalid collectible metadata', () => {
    const invalid = {
      ...COLLECTIBLE_EVENT_FIXTURE,
      data: { ...COLLECTIBLE_EVENT_FIXTURE.data, metadata_sha256: 'not-a-hash' },
    };

    expect(() => serializeHiveChameleonEvent(invalid)).toThrowError(
      expect.objectContaining<Partial<HiveGatewayError>>({ code: 'invalid_event' }),
    );
  });

  it('rejects an issuer outside the Hive account contract', () => {
    const invalid = {
      ...COLLECTIBLE_EVENT_FIXTURE,
      data: {
        ...COLLECTIBLE_EVENT_FIXTURE.data,
        issuer: 'INVALID ACCOUNT',
      },
    };

    expect(() => serializeHiveChameleonEvent(invalid)).toThrowError(
      expect.objectContaining<Partial<HiveGatewayError>>({ code: 'invalid_event' }),
    );
  });
});
