import { z } from 'zod';

import { canonicalJson, type JsonValue } from './canonical/json.js';
import type {
  HiveCustomJsonOperation,
  OfficialEventIntent,
  OfficialServiceAuthorization,
} from './contracts.js';
import { HiveGatewayError } from './errors.js';
import {
  eventFamily,
  HIVE_CHAMELEON_APPLICATION_ID,
  hiveAccountSchema,
  serializeHiveChameleonEvent,
  type HiveChameleonEvent,
} from './protocol/index.js';

const policyVersionSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/);
const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const keyReferenceSchema = z.string().min(1).max(256);
const publicKeySchema = z.string().min(16).max(128);

export function authorizeOfficialEvent(
  intent: OfficialEventIntent,
  authorization: OfficialServiceAuthorization,
): { readonly operation: HiveCustomJsonOperation; readonly canonicalPayload: string } {
  assertAuthorizationShape(intent, authorization);

  if (authorization.mode !== 'official_service' || authorization.authority !== 'posting') {
    throw new HiveGatewayError(
      'invalid_authorization',
      'Official application events require posting authority',
    );
  }

  const family = eventFamily(intent.event);
  const expectedRole = 'collectible_issuer';
  if (authorization.role !== expectedRole) {
    throw new HiveGatewayError(
      'policy_denied',
      `Service role ${authorization.role} cannot publish ${family} events`,
    );
  }

  assertPayloadAccount(intent.event, authorization.account);
  const canonicalPayload = serializeHiveChameleonEvent(intent.event);
  const operation: HiveCustomJsonOperation = {
    required_auths: [],
    required_posting_auths: [authorization.account],
    id: HIVE_CHAMELEON_APPLICATION_ID,
    json: canonicalPayload,
  };

  return { operation, canonicalPayload };
}

export function canonicalCustomJsonOperation(operation: HiveCustomJsonOperation): string {
  return canonicalJson({ type: 'custom_json_operation', value: operation } as unknown as JsonValue);
}

function assertAuthorizationShape(
  intent: OfficialEventIntent,
  authorization: OfficialServiceAuthorization,
): void {
  const result = z
    .strictObject({
      idempotencyKey: idempotencyKeySchema,
      intentPolicyVersion: policyVersionSchema,
      authorizationPolicyVersion: policyVersionSchema,
      account: hiveAccountSchema,
      expectedPublicKey: publicKeySchema,
      signerKeyReference: keyReferenceSchema,
    })
    .safeParse({
      idempotencyKey: intent.idempotencyKey,
      intentPolicyVersion: intent.policyVersion,
      authorizationPolicyVersion: authorization.policyVersion,
      account: authorization.account,
      expectedPublicKey: authorization.expectedPublicKey,
      signerKeyReference: authorization.signerKeyReference,
    });

  if (!result.success) {
    throw new HiveGatewayError('invalid_authorization', 'Authorization metadata is invalid', {
      cause: result.error,
    });
  }

  if (intent.policyVersion !== authorization.policyVersion) {
    throw new HiveGatewayError('policy_denied', 'Intent and signer policy versions differ');
  }
}

function assertPayloadAccount(event: HiveChameleonEvent, account: string): void {
  switch (event.type) {
    case 'collectible_issued':
      if (event.data.issuer !== account) {
        throw new HiveGatewayError(
          'policy_denied',
          'Collectible issuer does not match signing account',
        );
      }
      return;
    case 'collectible_revoked':
      return;
  }
}
