import type { HiveChameleonEvent } from '@hive-chameleon/hive-gateway/protocol';

export type ProjectionState = 'included' | 'irreversible' | 'reverted';
export type ValidationState = 'accepted' | 'rejected';

export interface HafBlock {
  readonly number: number;
  readonly id: string;
  readonly previousId: string;
  readonly timestamp: string;
}

export interface HafIrreversibleBlock {
  /** Zero is the unsynchronized sentinel; every positive height must carry its RPC block ID. */
  readonly number: number;
  readonly id: string | null;
}

export interface HafOperation {
  readonly sourceOperationId: string;
  readonly transactionId: string | null;
  readonly operationIndex: number;
  readonly isVirtual: boolean;
  readonly blockNumber: number;
  readonly timestamp: string;
  readonly operationType: string;
  readonly value: unknown;
}

export interface ProjectionCursor {
  readonly source: string;
  readonly lastProcessedBlock: number;
  readonly lastProcessedBlockId: string | null;
  readonly lastIrreversibleBlock: number;
}

export interface BlockCheckpoint extends HafBlock {
  readonly source: string;
  readonly state: ProjectionState;
  readonly includedAt: string;
  readonly irreversibleAt?: string;
  readonly revertedAt?: string;
}

export interface RawOperationEvidence {
  readonly sourceOperationId: string;
  readonly transactionId: string | null;
  readonly operationIndex: number;
  readonly isVirtual: boolean;
  readonly blockNumber: number;
  readonly blockId: string;
  readonly blockTimestamp: string;
  readonly operationType: string;
  readonly primaryAccount: string;
  readonly requiredAuthority: 'active' | 'owner' | 'posting' | null;
  readonly applicationId: string | null;
  readonly payload: unknown;
}

export interface OperationDecision {
  readonly evidence: RawOperationEvidence;
  readonly validationState: ValidationState;
  readonly rejectionReason?: string;
  readonly event?: HiveChameleonEvent;
}

export interface StoredOperationDecision extends OperationDecision {
  readonly source: string;
  readonly state: ProjectionState;
  readonly irreversibleAt?: string;
  readonly revertedAt?: string;
}
