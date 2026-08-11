import {
  HiveGatewayError,
  type HiveGateway,
  type IsolatedSignerClient,
  type OfficialServiceAuthorization,
  type PreparedOfficialEvent,
} from '@hive-chameleon/hive-gateway';

import type { MatchBatchPolicy } from '../batch-builder.js';
import { MatchPublisherError } from '../errors.js';
import type { MatchOutboxAttempt, SigningAttemptRecord } from '../model.js';
import type { MatchPublicationStore } from '../store/publication-store.js';

export interface MatchPublisherWorkerOptions {
  readonly authorization: OfficialServiceAuthorization;
  readonly batchPolicy: MatchBatchPolicy;
  readonly transactionExpirationSeconds: number;
  readonly claimLeaseMs: number;
  readonly initialRetryBackoffMs: number;
  readonly maximumRetryBackoffMs: number;
  readonly pollIntervalMs: number;
  readonly nextUuidV7: () => string;
  readonly now?: () => Date;
}

export interface MatchPublisherCycleResult {
  readonly batchFrozen: boolean;
  readonly projectedRowsReconciled: number;
  readonly publication: 'broadcast' | 'failed' | 'idle';
  readonly eventId?: string;
}

export interface MatchPublisherLogger {
  info(fields: Readonly<Record<string, unknown>>): void;
  error(fields: Readonly<Record<string, unknown>>): void;
}

export class MatchPublisherWorker {
  private readonly now: () => Date;

  public constructor(
    private readonly store: MatchPublicationStore,
    private readonly gateway: HiveGateway,
    private readonly signer: IsolatedSignerClient,
    private readonly options: MatchPublisherWorkerOptions,
    private readonly logger: MatchPublisherLogger = createJsonConsoleLogger(),
  ) {
    if (
      options.authorization.role !== 'match_publisher' ||
      options.authorization.authority !== 'posting' ||
      options.authorization.account !== options.batchPolicy.publisherAccount
    ) {
      throw new MatchPublisherError(
        'configuration_invalid',
        'Worker authorization does not match its match batch policy',
      );
    }
    this.now = options.now ?? (() => new Date());
  }

  public async processOnce(): Promise<MatchPublisherCycleResult> {
    const cycleNow = this.now();
    const projectedRowsReconciled = await this.store.reconcileProjectedFinality(cycleNow);
    const frozen = await this.store.freezeNextBatch(cycleNow, this.options.batchPolicy);
    const leaseUntil = new Date(cycleNow.valueOf() + this.options.claimLeaseMs);
    const attempt = await this.store.claimNextOutbox(cycleNow, leaseUntil);
    if (attempt === null) {
      return {
        batchFrozen: frozen !== null,
        projectedRowsReconciled,
        publication: 'idle',
      };
    }

    const publication = await this.publishAttempt(attempt, cycleNow);
    return {
      batchFrozen: frozen !== null,
      projectedRowsReconciled,
      publication,
      eventId: attempt.eventId,
    };
  }

  public async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const result = await this.processOnce();
        if (
          result.batchFrozen ||
          result.projectedRowsReconciled > 0 ||
          result.publication !== 'idle'
        ) {
          this.logger.info({ event: 'match_publisher_cycle', ...result });
        }
      } catch (error: unknown) {
        this.logger.error({
          event: 'match_publisher_cycle_failed',
          errorCode: stableErrorCode(error),
        });
      }
      await abortableDelay(this.options.pollIntervalMs, signal);
    }
  }

  private async publishAttempt(
    attempt: MatchOutboxAttempt,
    attemptStartedAt: Date,
  ): Promise<'broadcast' | 'failed'> {
    const idempotencyKey = `match-batch:${attempt.batchId}:attempt:${attempt.attemptCount}`;
    const signingAttemptId = checkedUuid(this.options.nextUuidV7());
    let prepared: PreparedOfficialEvent | null = null;
    let journaled = false;

    try {
      prepared = await this.gateway.prepareOfficialEvent(
        {
          idempotencyKey,
          policyVersion: this.options.authorization.policyVersion,
          event: attempt.event,
          expirationSeconds: this.options.transactionExpirationSeconds,
        },
        this.options.authorization,
      );
      if (prepared.canonicalPayload !== attempt.canonicalPayload) {
        throw new MatchPublisherError(
          'invalid_candidate',
          'Gateway canonical payload differs from the frozen outbox bytes',
        );
      }

      const signingRecord: SigningAttemptRecord = {
        id: signingAttemptId,
        idempotencyKey,
        outboxId: attempt.outboxId,
        operationKind: 'match_results_batch',
        canonicalOperationHash: prepared.canonicalOperationHash,
        policyVersion: prepared.policyVersion,
        transactionId: prepared.transactionId,
        validatedAt: attemptStartedAt.toISOString(),
        expiresAt: new Date(
          attemptStartedAt.valueOf() + this.options.transactionExpirationSeconds * 1_000,
        ).toISOString(),
      };
      await this.store.recordSigningAttempt(signingRecord);
      journaled = true;
      const broadcast = await this.gateway.broadcastOfficialEvent(prepared, this.signer);
      await this.store.markBroadcast(
        attempt.outboxId,
        signingAttemptId,
        broadcast.transactionId,
        this.now(),
      );
      return 'broadcast';
    } catch (error: unknown) {
      const retryAt = new Date(
        this.now().valueOf() +
          retryBackoff(
            attempt.attemptCount,
            this.options.initialRetryBackoffMs,
            this.options.maximumRetryBackoffMs,
          ),
      );
      await this.store.markRetryableFailure(
        attempt.outboxId,
        journaled ? signingAttemptId : null,
        prepared?.transactionId ?? null,
        stableErrorCode(error),
        retryAt,
      );
      return 'failed';
    }
  }
}

export function createJsonConsoleLogger(): MatchPublisherLogger {
  return {
    info: (fields) => console.log(JSON.stringify({ level: 'info', ...fields })),
    error: (fields) => console.error(JSON.stringify({ level: 'error', ...fields })),
  };
}

function retryBackoff(attempt: number, initialMs: number, maximumMs: number): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 30));
  return Math.min(maximumMs, initialMs * 2 ** exponent);
}

function stableErrorCode(error: unknown): string {
  if (error instanceof HiveGatewayError || error instanceof MatchPublisherError) {
    return error.code;
  }
  return 'publication_failed';
}

function checkedUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new MatchPublisherError('configuration_invalid', 'ID provider returned a non-UUIDv7');
  }
  return value;
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
