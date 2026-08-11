import { describe, expect, it } from 'vitest';

import type { HiveGatewayError } from '../errors.js';
import { MATCH_EVENT_FIXTURE } from '../testing/fixtures.js';
import { parseHiveChameleonEvent, serializeHiveChameleonEvent } from './events.js';

describe('Hive Chameleon event protocol', () => {
  it('serializes and parses a canonical, bounded match event', () => {
    const payload = serializeHiveChameleonEvent(MATCH_EVENT_FIXTURE);

    expect(payload).not.toContain('\n');
    expect(parseHiveChameleonEvent(payload)).toEqual(MATCH_EVENT_FIXTURE);
  });

  it('rejects a semantically equivalent non-canonical payload', () => {
    const payload = JSON.stringify(MATCH_EVENT_FIXTURE, null, 2);

    expect(() => parseHiveChameleonEvent(payload)).toThrowError(
      expect.objectContaining<Partial<HiveGatewayError>>({ code: 'non_canonical_payload' }),
    );
  });

  it('rejects a count that does not match the results array', () => {
    const invalid = {
      ...MATCH_EVENT_FIXTURE,
      data: { ...MATCH_EVENT_FIXTURE.data, result_count: 2 },
    };

    expect(() => serializeHiveChameleonEvent(invalid)).toThrowError(
      expect.objectContaining<Partial<HiveGatewayError>>({ code: 'invalid_event' }),
    );
  });

  it('rejects a result outside its half-open publication period', () => {
    if (MATCH_EVENT_FIXTURE.type !== 'match_results_batch') {
      throw new Error('Expected the batch fixture');
    }
    const firstResult = MATCH_EVENT_FIXTURE.data.results[0];
    if (firstResult === undefined) {
      throw new Error('Expected a result fixture');
    }
    const invalid = {
      ...MATCH_EVENT_FIXTURE,
      data: {
        ...MATCH_EVENT_FIXTURE.data,
        results: [{ ...firstResult, completed_at: MATCH_EVENT_FIXTURE.data.period_end }],
      },
    };

    expect(() => serializeHiveChameleonEvent(invalid)).toThrowError(
      expect.objectContaining<Partial<HiveGatewayError>>({ code: 'invalid_event' }),
    );
  });

  it('rejects summary accounts that are absent from participants', () => {
    if (MATCH_EVENT_FIXTURE.type !== 'match_results_batch') {
      throw new Error('Expected the batch fixture');
    }
    const firstResult = MATCH_EVENT_FIXTURE.data.results[0];
    if (firstResult === undefined) {
      throw new Error('Expected a result fixture');
    }
    const invalid = {
      ...MATCH_EVENT_FIXTURE,
      data: {
        ...MATCH_EVENT_FIXTURE.data,
        results: [{ ...firstResult, winner_accounts: ['mallory'] }],
      },
    };

    expect(() => serializeHiveChameleonEvent(invalid)).toThrowError(
      expect.objectContaining<Partial<HiveGatewayError>>({ code: 'invalid_event' }),
    );
  });
});
