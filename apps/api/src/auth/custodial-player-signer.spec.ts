import type { DigestSignatureProvider, HiveChainPort } from '@hive-chameleon/hive-gateway';
import { describe, expect, it, vi } from 'vitest';

import { CustodialPlayerSigner } from './custodial-player-signer';

const signingFixture = {
  digest: '23b62f08f440d24db93bbd61e1a902b9807ce6d4d3a63be80569575651699234',
  publicKey: 'STM7u41yX66A2r6JNBrgawxT51sPxRMTJAW1QaEwdxQfFePGvCDET',
  signature:
    '204486a65bbc34a4d7cacf14ca4fb255ba31a0620ffa9cbd1d1546c8ea839b9abe0f4949c525dbd7105f61d7176348a8a7df68dff90b49b7e58a5660906620f856',
} as const;
const grant = {
  authority: 'posting' as const,
  expectedPublicKey: signingFixture.publicKey,
  expiresAt: new Date('2026-07-23T00:05:00.000Z'),
  hiveUsername: 'alice',
  idempotencyKey: 'player-intent:1',
  intentId: '01980abc-def2-7abc-8def-0123456789ab',
  playerId: '01980abc-def0-7abc-8def-0123456789ab',
  signerKeyReference: 'provider/player/posting/opaque-reference',
};

describe('CustodialPlayerSigner', () => {
  it('passes only an opaque key reference and digest, then verifies the returned key', async () => {
    const signDigest = vi.fn().mockResolvedValue({ signature: signingFixture.signature });
    const provider: DigestSignatureProvider = { signDigest };
    const signer = new CustodialPlayerSigner(chain(signingFixture.publicKey), provider);

    await expect(
      signer.signDigest(grant, signingFixture.digest, new Date('2026-07-23T00:00:00Z')),
    ).resolves.toEqual({
      publicKey: signingFixture.publicKey,
      signature: signingFixture.signature,
    });
    expect(signDigest).toHaveBeenCalledWith({
      expectedPublicKey: signingFixture.publicKey,
      idempotencyKey: grant.idempotencyKey,
      signatureDigest: signingFixture.digest,
      signerKeyReference: grant.signerKeyReference,
    });
  });

  it('fails before provider invocation when the authorization grant expired', async () => {
    const signDigest = vi.fn().mockResolvedValue({ signature: signingFixture.signature });
    const signer = new CustodialPlayerSigner(chain(signingFixture.publicKey), { signDigest });

    await expect(
      signer.signDigest(grant, signingFixture.digest, new Date('2026-07-23T00:06:00Z')),
    ).rejects.toThrow(/expired/);
    expect(signDigest).not.toHaveBeenCalled();
  });
});

function chain(recoveredPublicKey: string): HiveChainPort {
  return {
    attachSignature: vi.fn(),
    broadcast: vi.fn(),
    inspectTransaction: vi.fn(),
    prepareCustomJson: vi.fn(),
    recoverPublicKey: vi.fn().mockResolvedValue(recoveredPublicKey),
  };
}
