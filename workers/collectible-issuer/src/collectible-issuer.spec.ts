import { describe, expect, it } from 'vitest';

import {
  HiveGateway,
  PolicyEnforcingSignerBoundary,
  StaticOfficialSignerPolicy,
  type OfficialServiceAuthorization,
} from '@hive-chameleon/hive-gateway';
import {
  FixtureDigestSignatureProvider,
  FixtureHiveChain,
  FixtureSignerIdempotencyLedger,
  MANAGED_SIGNING_FIXTURE,
} from '@hive-chameleon/hive-gateway/testing';

import { CollectibleIssuerService } from './collectible-issuer.js';
import type { CollectibleIssuerJournal } from './journal.js';
import type { CollectibleSigningRecord } from './model.js';

const authorization: OfficialServiceAuthorization = {
  mode: 'official_service',
  role: 'collectible_issuer',
  account: 'item-issuer',
  authority: 'posting',
  expectedPublicKey: MANAGED_SIGNING_FIXTURE.publicKey,
  signerKeyReference: 'fixture/collectible-issuer/posting',
  policyVersion: 'collectible-policy-1',
};

describe('CollectibleIssuerService', () => {
  it('issues and revokes with stable event IDs through the issuer-only custom_json path', async () => {
    const chain = new FixtureHiveChain(
      MANAGED_SIGNING_FIXTURE.publicKey,
      MANAGED_SIGNING_FIXTURE.digest,
    );
    const provider = new FixtureDigestSignatureProvider(MANAGED_SIGNING_FIXTURE.signature);
    const signer = new PolicyEnforcingSignerBoundary(
      chain,
      provider,
      new StaticOfficialSignerPolicy([authorization]),
      new FixtureSignerIdempotencyLedger(),
    );
    const journal = new FixtureJournal();
    const ids = ['01910000-0000-7000-8000-000000000020', '01910000-0000-7000-8000-000000000021'];
    let idIndex = 0;
    const service = new CollectibleIssuerService(new HiveGateway(chain), signer, journal, {
      authorization,
      nextUuidV7: () => ids[idIndex++] ?? 'missing',
      now: () => new Date('2026-07-23T12:00:00.000Z'),
    });
    const collectibleId = '01910000-0000-7000-8000-000000000001';
    const issuedEventId = '01910000-0000-7000-8000-000000000002';

    await expect(
      service.issue({
        eventId: issuedEventId,
        occurredAt: '2026-07-23T12:00:00.000Z',
        attemptNumber: 1,
        collectibleId,
        definitionId: 'founder.badge',
        kind: 'badge',
        owner: 'alice',
        reason: 'founder_reward',
        metadataUri: 'https://assets.example/collectibles/founder.json',
        metadataSha256: 'a'.repeat(64),
      }),
    ).resolves.toMatchObject({ eventId: issuedEventId, eventType: 'collectible_issued' });

    const revokedEventId = '01910000-0000-7000-8000-000000000003';
    await expect(
      service.revoke({
        eventId: revokedEventId,
        occurredAt: '2026-07-23T12:01:00.000Z',
        attemptNumber: 1,
        collectibleId,
        issuedEventId,
        reasonCode: 'operator_revocation',
      }),
    ).resolves.toMatchObject({ eventId: revokedEventId, eventType: 'collectible_revoked' });

    expect(journal.records.map((record) => record.operationKind)).toEqual([
      'collectible_issued',
      'collectible_revoked',
    ]);
    expect(journal.records.map((record) => record.idempotencyKey)).toEqual([
      `collectible:${issuedEventId}:attempt:1`,
      `collectible:${revokedEventId}:attempt:1`,
    ]);
    expect(provider.requests).toHaveLength(2);
    expect(chain.broadcasts).toHaveLength(2);
  });

  it('rejects a treasury authorization at construction', () => {
    const chain = new FixtureHiveChain(
      MANAGED_SIGNING_FIXTURE.publicKey,
      MANAGED_SIGNING_FIXTURE.digest,
    );
    expect(
      () =>
        new CollectibleIssuerService(
          new HiveGateway(chain),
          { sign: async () => ({ signature: '', publicKey: '' }) },
          new FixtureJournal(),
          {
            authorization: { ...authorization, role: 'treasury' },
            nextUuidV7: () => '01910000-0000-7000-8000-000000000020',
          },
        ),
    ).toThrow(/dedicated posting authorization/);
  });
});

class FixtureJournal implements CollectibleIssuerJournal {
  public readonly records: CollectibleSigningRecord[] = [];

  public async recordPrepared(record: CollectibleSigningRecord): Promise<void> {
    this.records.push(record);
  }

  public async markBroadcast(): Promise<void> {}

  public async markFailed(): Promise<void> {}
}
