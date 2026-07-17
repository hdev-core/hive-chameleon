import {
  HiveGatewayError,
  parseHiveChameleonEvent,
  type HiveChameleonEvent,
} from '@hive-chameleon/hive-gateway';
import {
  HIVE_CHAMELEON_APPLICATION_ID,
  hiveAccountSchema,
} from '@hive-chameleon/hive-gateway/protocol';
import { z } from 'zod';

import type { HafBlock, HafOperation, OperationDecision } from '../model.js';

export interface HiveEventValidationPolicy {
  readonly matchPublishers: ReadonlySet<string>;
  readonly collectibleIssuers: ReadonlySet<string>;
  readonly maximumFutureClockSkewMs?: number;
}

const customJsonSchema = z.strictObject({
  required_auths: z.array(hiveAccountSchema),
  required_posting_auths: z.array(hiveAccountSchema),
  id: z.string(),
  json: z.string(),
});
const customJsonNamespaceSchema = z.object({ id: z.unknown() }).passthrough();

export class HiveOperationValidator {
  private readonly maximumFutureClockSkewMs: number;

  public constructor(private readonly policy: HiveEventValidationPolicy) {
    this.maximumFutureClockSkewMs = policy.maximumFutureClockSkewMs ?? 5 * 60 * 1_000;
  }

  public validate(operation: HafOperation, block: HafBlock): OperationDecision | null {
    if (operation.operationType !== 'custom_json_operation') {
      return null;
    }

    const namespace = customJsonNamespaceSchema.safeParse(operation.value);
    if (!namespace.success || namespace.data.id !== HIVE_CHAMELEON_APPLICATION_ID) {
      return null;
    }

    const parsedOperation = customJsonSchema.safeParse(operation.value);
    if (!parsedOperation.success) {
      return {
        evidence: buildMalformedEvidence(operation, block),
        validationState: 'rejected',
        rejectionReason: 'invalid_operation',
      };
    }

    const primaryAccount =
      parsedOperation.data.required_posting_auths[0] ??
      parsedOperation.data.required_auths[0] ??
      'unknown';
    const evidence = {
      sourceOperationId: operation.sourceOperationId,
      transactionId: operation.transactionId,
      operationIndex: operation.operationIndex,
      isVirtual: operation.isVirtual,
      blockNumber: operation.blockNumber,
      blockId: block.id,
      blockTimestamp: block.timestamp,
      operationType: operation.operationType,
      primaryAccount,
      requiredAuthority:
        parsedOperation.data.required_posting_auths.length > 0
          ? ('posting' as const)
          : parsedOperation.data.required_auths.length > 0
            ? ('active' as const)
            : null,
      applicationId: parsedOperation.data.id,
      payload: operation.value,
    };

    if (
      operation.isVirtual ||
      parsedOperation.data.required_auths.length !== 0 ||
      parsedOperation.data.required_posting_auths.length !== 1
    ) {
      return { evidence, validationState: 'rejected', rejectionReason: 'unexpected_authority' };
    }

    let event: HiveChameleonEvent;
    try {
      event = parseHiveChameleonEvent(parsedOperation.data.json);
    } catch (error: unknown) {
      const reason = error instanceof HiveGatewayError ? error.code : 'invalid_event';
      return { evidence, validationState: 'rejected', rejectionReason: reason };
    }

    const signer = parsedOperation.data.required_posting_auths[0];
    if (signer === undefined) {
      return { evidence, validationState: 'rejected', rejectionReason: 'unexpected_authority' };
    }
    if (!this.isSignerAllowed(event, signer)) {
      return { evidence, validationState: 'rejected', rejectionReason: 'signer_not_allowed' };
    }
    if (
      Date.parse(event.occurred_at) >
      Date.parse(block.timestamp) + this.maximumFutureClockSkewMs
    ) {
      return { evidence, validationState: 'rejected', rejectionReason: 'future_event_timestamp' };
    }

    return { evidence, validationState: 'accepted', event };
  }

  private isSignerAllowed(event: HiveChameleonEvent, signer: string): boolean {
    switch (event.type) {
      case 'match_results_batch':
      case 'match_result_corrected':
      case 'match_result_invalidated':
        return this.policy.matchPublishers.has(signer) && event.data.publisher === signer;
      case 'collectible_issued':
        return this.policy.collectibleIssuers.has(signer) && event.data.issuer === signer;
      case 'collectible_revoked':
        return this.policy.collectibleIssuers.has(signer);
    }
  }
}

function buildMalformedEvidence(
  operation: HafOperation,
  block: HafBlock,
): OperationDecision['evidence'] {
  return {
    sourceOperationId: operation.sourceOperationId,
    transactionId: operation.transactionId,
    operationIndex: operation.operationIndex,
    isVirtual: operation.isVirtual,
    blockNumber: operation.blockNumber,
    blockId: block.id,
    blockTimestamp: block.timestamp,
    operationType: operation.operationType,
    primaryAccount: 'unknown',
    requiredAuthority: null,
    applicationId: HIVE_CHAMELEON_APPLICATION_ID,
    payload: operation.value,
  };
}
