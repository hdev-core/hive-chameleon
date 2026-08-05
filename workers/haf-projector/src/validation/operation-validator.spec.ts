import { serializeHiveChameleonEvent } from '@hive-chameleon/hive-gateway';
import { COLLECTIBLE_EVENT_FIXTURE } from '@hive-chameleon/hive-gateway/testing';
import { describe, expect, it } from 'vitest';

import type { HafBlock, HafOperation } from '../model.js';
import { HiveOperationValidator } from './operation-validator.js';

const block: HafBlock = {
  number: 10,
  id: 'a'.repeat(40),
  previousId: 'b'.repeat(40),
  timestamp: '2026-07-11T12:06:00.000Z',
};

describe('Hive operation validator', () => {
  it('accepts a canonical event from the allow-listed role', () => {
    const validator = createValidator();

    expect(validator.validate(operation('item-issuer'), block)).toMatchObject({
      validationState: 'accepted',
      event: { type: 'collectible_issued' },
    });
  });

  it('retains raw rejection evidence for an unauthorized signer', () => {
    const validator = createValidator();

    expect(validator.validate(operation('other-pub'), block)).toMatchObject({
      validationState: 'rejected',
      rejectionReason: 'signer_not_allowed',
      evidence: { applicationId: 'hive.chameleon', primaryAccount: 'other-pub' },
    });
  });

  it('retains raw rejection evidence for a malformed operation in the application namespace', () => {
    const validator = createValidator();
    const malformed = {
      ...operation('item-issuer'),
      value: { id: 'hive.chameleon', required_posting_auths: 'item-issuer' },
    };

    expect(validator.validate(malformed, block)).toMatchObject({
      validationState: 'rejected',
      rejectionReason: 'invalid_operation',
      evidence: { applicationId: 'hive.chameleon', primaryAccount: 'unknown' },
    });
  });

  it('ignores unrelated application namespaces', () => {
    const validator = createValidator();
    const unrelated = operation('item-issuer', 'other.application');

    expect(validator.validate(unrelated, block)).toBeNull();
  });
});

function createValidator(): HiveOperationValidator {
  return new HiveOperationValidator({
    collectibleIssuers: new Set(['item-issuer']),
  });
}

function operation(signer: string, applicationId = 'hive.chameleon'): HafOperation {
  return {
    sourceOperationId: '1000',
    transactionId: 'a'.repeat(40),
    operationIndex: 0,
    isVirtual: false,
    blockNumber: 10,
    timestamp: block.timestamp,
    operationType: 'custom_json_operation',
    value: {
      required_auths: [],
      required_posting_auths: [signer],
      id: applicationId,
      json: serializeHiveChameleonEvent(COLLECTIBLE_EVENT_FIXTURE),
    },
  };
}
