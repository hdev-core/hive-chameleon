import { validate, v7, version } from 'uuid';

export function createUuidV7(): string {
  return v7();
}

export function isUuidV7(value: string): boolean {
  return validate(value) && version(value) === 7;
}

export function assertUuidV7(value: string, fieldName = 'id'): asserts value is string {
  if (!isUuidV7(value)) {
    throw new TypeError(`${fieldName} must be an RFC 9562 UUIDv7`);
  }
}
