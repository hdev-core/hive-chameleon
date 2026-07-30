import { createHmac, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';

import { AUTH_CONFIG, type OnboardingPrincipal } from './auth.types';
import type { AuthConfig } from './auth.config';

const tokenHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const tokenClaimsSchema = z.strictObject({
  aud: z.string(),
  exp: z.number().int(),
  iat: z.number().int(),
  iss: z.string(),
  sid: z.string().uuid().optional(),
  sub: z.string().uuid(),
  typ: z.enum(['access', 'onboarding']),
});

export interface AccessTokenClaims {
  readonly playerId: string;
  readonly sessionId: string;
}

@Injectable()
export class TokenService {
  public constructor(@Inject(AUTH_CONFIG) private readonly config: AuthConfig) {}

  public issueAccessToken(
    playerId: string,
    sessionId: string,
    now: Date,
  ): {
    readonly expiresAt: Date;
    readonly token: string;
  } {
    const expiresAt = new Date(now.getTime() + this.config.accessTokenTtlSeconds * 1_000);
    return {
      expiresAt,
      token: this.sign({
        sid: sessionId,
        sub: playerId,
        typ: 'access',
        now,
        expiresAt,
      }),
    };
  }

  public issueOnboardingToken(
    externalIdentityId: string,
    now: Date,
  ): {
    readonly expiresAt: Date;
    readonly token: string;
  } {
    const expiresAt = new Date(now.getTime() + this.config.accessTokenTtlSeconds * 1_000);
    return {
      expiresAt,
      token: this.sign({ sub: externalIdentityId, typ: 'onboarding', now, expiresAt }),
    };
  }

  public verifyAccessToken(token: string, now: Date): AccessTokenClaims {
    const claims = this.verify(token, now);
    if (claims.typ !== 'access' || claims.sid === undefined) {
      throw invalidToken();
    }
    return { playerId: claims.sub, sessionId: claims.sid };
  }

  public verifyOnboardingToken(token: string, now: Date): OnboardingPrincipal {
    const claims = this.verify(token, now);
    if (claims.typ !== 'onboarding' || claims.sid !== undefined) {
      throw invalidToken();
    }
    return { externalIdentityId: claims.sub };
  }

  private sign(input: {
    readonly expiresAt: Date;
    readonly now: Date;
    readonly sid?: string;
    readonly sub: string;
    readonly typ: 'access' | 'onboarding';
  }): string {
    const payload = Buffer.from(
      JSON.stringify({
        aud: this.config.audience,
        exp: Math.floor(input.expiresAt.getTime() / 1_000),
        iat: Math.floor(input.now.getTime() / 1_000),
        iss: this.config.issuer,
        ...(input.sid === undefined ? {} : { sid: input.sid }),
        sub: input.sub,
        typ: input.typ,
      }),
    ).toString('base64url');
    const signingInput = `${tokenHeader}.${payload}`;
    const signature = createHmac('sha256', this.config.tokenKey)
      .update(signingInput)
      .digest('base64url');
    return `${signingInput}.${signature}`;
  }

  private verify(token: string, now: Date): z.infer<typeof tokenClaimsSchema> {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== tokenHeader || !parts[1] || !parts[2]) {
      throw invalidToken();
    }
    const signingInput = `${parts[0]}.${parts[1]}`;
    const supplied = Buffer.from(parts[2], 'base64url');
    const expected = createHmac('sha256', this.config.tokenKey).update(signingInput).digest();
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw invalidToken();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
    } catch {
      throw invalidToken();
    }
    const claims = tokenClaimsSchema.safeParse(parsed);
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    if (
      !claims.success ||
      claims.data.iss !== this.config.issuer ||
      claims.data.aud !== this.config.audience ||
      claims.data.iat > nowSeconds + 30 ||
      claims.data.exp <= nowSeconds
    ) {
      throw invalidToken();
    }
    return claims.data;
  }
}

function invalidToken(): UnauthorizedException {
  return new UnauthorizedException({
    code: 'invalid_session',
    detail: 'The session credential is missing, invalid, expired, or revoked.',
    status: 401,
    title: 'Unauthorized',
  });
}
