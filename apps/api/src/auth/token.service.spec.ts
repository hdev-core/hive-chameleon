import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { AuthConfig } from './auth.config';
import { TokenService } from './token.service';

const now = new Date('2026-07-23T00:00:00.000Z');
const playerId = '01980abc-def0-7abc-8def-0123456789ab';
const sessionId = '01980abc-def1-7abc-9def-0123456789ab';

describe('TokenService', () => {
  it('issues scoped access tokens and rejects tampering', () => {
    const service = new TokenService(config());
    const issued = service.issueAccessToken(playerId, sessionId, now);

    expect(service.verifyAccessToken(issued.token, now)).toEqual({ playerId, sessionId });
    expect(() => service.verifyAccessToken(`${issued.token}x`, now)).toThrow(UnauthorizedException);
  });

  it('does not accept onboarding credentials as access credentials', () => {
    const service = new TokenService(config());
    const issued = service.issueOnboardingToken(playerId, now);

    expect(service.verifyOnboardingToken(issued.token, now)).toEqual({
      externalIdentityId: playerId,
    });
    expect(() => service.verifyAccessToken(issued.token, now)).toThrow(UnauthorizedException);
  });

  it('rejects expired tokens', () => {
    const service = new TokenService(config());
    const issued = service.issueAccessToken(playerId, sessionId, now);

    expect(() =>
      service.verifyAccessToken(issued.token, new Date('2026-07-23T00:15:01.000Z')),
    ).toThrow(UnauthorizedException);
  });
});

function config(): AuthConfig {
  return {
    accessTokenTtlSeconds: 900,
    audience: 'test-client',
    challengeTtlSeconds: 300,
    google: null,
    hiveChainId: '0'.repeat(64),
    hiveRpcUrl: 'https://api.hive.blog/',
    identityLookupKey: Buffer.alloc(32, 2),
    issuer: 'test-api',
    publicGuestSessionsEnabled: false,
    refreshTokenTtlSeconds: 3_600,
    tokenKey: Buffer.alloc(32, 1),
  };
}
