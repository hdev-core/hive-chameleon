import { createWaxFoundation } from '@hiveio/wax';
import { describe, expect, it } from 'vitest';

import type { HiveGatewayError } from './errors.js';
import { validateHiveCompactSignature } from './signature.js';
import { MANAGED_SIGNING_FIXTURE } from './testing/fixtures.js';

describe('Hive compact signature gate', () => {
  it('accepts the documented low-S, compact-canonical 65-byte fixture', () => {
    expect(validateHiveCompactSignature(MANAGED_SIGNING_FIXTURE.signature)).toMatchObject({
      recoveryId: 1,
    });
  });

  it('recovers the expected Hive key through WAX', async () => {
    const wax = await createWaxFoundation();

    expect(
      wax.getPublicKeyFromSignature(
        MANAGED_SIGNING_FIXTURE.digest,
        MANAGED_SIGNING_FIXTURE.signature,
      ),
    ).toBe(MANAGED_SIGNING_FIXTURE.publicKey);
  });

  it('rejects an ordinary 64-byte r/s value without a Graphene header', () => {
    expect(() => validateHiveCompactSignature('01'.repeat(64))).toThrowError(
      expect.objectContaining<Partial<HiveGatewayError>>({ code: 'invalid_signature' }),
    );
  });

  it('rejects a compact-canonical scalar above the secp256k1 low-S boundary', () => {
    const headerAndR = MANAGED_SIGNING_FIXTURE.signature.slice(0, 66);
    const highS = `7f${'ff'.repeat(31)}`;

    expect(() => validateHiveCompactSignature(`${headerAndR}${highS}`)).toThrowError(/low-S/);
  });
});
