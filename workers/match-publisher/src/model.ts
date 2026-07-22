import type { MatchEvent } from '@hive-chameleon/hive-gateway/protocol';

export type MatchBatchEvent = Extract<MatchEvent, { readonly type: 'match_results_batch' }>;
export type PublicMatchResult = MatchBatchEvent['data']['results'][number];

export interface MatchPublicationCandidate {
  readonly publicationRequestId: string;
  readonly resultRevisionId: string;
  readonly roundId: string;
  readonly completedAt: string;
  readonly requestedAt: string;
  readonly publicResult: PublicMatchResult;
}

export interface FrozenMatchBatch {
  readonly outboxId: string;
  readonly eventId: string;
  readonly batchId: string;
  readonly event: MatchBatchEvent;
  readonly canonicalPayload: string;
  readonly payloadSha256: string;
  readonly payloadByteCount: number;
  readonly publicationPeriodStart: string;
  readonly publicationPeriodEnd: string;
  readonly candidates: readonly MatchPublicationCandidate[];
}

export interface MatchOutboxAttempt {
  readonly outboxId: string;
  readonly eventId: string;
  readonly batchId: string;
  readonly attemptCount: number;
  readonly canonicalPayload: string;
  readonly payloadSha256: string;
  readonly event: MatchBatchEvent;
}

export interface SigningAttemptRecord {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly outboxId: string;
  readonly operationKind: 'match_results_batch';
  readonly canonicalOperationHash: string;
  readonly policyVersion: string;
  readonly transactionId: string;
  readonly validatedAt: string;
  readonly expiresAt: string;
}
