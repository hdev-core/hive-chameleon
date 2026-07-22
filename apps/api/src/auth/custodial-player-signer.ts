import {
  assertSignatureMatchesPublicKey,
  type DigestSignatureProvider,
  type HiveChainPort,
} from '@hive-chameleon/hive-gateway';

export type PlayerCustodyAuthority = 'owner' | 'active' | 'posting';

export interface CustodialSigningGrant {
  readonly authority: PlayerCustodyAuthority;
  readonly expectedPublicKey: string;
  readonly expiresAt: Date;
  readonly hiveUsername: string;
  readonly idempotencyKey: string;
  readonly intentId: string;
  readonly playerId: string;
  readonly signerKeyReference: string;
}

/**
 * Provider-neutral adapter for an approved, non-exportable player key service.
 * Product authorization constructs the grant; this boundary never accepts an
 * arbitrary key reference or authority directly from a client.
 */
export class CustodialPlayerSigner {
  public constructor(
    private readonly chain: HiveChainPort,
    private readonly provider: DigestSignatureProvider,
  ) {}

  public async signDigest(
    grant: CustodialSigningGrant,
    signatureDigest: string,
    now = new Date(),
  ): Promise<{ readonly publicKey: string; readonly signature: string }> {
    if (grant.expiresAt <= now) {
      throw new Error('Custodial signing grant expired.');
    }
    if (!/^[0-9a-f]{64}$/.test(signatureDigest)) {
      throw new Error('Custodial signing accepts exactly one lowercase 32-byte digest.');
    }
    if (!grant.signerKeyReference || grant.signerKeyReference.length > 1_024) {
      throw new Error('Custody key reference is invalid.');
    }

    const response = await this.provider.signDigest({
      expectedPublicKey: grant.expectedPublicKey,
      idempotencyKey: grant.idempotencyKey,
      signatureDigest,
      signerKeyReference: grant.signerKeyReference,
    });
    await assertSignatureMatchesPublicKey(
      this.chain,
      signatureDigest,
      response.signature,
      grant.expectedPublicKey,
    );
    return { publicKey: grant.expectedPublicKey, signature: response.signature };
  }
}
