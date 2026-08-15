import { UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthConfig } from './auth.config';
import { AuthService } from './auth.service';
import type {
  AuthRepository,
  GoogleOidcGateway,
  HivePostingAuthorityVerifier,
  PlayerIdentity,
} from './auth.types';
import { TokenService } from './token.service';

const now = new Date('2026-07-23T00:00:00.000Z');
const player: PlayerIdentity = {
  hiveControlState: 'external_self_custodial',
  hiveUsername: 'alice',
  id: '01980abc-def0-7abc-8def-0123456789ab',
  isGuest: false,
};
const guestPlayer: PlayerIdentity = {
  hiveControlState: 'authority_claimed_recovery_pending',
  hiveUsername: 'guest-0123456789',
  id: '01980abc-def1-7abc-8def-0123456789ab',
  isGuest: true,
};

describe('AuthService', () => {
  let repository: AuthRepository;
  let hive: HivePostingAuthorityVerifier;
  let google: GoogleOidcGateway;

  beforeEach(() => {
    repository = {
      consumeHiveChallenge: vi.fn(),
      createHiveChallenge: vi.fn(),
      createGuestPlayer: vi.fn().mockResolvedValue(guestPlayer),
      createSession: vi.fn(),
      findActiveSession: vi.fn(),
      findOrCreateDirectHivePlayer: vi.fn().mockResolvedValue(player),
      revokeSession: vi.fn(),
      rotateSession: vi.fn(),
      upsertGoogleIdentity: vi.fn(),
    };
    hive = { usernameExists: vi.fn(), verify: vi.fn() };
    google = { exchange: vi.fn() };
  });

  it('creates a canonical, expiring, random direct-Hive challenge', async () => {
    const service = createService(repository, hive, google);
    const result = await service.createHiveChallenge('alice', 'webgl', now);

    expect(result.challenge).toContain('Hive Chameleon login\naudience:test-client\naccount:alice');
    expect(result.expiresAt).toBe('2026-07-23T00:05:00.000Z');
    expect(repository.createHiveChallenge).toHaveBeenCalledOnce();
  });

  it('issues an isolated guest session only when the environment enables it', async () => {
    const service = createService(repository, hive, google);
    const result = await service.createGuestSession(now);

    expect(result.player).toEqual({
      hiveUsername: 'guest-0123456789',
      id: guestPlayer.id,
    });
    expect(repository.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticationMethod: 'guest',
        custodialSigningEligible: false,
        externalIdentityId: null,
        hiveSigningProvider: null,
        platform: 'webgl',
      }),
    );
  });

  it('burns a challenge once and issues a revocable session only after posting verification', async () => {
    vi.mocked(repository.consumeHiveChallenge).mockResolvedValue({
      challenge: 'signed challenge',
      expiresAt: new Date('2026-07-23T00:05:00.000Z'),
      hiveUsername: 'alice',
      id: '01980abc-def2-7abc-8def-0123456789ab',
      platform: 'webgl',
    });
    vi.mocked(hive.verify).mockResolvedValue(true);
    const service = createService(repository, hive, google);

    const result = await service.createHiveSession(
      {
        challengeId: '01980abc-def2-7abc-8def-0123456789ab',
        hiveUsername: 'alice',
        signature: '20'.padEnd(130, '0'),
        signingProvider: 'keychain',
      },
      now,
    );

    expect(result.kind).toBe('authenticated');
    expect(result.player).toMatchObject({ hiveUsername: 'alice' });
    expect(repository.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticationMethod: 'direct_hive_challenge',
        hiveSigningProvider: 'keychain',
        refreshTokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
  });

  it('does not create a player or session after an invalid signature', async () => {
    vi.mocked(repository.consumeHiveChallenge).mockResolvedValue({
      challenge: 'signed challenge',
      expiresAt: new Date('2026-07-23T00:05:00.000Z'),
      hiveUsername: 'alice',
      id: '01980abc-def2-7abc-8def-0123456789ab',
      platform: 'webgl',
    });
    vi.mocked(hive.verify).mockResolvedValue(false);

    await expect(
      createService(repository, hive, google).createHiveSession(
        {
          challengeId: '01980abc-def2-7abc-8def-0123456789ab',
          hiveUsername: 'alice',
          signature: '20'.padEnd(130, '0'),
          signingProvider: 'keychain',
        },
        now,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(repository.findOrCreateDirectHivePlayer).not.toHaveBeenCalled();
    expect(repository.createSession).not.toHaveBeenCalled();
  });

  it('maps a first-time Google subject to a restricted onboarding token without email', async () => {
    vi.mocked(google.exchange).mockResolvedValue({
      issuer: 'https://accounts.google.com',
      subject: 'stable-subject',
    });
    vi.mocked(repository.upsertGoogleIdentity).mockResolvedValue({
      id: '01980abc-def3-7abc-8def-0123456789ab',
      player: null,
      status: 'provisioning',
    });

    const result = await createService(repository, hive, google).exchangeGoogle(
      {
        authorizationCode: 'code',
        codeVerifier: 'v'.repeat(43),
        platform: 'webgl',
        redirectUri: 'https://play.example.com/callback',
      },
      now,
    );

    expect(result).toMatchObject({
      externalIdentityId: '01980abc-def3-7abc-8def-0123456789ab',
      kind: 'onboarding',
      nextStep: 'choose_username',
    });
    expect(repository.upsertGoogleIdentity).toHaveBeenCalledWith(
      'https://accounts.google.com',
      expect.stringMatching(/^[0-9a-f]{64}$/),
      now,
    );
  });
});

function createService(
  repository: AuthRepository,
  hive: HivePostingAuthorityVerifier,
  google: GoogleOidcGateway,
): AuthService {
  const authConfig = config();
  return new AuthService(authConfig, repository, hive, google, new TokenService(authConfig));
}

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
    publicGuestSessionsEnabled: true,
    refreshTokenTtlSeconds: 3_600,
    tokenKey: Buffer.alloc(32, 1),
  };
}
