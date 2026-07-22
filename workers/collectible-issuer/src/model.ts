import type { CollectibleEvent } from '@hive-chameleon/hive-gateway/protocol';

export type CollectibleKind = Extract<
  CollectibleEvent,
  { readonly type: 'collectible_issued' }
>['data']['kind'];

export interface IssueCollectibleCommand {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly attemptNumber: number;
  readonly collectibleId: string;
  readonly definitionId: string;
  readonly kind: CollectibleKind;
  readonly owner: string;
  readonly reason: string;
  readonly metadataUri: string;
  readonly metadataSha256: string;
  readonly paymentTransactionId?: string;
}

export interface RevokeCollectibleCommand {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly attemptNumber: number;
  readonly collectibleId: string;
  readonly issuedEventId: string;
  readonly reasonCode: string;
}

export interface CollectibleSigningRecord {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly operationKind: CollectibleEvent['type'];
  readonly canonicalOperationHash: string;
  readonly policyVersion: string;
  readonly transactionId: string;
  readonly validatedAt: string;
  readonly expiresAt: string;
}

export interface CollectibleBroadcastResult {
  readonly eventId: string;
  readonly transactionId: string;
  readonly eventType: CollectibleEvent['type'];
}
