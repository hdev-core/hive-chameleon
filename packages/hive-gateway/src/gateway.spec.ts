import { describe, expect, it } from 'vitest';

import { HiveGateway } from './gateway.js';
import type { IsolatedSignerResponse, SignerIdempotencyBinding } from './contracts.js';
import { StaticOfficialSignerPolicy } from './official-signer-policy.js';
import { PolicyEnforcingSignerBoundary } from './signer-boundary.js';
import {
  FixtureDigestSignatureProvider,
  FixtureHiveChain,
  FixtureSignerIdempotencyLedger,
} from './testing/fakes.js';
import {
  MANAGED_SIGNING_FIXTURE,
  COLLECTIBLE_AUTHORIZATION_FIXTURE,
  COLLECTIBLE_EVENT_FIXTURE,
  COLLECTIBLE_INTENT_FIXTURE,
} from './testing/fixtures.js';

describe('Hive Gateway and isolated signer boundary', () => {
  it('revalidates the full unsigned transaction before signing and broadcasting', async () => {
    const chain = new FixtureHiveChain(
      MANAGED_SIGNING_FIXTURE.publicKey,
      MANAGED_SIGNING_FIXTURE.digest,
    );
    const provider = new FixtureDigestSignatureProvider(MANAGED_SIGNING_FIXTURE.signature);
    const signer = createSigner(chain, provider);
    const gateway = new HiveGateway(chain);

    const prepared = await gateway.prepareOfficialEvent(
      COLLECTIBLE_INTENT_FIXTURE,
      COLLECTIBLE_AUTHORIZATION_FIXTURE,
    );
    const result = await gateway.broadcastOfficialEvent(prepared, signer);

    expect(result).toEqual({
      transactionId: prepared.transactionId,
      eventType: 'collectible_issued',
    });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).not.toHaveProperty('privateKey');
    expect(chain.broadcasts).toHaveLength(1);
  });

  it('rejects signer request tampering before the digest provider is called', async () => {
    const chain = new FixtureHiveChain(
      MANAGED_SIGNING_FIXTURE.publicKey,
      MANAGED_SIGNING_FIXTURE.digest,
    );
    const provider = new FixtureDigestSignatureProvider(MANAGED_SIGNING_FIXTURE.signature);
    const signer = createSigner(chain, provider);
    const gateway = new HiveGateway(chain);
    const prepared = await gateway.prepareOfficialEvent(
      COLLECTIBLE_INTENT_FIXTURE,
      COLLECTIBLE_AUTHORIZATION_FIXTURE,
    );

    await expect(
      signer.sign({
        ...preparedToRequest(prepared),
        canonicalOperationHash: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'transaction_mismatch' });
    expect(provider.requests).toHaveLength(0);
  });

  it('rejects a self-consistent event for a publisher absent from trusted signer policy', async () => {
    const chain = new FixtureHiveChain(
      MANAGED_SIGNING_FIXTURE.publicKey,
      MANAGED_SIGNING_FIXTURE.digest,
    );
    const provider = new FixtureDigestSignatureProvider(MANAGED_SIGNING_FIXTURE.signature);
    const signer = createSigner(chain, provider);
    const gateway = new HiveGateway(chain);
    const unapprovedAuthorization = {
      ...COLLECTIBLE_AUTHORIZATION_FIXTURE,
      account: 'other-issuer',
    };
    const prepared = await gateway.prepareOfficialEvent(
      {
        ...COLLECTIBLE_INTENT_FIXTURE,
        event: {
          ...COLLECTIBLE_EVENT_FIXTURE,
          data: { ...COLLECTIBLE_EVENT_FIXTURE.data, issuer: 'other-issuer' },
        },
      },
      unapprovedAuthorization,
    );

    await expect(signer.sign(preparedToRequest(prepared))).rejects.toMatchObject({
      code: 'policy_denied',
    });
    expect(provider.requests).toHaveLength(0);
  });

  it('replays an identical completed signing request without invoking the provider again', async () => {
    const chain = new FixtureHiveChain(
      MANAGED_SIGNING_FIXTURE.publicKey,
      MANAGED_SIGNING_FIXTURE.digest,
    );
    const provider = new FixtureDigestSignatureProvider(MANAGED_SIGNING_FIXTURE.signature);
    const signer = createSigner(chain, provider);
    const prepared = await new HiveGateway(chain).prepareOfficialEvent(
      COLLECTIBLE_INTENT_FIXTURE,
      COLLECTIBLE_AUTHORIZATION_FIXTURE,
    );
    const request = preparedToRequest(prepared);

    const first = await signer.sign(request);
    const retry = await signer.sign(request);

    expect(retry).toEqual(first);
    expect(provider.requests).toHaveLength(1);
  });

  it('rejects reuse of an idempotency key for a different canonical operation', async () => {
    const chain = new FixtureHiveChain(
      MANAGED_SIGNING_FIXTURE.publicKey,
      MANAGED_SIGNING_FIXTURE.digest,
    );
    const provider = new FixtureDigestSignatureProvider(MANAGED_SIGNING_FIXTURE.signature);
    const signer = createSigner(chain, provider);
    const gateway = new HiveGateway(chain);
    const first = await gateway.prepareOfficialEvent(
      COLLECTIBLE_INTENT_FIXTURE,
      COLLECTIBLE_AUTHORIZATION_FIXTURE,
    );
    await signer.sign(preparedToRequest(first));
    const conflicting = await gateway.prepareOfficialEvent(
      {
        ...COLLECTIBLE_INTENT_FIXTURE,
        event: {
          ...COLLECTIBLE_EVENT_FIXTURE,
          event_id: '0190f6d2-7c00-7000-8000-000000000009',
        },
      },
      COLLECTIBLE_AUTHORIZATION_FIXTURE,
    );

    await expect(signer.sign(preparedToRequest(conflicting))).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    expect(provider.requests).toHaveLength(1);
  });

  it('rejects reuse of an idempotency key for a different WAX digest', async () => {
    const ledger = new FixtureSignerIdempotencyLedger();
    const provider = new FixtureDigestSignatureProvider(MANAGED_SIGNING_FIXTURE.signature);
    const firstChain = new FixtureHiveChain(
      MANAGED_SIGNING_FIXTURE.publicKey,
      MANAGED_SIGNING_FIXTURE.digest,
    );
    const firstSigner = createSigner(firstChain, provider, ledger);
    const first = await new HiveGateway(firstChain).prepareOfficialEvent(
      COLLECTIBLE_INTENT_FIXTURE,
      COLLECTIBLE_AUTHORIZATION_FIXTURE,
    );
    await firstSigner.sign(preparedToRequest(first));

    const secondChain = new FixtureHiveChain(MANAGED_SIGNING_FIXTURE.publicKey, 'a'.repeat(64));
    const secondSigner = createSigner(secondChain, provider, ledger);
    const second = await new HiveGateway(secondChain).prepareOfficialEvent(
      COLLECTIBLE_INTENT_FIXTURE,
      COLLECTIBLE_AUTHORIZATION_FIXTURE,
    );

    await expect(secondSigner.sign(preparedToRequest(second))).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    expect(provider.requests).toHaveLength(1);
  });

  it('retains the reservation when durable completion fails after a valid signature', async () => {
    const chain = new FixtureHiveChain(
      MANAGED_SIGNING_FIXTURE.publicKey,
      MANAGED_SIGNING_FIXTURE.digest,
    );
    const provider = new FixtureDigestSignatureProvider(MANAGED_SIGNING_FIXTURE.signature);
    const ledger = new CompletionFailingLedger();
    const signer = createSigner(chain, provider, ledger);
    const prepared = await new HiveGateway(chain).prepareOfficialEvent(
      COLLECTIBLE_INTENT_FIXTURE,
      COLLECTIBLE_AUTHORIZATION_FIXTURE,
    );
    const request = preparedToRequest(prepared);

    await expect(signer.sign(request)).rejects.toMatchObject({
      code: 'idempotency_unavailable',
    });
    await expect(signer.sign(request)).rejects.toMatchObject({
      code: 'idempotency_unavailable',
    });

    expect(provider.requests).toHaveLength(1);
    expect(ledger.abortCalls).toBe(0);
    expect(ledger.completeCalls).toBe(1);
  });
});

function createSigner(
  chain: FixtureHiveChain,
  provider: FixtureDigestSignatureProvider,
  idempotency: FixtureSignerIdempotencyLedger = new FixtureSignerIdempotencyLedger(),
): PolicyEnforcingSignerBoundary {
  return new PolicyEnforcingSignerBoundary(
    chain,
    provider,
    new StaticOfficialSignerPolicy([COLLECTIBLE_AUTHORIZATION_FIXTURE]),
    idempotency,
  );
}

function preparedToRequest(
  prepared: Awaited<ReturnType<HiveGateway['prepareOfficialEvent']>>,
): Parameters<PolicyEnforcingSignerBoundary['sign']>[0] {
  return {
    idempotencyKey: prepared.idempotencyKey,
    policyVersion: prepared.policyVersion,
    role: prepared.authorization.role,
    account: prepared.authorization.account,
    authority: prepared.authorization.authority,
    expectedPublicKey: prepared.authorization.expectedPublicKey,
    signerKeyReference: prepared.authorization.signerKeyReference,
    eventFamily: prepared.eventFamily,
    eventType: prepared.eventType,
    canonicalPayload: prepared.canonicalPayload,
    canonicalOperationJson: prepared.canonicalOperationJson,
    canonicalOperationHash: prepared.canonicalOperationHash,
    unsignedTransactionJson: prepared.unsignedTransactionJson,
    signatureDigest: prepared.signatureDigest,
    transactionId: prepared.transactionId,
  };
}

class CompletionFailingLedger extends FixtureSignerIdempotencyLedger {
  public abortCalls = 0;
  public completeCalls = 0;

  public override async complete(
    binding: SignerIdempotencyBinding,
    leaseId: string,
    response: IsolatedSignerResponse,
  ): Promise<void> {
    void binding;
    void leaseId;
    void response;
    this.completeCalls += 1;
    throw new Error('fixture completion failure');
  }

  public override async abort(binding: SignerIdempotencyBinding, leaseId: string): Promise<void> {
    this.abortCalls += 1;
    await super.abort(binding, leaseId);
  }
}
