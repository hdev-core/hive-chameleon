import { createHash, createHmac, randomBytes } from 'node:crypto';

import { createUuidV7 } from '@hive-chameleon/database';
import { ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';

import type { AuthConfig } from './auth.config';
import {
  AUTH_CONFIG,
  AUTH_REPOSITORY,
  GOOGLE_OIDC_GATEWAY,
  HIVE_POSTING_AUTHORITY_VERIFIER,
  type AuthRepository,
  type ClientPlatform,
  type ExternalSigningProvider,
  type GoogleOidcGateway,
  type HivePostingAuthorityVerifier,
  type NewSession,
  type PlayerIdentity,
} from './auth.types';
import { TokenService } from './token.service';

export interface AuthTokensResponse {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  readonly kind: 'authenticated';
  readonly player: {
    readonly hiveUsername: string;
    readonly id: string;
  };
  readonly refreshToken: string;
  readonly sessionId: string;
}

export type GoogleExchangeResponse =
  | AuthTokensResponse
  | {
      readonly expiresAt: string;
      readonly externalIdentityId: string;
      readonly kind: 'onboarding';
      readonly nextStep: 'acknowledge_disclosure' | 'choose_username';
      readonly onboardingToken: string;
    };

@Injectable()
export class AuthService {
  public constructor(
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    @Inject(AUTH_REPOSITORY) private readonly repository: AuthRepository,
    @Inject(HIVE_POSTING_AUTHORITY_VERIFIER)
    private readonly hiveVerifier: HivePostingAuthorityVerifier,
    @Inject(GOOGLE_OIDC_GATEWAY) private readonly googleGateway: GoogleOidcGateway,
    @Inject(TokenService) private readonly tokens: TokenService,
  ) {}

  public async createHiveChallenge(
    hiveUsername: string,
    platform: ClientPlatform,
    now = new Date(),
  ): Promise<{
    readonly challenge: string;
    readonly expiresAt: string;
    readonly hiveUsername: string;
    readonly id: string;
  }> {
    const id = createUuidV7();
    const deviceSessionId = createUuidV7();
    const expiresAt = new Date(now.getTime() + this.config.challengeTtlSeconds * 1_000);
    const challenge = [
      'Hive Chameleon login',
      `audience:${this.config.audience}`,
      `account:${hiveUsername}`,
      `device_session:${deviceSessionId}`,
      `nonce:${randomBytes(32).toString('base64url')}`,
      `issued_at:${now.toISOString()}`,
      `expires_at:${expiresAt.toISOString()}`,
    ].join('\n');
    await this.repository.createHiveChallenge({
      challenge,
      challengeSha256: createHash('sha256').update(challenge, 'utf8').digest('hex'),
      deviceSessionId,
      expiresAt,
      hiveUsername,
      id,
      issuedAt: now,
      platform,
    });
    return { challenge, expiresAt: expiresAt.toISOString(), hiveUsername, id };
  }

  public async createHiveSession(
    input: {
      readonly challengeId: string;
      readonly hiveUsername: string;
      readonly signature: string;
      readonly signingProvider: ExternalSigningProvider;
    },
    now = new Date(),
  ): Promise<AuthTokensResponse> {
    const challenge = await this.repository.consumeHiveChallenge(
      input.challengeId,
      input.hiveUsername,
      now,
    );
    if (!challenge) {
      throw invalidHiveLogin();
    }
    const verified = await this.hiveVerifier.verify({
      challenge: challenge.challenge,
      hiveUsername: input.hiveUsername,
      signature: input.signature,
    });
    if (!verified) {
      throw invalidHiveLogin();
    }
    const player = await this.repository.findOrCreateDirectHivePlayer(input.hiveUsername);
    return this.createSession(
      player,
      challenge.platform,
      'direct_hive_challenge',
      input.signingProvider,
      null,
      false,
      now,
    );
  }

  public async exchangeGoogle(
    input: {
      readonly authorizationCode: string;
      readonly codeVerifier: string;
      readonly platform: ClientPlatform;
      readonly redirectUri: string;
    },
    now = new Date(),
  ): Promise<GoogleExchangeResponse> {
    const identity = await this.googleGateway.exchange(input);
    const subjectLookupHash = createHmac('sha256', this.config.identityLookupKey)
      .update(identity.issuer)
      .update('\0')
      .update(identity.subject)
      .digest('hex');
    const externalIdentity = await this.repository.upsertGoogleIdentity(
      identity.issuer,
      subjectLookupHash,
      now,
    );
    if (externalIdentity.status === 'disabled') {
      throw new ConflictException({
        code: 'identity_disabled',
        detail: 'This verified identity is disabled.',
        status: 409,
        title: 'Identity disabled',
      });
    }
    if (externalIdentity.player) {
      return this.createSession(
        externalIdentity.player,
        input.platform,
        'google_oidc',
        'custodial_service',
        externalIdentity.id,
        externalIdentity.player.hiveControlState === 'platform_custodial',
        now,
      );
    }
    const onboarding = this.tokens.issueOnboardingToken(externalIdentity.id, now);
    return {
      expiresAt: onboarding.expiresAt.toISOString(),
      externalIdentityId: externalIdentity.id,
      kind: 'onboarding',
      nextStep: externalIdentity.disclosureAcknowledged
        ? 'choose_username'
        : 'acknowledge_disclosure',
      onboardingToken: onboarding.token,
    };
  }

  public async refresh(refreshToken: string, now = new Date()): Promise<AuthTokensResponse> {
    const nextRefreshToken = createRefreshToken();
    const session = await this.repository.rotateSession(
      this.hashRefreshToken(refreshToken),
      this.hashRefreshToken(nextRefreshToken),
      now,
    );
    if (!session) {
      throw invalidSession();
    }
    const access = this.tokens.issueAccessToken(session.player.id, session.authSessionId, now);
    return responseTokens(
      session.player,
      session.authSessionId,
      nextRefreshToken,
      access.token,
      access.expiresAt,
    );
  }

  public async revokeSession(sessionId: string, now = new Date()): Promise<void> {
    await this.repository.revokeSession(sessionId, now, 'player_logout');
  }

  private async createSession(
    player: PlayerIdentity,
    platform: ClientPlatform,
    authenticationMethod: NewSession['authenticationMethod'],
    signingProvider: NewSession['hiveSigningProvider'],
    externalIdentityId: string | null,
    custodialSigningEligible: boolean,
    now: Date,
  ): Promise<AuthTokensResponse> {
    const sessionId = createUuidV7();
    const refreshToken = createRefreshToken();
    const expiresAt = new Date(now.getTime() + this.config.refreshTokenTtlSeconds * 1_000);
    await this.repository.createSession({
      authenticationMethod,
      custodialSigningEligible,
      expiresAt,
      externalIdentityId,
      hiveSigningProvider: signingProvider,
      id: sessionId,
      issuedAt: now,
      platform,
      player,
      refreshTokenHash: this.hashRefreshToken(refreshToken),
    });
    const access = this.tokens.issueAccessToken(player.id, sessionId, now);
    return responseTokens(player, sessionId, refreshToken, access.token, access.expiresAt);
  }

  private hashRefreshToken(token: string): string {
    return createHmac('sha256', this.config.tokenKey).update(token).digest('hex');
  }
}

function createRefreshToken(): string {
  return randomBytes(48).toString('base64url');
}

function responseTokens(
  player: PlayerIdentity,
  sessionId: string,
  refreshToken: string,
  accessToken: string,
  accessTokenExpiresAt: Date,
): AuthTokensResponse {
  return {
    accessToken,
    accessTokenExpiresAt: accessTokenExpiresAt.toISOString(),
    kind: 'authenticated',
    player: {
      hiveUsername: player.hiveUsername,
      id: player.id,
    },
    refreshToken,
    sessionId,
  };
}

function invalidHiveLogin(): UnauthorizedException {
  return new UnauthorizedException({
    code: 'invalid_hive_challenge',
    detail:
      'The challenge is invalid, expired, already used, or was not signed by current posting authority.',
    status: 401,
    title: 'Unauthorized',
  });
}

function invalidSession(): UnauthorizedException {
  return new UnauthorizedException({
    code: 'invalid_session',
    detail: 'The refresh credential is invalid, expired, rotated, or revoked.',
    status: 401,
    title: 'Unauthorized',
  });
}
