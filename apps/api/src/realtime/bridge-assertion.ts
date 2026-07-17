import { createHmac, randomBytes } from 'node:crypto';

import { isCanonicalUuidV7, type NakamaBridgeConfig } from './realtime.config';

const assertionVersion = 'v1';
const nonceLength = 16;
const maximumAssertionLength = 128;

export interface BridgePrincipal {
  authSessionId: string;
  playerId: string;
}

export interface BridgeAssertionOptions {
  now?: Date;
  nonce?: Buffer;
}

export function createBridgeAssertion(
  principal: BridgePrincipal,
  config: NakamaBridgeConfig,
  options: BridgeAssertionOptions = {},
): string {
  if (!isCanonicalUuidV7(principal.playerId) || !isCanonicalUuidV7(principal.authSessionId)) {
    throw new Error('Realtime bridge identities must be canonical UUIDv7 values.');
  }

  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error('Realtime bridge clock returned an invalid date.');
  }
  const nonce = options.nonce ?? randomBytes(nonceLength);
  if (nonce.length !== nonceLength) {
    throw new Error(`Realtime bridge nonce must contain ${nonceLength} bytes.`);
  }

  const expiresAt = Math.floor(now.getTime() / 1_000) + config.assertionTtlSeconds;
  const payload = [
    assertionVersion,
    compactUuid(principal.playerId),
    compactUuid(principal.authSessionId),
    expiresAt.toString(36),
    nonce.toString('base64url'),
  ].join('.');
  const signature = createHmac('sha256', config.bridgeHmacKey)
    .update(payload, 'utf8')
    .digest('base64url');
  const assertion = `${payload}.${signature}`;

  if (assertion.length > maximumAssertionLength) {
    throw new Error('Realtime bridge assertion exceeds the Nakama custom-ID limit.');
  }
  return assertion;
}

function compactUuid(value: string): string {
  return Buffer.from(value.replaceAll('-', ''), 'hex').toString('base64url');
}
