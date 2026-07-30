import {
  HiveGatewayError,
  type HiveGateway,
  type IsolatedSignerClient,
  type OfficialServiceAuthorization,
} from '@hive-chameleon/hive-gateway';
import type { CollectibleEvent } from '@hive-chameleon/hive-gateway/protocol';

import type { CollectibleIssuerJournal } from './journal.js';
import type {
  CollectibleBroadcastResult,
  CollectibleSigningRecord,
  IssueCollectibleCommand,
  RevokeCollectibleCommand,
} from './model.js';

export interface CollectibleIssuerOptions {
  readonly authorization: OfficialServiceAuthorization;
  readonly transactionExpirationSeconds?: number;
  readonly nextUuidV7: () => string;
  readonly now?: () => Date;
}

export class CollectibleIssuerService {
  private readonly now: () => Date;
  private readonly expirationSeconds: number;

  public constructor(
    private readonly gateway: HiveGateway,
    private readonly signer: IsolatedSignerClient,
    private readonly journal: CollectibleIssuerJournal,
    private readonly options: CollectibleIssuerOptions,
  ) {
    if (
      options.authorization.role !== 'collectible_issuer' ||
      options.authorization.authority !== 'posting'
    ) {
      throw new HiveGatewayError(
        'invalid_authorization',
        'Collectible issuer requires its dedicated posting authorization',
      );
    }
    this.expirationSeconds = options.transactionExpirationSeconds ?? 300;
    if (
      !Number.isSafeInteger(this.expirationSeconds) ||
      this.expirationSeconds < 10 ||
      this.expirationSeconds > 3_600
    ) {
      throw new HiveGatewayError('invalid_authorization', 'Transaction expiration is invalid');
    }
    this.now = options.now ?? (() => new Date());
  }

  public async issue(command: IssueCollectibleCommand): Promise<CollectibleBroadcastResult> {
    const event: Extract<CollectibleEvent, { type: 'collectible_issued' }> = {
      v: 1,
      type: 'collectible_issued',
      event_id: command.eventId,
      occurred_at: command.occurredAt,
      data: {
        collectible_id: command.collectibleId,
        definition_id: command.definitionId,
        kind: command.kind,
        owner: command.owner,
        issuer: this.options.authorization.account,
        reason: command.reason,
        metadata_uri: command.metadataUri,
        metadata_sha256: command.metadataSha256,
        ...(command.paymentTransactionId === undefined
          ? {}
          : { payment_tx_id: command.paymentTransactionId }),
      },
    };
    return this.publish(event, command.attemptNumber);
  }

  public async revoke(command: RevokeCollectibleCommand): Promise<CollectibleBroadcastResult> {
    const event: Extract<CollectibleEvent, { type: 'collectible_revoked' }> = {
      v: 1,
      type: 'collectible_revoked',
      event_id: command.eventId,
      occurred_at: command.occurredAt,
      data: {
        collectible_id: command.collectibleId,
        issued_event_id: command.issuedEventId,
        reason_code: command.reasonCode,
      },
    };
    return this.publish(event, command.attemptNumber);
  }

  private async publish(
    event: CollectibleEvent,
    attemptNumber: number,
  ): Promise<CollectibleBroadcastResult> {
    if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1 || attemptNumber > 1_000_000) {
      throw new HiveGatewayError('invalid_event', 'Collectible attempt number is invalid');
    }
    const idempotencyKey = `collectible:${event.event_id}:attempt:${attemptNumber}`;
    const prepared = await this.gateway.prepareOfficialEvent(
      {
        idempotencyKey,
        policyVersion: this.options.authorization.policyVersion,
        event,
        expirationSeconds: this.expirationSeconds,
      },
      this.options.authorization,
    );
    const recordId = checkedUuid(this.options.nextUuidV7());
    const preparedAt = this.now();
    const record: CollectibleSigningRecord = {
      id: recordId,
      idempotencyKey,
      operationKind: event.type,
      canonicalOperationHash: prepared.canonicalOperationHash,
      policyVersion: prepared.policyVersion,
      transactionId: prepared.transactionId,
      validatedAt: preparedAt.toISOString(),
      expiresAt: new Date(preparedAt.valueOf() + this.expirationSeconds * 1_000).toISOString(),
    };
    await this.journal.recordPrepared(record);

    try {
      const broadcast = await this.gateway.broadcastOfficialEvent(prepared, this.signer);
      const broadcastAt = this.now().toISOString();
      await this.journal.markBroadcast(recordId, broadcast.transactionId, broadcastAt);
      return {
        eventId: event.event_id,
        transactionId: broadcast.transactionId,
        eventType: event.type,
      };
    } catch (error: unknown) {
      await this.journal.markFailed(
        recordId,
        prepared.transactionId,
        stableFailureCode(error),
        this.now().toISOString(),
      );
      throw error;
    }
  }
}

function checkedUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new HiveGatewayError('invalid_authorization', 'ID provider returned a non-UUIDv7');
  }
  return value;
}

function stableFailureCode(error: unknown): string {
  return error instanceof HiveGatewayError ? error.code : 'publication_failed';
}
