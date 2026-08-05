import { Buffer } from 'node:buffer';

import { canonicalJson, parseJson, type JsonValue } from '../canonical/json.js';
import { HiveGatewayError } from '../errors.js';
import { collectibleEventSchema, type CollectibleEvent } from './collectible.js';
import { HIVE_CHAMELEON_MAX_PAYLOAD_BYTES } from './common.js';

export const hiveChameleonEventSchema = collectibleEventSchema;

export type HiveChameleonEvent = CollectibleEvent;
export type HiveChameleonEventFamily = 'collectible';

export function eventFamily(event: HiveChameleonEvent): HiveChameleonEventFamily {
  switch (event.type) {
    case 'collectible_issued':
    case 'collectible_revoked':
      return 'collectible';
  }
}

export function serializeHiveChameleonEvent(value: unknown): string {
  const parsed = hiveChameleonEventSchema.safeParse(value);
  if (!parsed.success) {
    throw new HiveGatewayError('invalid_event', 'Hive Chameleon event schema validation failed', {
      cause: parsed.error,
    });
  }

  const payload = canonicalJson(parsed.data as JsonValue);
  assertPayloadSize(payload);
  return payload;
}

export function parseHiveChameleonEvent(payload: string): HiveChameleonEvent {
  assertPayloadSize(payload);
  const value = parseJson(payload);
  const parsed = hiveChameleonEventSchema.safeParse(value);

  if (!parsed.success) {
    throw new HiveGatewayError('invalid_event', 'Hive Chameleon event schema validation failed', {
      cause: parsed.error,
    });
  }

  const canonical = canonicalJson(parsed.data as JsonValue);
  if (canonical !== payload) {
    throw new HiveGatewayError(
      'non_canonical_payload',
      'Hive Chameleon payload must use its canonical JSON representation',
    );
  }

  return parsed.data;
}

function assertPayloadSize(payload: string): void {
  if (Buffer.byteLength(payload, 'utf8') > HIVE_CHAMELEON_MAX_PAYLOAD_BYTES) {
    throw new HiveGatewayError('payload_too_large', 'Hive Chameleon payload exceeds 6 KiB');
  }
}
