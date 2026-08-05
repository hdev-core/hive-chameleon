import { describe, expect, it } from 'vitest';

import type { HiveGatewayError } from './errors.js';
import { authorizeOfficialEvent } from './policy.js';
import {
  COLLECTIBLE_AUTHORIZATION_FIXTURE,
  COLLECTIBLE_INTENT_FIXTURE,
} from './testing/fixtures.js';

describe('official service operation policy', () => {
  it('allows the scoped issuer to construct one posting custom_json', () => {
    const result = authorizeOfficialEvent(
      COLLECTIBLE_INTENT_FIXTURE,
      COLLECTIBLE_AUTHORIZATION_FIXTURE,
    );

    expect(result.operation.required_auths).toEqual([]);
    expect(result.operation.required_posting_auths).toEqual(['item-issuer']);
    expect(result.operation.id).toBe('hive.chameleon');
  });

  it('denies an unrelated service role', () => {
    expect(() =>
      authorizeOfficialEvent(COLLECTIBLE_INTENT_FIXTURE, {
        ...COLLECTIBLE_AUTHORIZATION_FIXTURE,
        role: 'treasury',
      }),
    ).toThrowError(expect.objectContaining<Partial<HiveGatewayError>>({ code: 'policy_denied' }));
  });

  it('denies an issuer/account mismatch', () => {
    expect(() =>
      authorizeOfficialEvent(COLLECTIBLE_INTENT_FIXTURE, {
        ...COLLECTIBLE_AUTHORIZATION_FIXTURE,
        account: 'other-issuer',
      }),
    ).toThrowError(expect.objectContaining<Partial<HiveGatewayError>>({ code: 'policy_denied' }));
  });
});
