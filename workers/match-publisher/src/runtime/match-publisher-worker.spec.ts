import { describe, expect, it } from 'vitest';

import {
  HiveGateway,
  PolicyEnforcingSignerBoundary,
  StaticOfficialSignerPolicy,
} from '@hive-chameleon/hive-gateway';
import {
  FixtureDigestSignatureProvider,
  FixtureHiveChain,
  FixtureSignerIdempotencyLedger,
  MANAGED_SIGNING_FIXTURE,
  MATCH_AUTHORIZATION_FIXTURE,
  MATCH_EVENT_FIXTURE,
} from '@hive-chameleon/hive-gateway/testing';
import { serializeHiveChameleonEvent, sha256Hex } from '@hive-chameleon/hive-gateway';

import { MatchPublisherWorker } from './match-publisher-worker.js';
import type { FrozenMatchBatch, MatchOutboxAttempt, SigningAttemptRecord } from '../model.js';
import type { MatchPublicationStore } from '../store/publication-store.js';

describe('MatchPublisherWorker', () => {
  it('journals and broadcasts a frozen batch through the match-only isolated signer', async () => {
    if (MATCH_EVENT_FIXTURE.type !== 'match_results_batch') {
      throw new Error('fixture is not a match batch');
    }
    const payload = serializeHiveChameleonEvent(MATCH_EVENT_FIXTURE);
    const attempt: MatchOutboxAttempt = {
      outboxId: '01910000-0000-7000-8000-000000000001',
      eventId: MATCH_EVENT_FIXTURE.event_id,
      batchId: MATCH_EVENT_FIXTURE.data.batch_id,
      attemptCount: 1,
      canonicalPayload: payload,
      payloadSha256: sha256Hex(payload),
      event: MATCH_EVENT_FIXTURE,
    };
    const store = new FixturePublicationStore(attempt);
    const chain = new FixtureHiveChain(
      MANAGED_SIGNING_FIXTURE.publicKey,
      MANAGED_SIGNING_FIXTURE.digest,
    );
    const provider = new FixtureDigestSignatureProvider(MANAGED_SIGNING_FIXTURE.signature);
    const signer = new PolicyEnforcingSignerBoundary(
      chain,
      provider,
      new StaticOfficialSignerPolicy([MATCH_AUTHORIZATION_FIXTURE]),
      new FixtureSignerIdempotencyLedger(),
    );
    const fixedNow = new Date('2026-07-23T12:00:00.000Z');
    const worker = new MatchPublisherWorker(store, new HiveGateway(chain), signer, {
      authorization: MATCH_AUTHORIZATION_FIXTURE,
      batchPolicy: {
        publisherAccount: 'match-pub',
        maximumAgeMs: 300_000,
        maximumResults: 20,
        maximumPayloadBytes: 6 * 1024,
        nextUuidV7: () => '01910000-0000-7000-8000-000000000010',
      },
      transactionExpirationSeconds: 300,
      claimLeaseMs: 60_000,
      initialRetryBackoffMs: 1_000,
      maximumRetryBackoffMs: 30_000,
      pollIntervalMs: 1_000,
      nextUuidV7: () => '01910000-0000-7000-8000-000000000011',
      now: () => fixedNow,
    });

    await expect(worker.processOnce()).resolves.toMatchObject({
      publication: 'broadcast',
      eventId: MATCH_EVENT_FIXTURE.event_id,
    });
    expect(store.signingAttempts[0]).toMatchObject({
      idempotencyKey: `match-batch:${attempt.batchId}:attempt:1`,
      operationKind: 'match_results_batch',
    });
    expect(store.broadcasts).toHaveLength(1);
    expect(provider.requests).toHaveLength(1);
    expect(chain.broadcasts).toHaveLength(1);
  });
});

class FixturePublicationStore implements MatchPublicationStore {
  public readonly signingAttempts: SigningAttemptRecord[] = [];
  public readonly broadcasts: string[] = [];

  public constructor(private attempt: MatchOutboxAttempt | null) {}

  public async freezeNextBatch(): Promise<FrozenMatchBatch | null> {
    return null;
  }

  public async claimNextOutbox(): Promise<MatchOutboxAttempt | null> {
    const claimed = this.attempt;
    this.attempt = null;
    return claimed;
  }

  public async recordSigningAttempt(record: SigningAttemptRecord): Promise<void> {
    this.signingAttempts.push(record);
  }

  public async markBroadcast(
    _outboxId: string,
    _signingAttemptId: string,
    transactionId: string,
  ): Promise<void> {
    this.broadcasts.push(transactionId);
  }

  public async markRetryableFailure(): Promise<void> {
    throw new Error('unexpected publication failure');
  }

  public async reconcileProjectedFinality(): Promise<number> {
    return 0;
  }
}
