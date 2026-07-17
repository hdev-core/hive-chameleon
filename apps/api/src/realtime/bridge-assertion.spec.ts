import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createBridgeAssertion } from './bridge-assertion';
import type { NakamaBridgeConfig } from './realtime.config';

const playerId = '01980abc-def0-7abc-8def-0123456789ab';
const authSessionId = '01980abc-def1-7abc-9def-0123456789ab';
const goBridgeGolden =
  'v1.AZgKvN7weryN7wEjRWeJqw.AZgKvN7xeryd7wEjRWeJqw.tro8wu.MTIzNDU2Nzg5MGFiY2RlZg.EBy3NlnPzwlY2tpUCfKdOQHjGyHfpsEorwC9gNbuRLo';

describe('createBridgeAssertion', () => {
  it('creates the compact contract verified by the Go hook', () => {
    const config = bridgeConfig();
    const assertion = createBridgeAssertion({ authSessionId, playerId }, config, {
      nonce: Buffer.from('1234567890abcdef'),
      now: new Date(1_800_000_000_000),
    });
    const parts = assertion.split('.');

    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('v1');
    expect(decodeCompactUuid(parts[1]!)).toBe(playerId);
    expect(decodeCompactUuid(parts[2]!)).toBe(authSessionId);
    expect(Number.parseInt(parts[3]!, 36)).toBe(1_800_000_030);
    expect(Buffer.from(parts[4]!, 'base64url').toString()).toBe('1234567890abcdef');

    const payload = parts.slice(0, 5).join('.');
    const expectedSignature = createHmac('sha256', config.bridgeHmacKey)
      .update(payload)
      .digest('base64url');
    expect(parts[5]).toBe(expectedSignature);
    expect(assertion).toBe(goBridgeGolden);
    expect(assertion.length).toBeLessThanOrEqual(128);
  });

  it('rejects identities that are not canonical UUIDv7', () => {
    expect(() =>
      createBridgeAssertion(
        { authSessionId, playerId: '550e8400-e29b-41d4-a716-446655440000' },
        bridgeConfig(),
      ),
    ).toThrow(/UUIDv7/);
  });
});

function bridgeConfig(): NakamaBridgeConfig {
  return {
    assertionTtlSeconds: 30,
    bridgeHmacKey: Buffer.from('0123456789abcdef0123456789abcdef'),
    httpUrl: 'http://127.0.0.1:7350/',
    requestTimeoutMs: 5_000,
    serverKey: 'local-public-key',
    socketUrl: 'ws://127.0.0.1:7350/ws',
  };
}

function decodeCompactUuid(value: string): string {
  const hex = Buffer.from(value, 'base64url').toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
