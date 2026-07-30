import type { MatchBatchPolicy } from '../batch-builder.js';
import type { FrozenMatchBatch, MatchOutboxAttempt, SigningAttemptRecord } from '../model.js';

export interface MatchPublicationStore {
  freezeNextBatch(now: Date, policy: MatchBatchPolicy): Promise<FrozenMatchBatch | null>;
  claimNextOutbox(now: Date, leaseUntil: Date): Promise<MatchOutboxAttempt | null>;
  recordSigningAttempt(record: SigningAttemptRecord): Promise<void>;
  markBroadcast(
    outboxId: string,
    signingAttemptId: string,
    transactionId: string,
    broadcastAt: Date,
  ): Promise<void>;
  markRetryableFailure(
    outboxId: string,
    signingAttemptId: string | null,
    transactionId: string | null,
    failureCode: string,
    retryAt: Date,
  ): Promise<void>;
  reconcileProjectedFinality(now: Date): Promise<number>;
}
