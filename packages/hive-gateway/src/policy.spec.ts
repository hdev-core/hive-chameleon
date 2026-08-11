import { describe, expect, it } from 'vitest';

import type { HiveGatewayError } from './errors.js';
import { authorizeOfficialEvent } from './policy.js';
import { MATCH_AUTHORIZATION_FIXTURE, MATCH_INTENT_FIXTURE } from './testing/fixtures.js';

describe('official service operation policy', () => {
  it('allows the scoped publisher to construct one posting custom_json', () => {
    const result = authorizeOfficialEvent(MATCH_INTENT_FIXTURE, MATCH_AUTHORIZATION_FIXTURE);

    expect(result.operation.required_auths).toEqual([]);
    expect(result.operation.required_posting_auths).toEqual(['match-pub']);
    expect(result.operation.id).toBe('hive.chameleon');
  });

  it('denies cross-role signing', () => {
    expect(() =>
      authorizeOfficialEvent(MATCH_INTENT_FIXTURE, {
        ...MATCH_AUTHORIZATION_FIXTURE,
        role: 'collectible_issuer',
      }),
    ).toThrowError(expect.objectContaining<Partial<HiveGatewayError>>({ code: 'policy_denied' }));
  });

  it('denies a publisher/account mismatch', () => {
    expect(() =>
      authorizeOfficialEvent(MATCH_INTENT_FIXTURE, {
        ...MATCH_AUTHORIZATION_FIXTURE,
        account: 'other-pub',
      }),
    ).toThrowError(expect.objectContaining<Partial<HiveGatewayError>>({ code: 'policy_denied' }));
  });
});
