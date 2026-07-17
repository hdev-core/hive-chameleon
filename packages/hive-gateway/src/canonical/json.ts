import canonicalize from 'canonicalize';

import { HiveGatewayError } from '../errors.js';

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export function canonicalJson(value: JsonValue): string {
  const result = canonicalize(value);

  if (result === undefined) {
    throw new HiveGatewayError(
      'invalid_operation',
      'Value cannot be represented as canonical JSON',
    );
  }

  return result;
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new HiveGatewayError('invalid_event', 'Payload is not valid JSON', { cause: error });
  }
}
