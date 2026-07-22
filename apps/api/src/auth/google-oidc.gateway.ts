import { OAuth2Client } from 'google-auth-library';
import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';

import type { GoogleOidcConfig } from './auth.config';
import type { GoogleIdentity, GoogleOidcGateway } from './auth.types';

@Injectable()
export class GoogleAuthLibraryOidcGateway implements GoogleOidcGateway {
  public constructor(private readonly config: GoogleOidcConfig | null) {}

  public async exchange(input: {
    readonly authorizationCode: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
  }): Promise<GoogleIdentity> {
    if (!this.config) {
      throw googleUnavailable('Google sign-in is not configured.');
    }
    const canonicalRedirect = new URL(input.redirectUri).toString();
    if (!this.config.redirectUris.has(canonicalRedirect)) {
      throw invalidGoogleIdentity();
    }

    const client = new OAuth2Client(this.config.clientId, this.config.clientSecret);
    let idToken: string | undefined;
    try {
      const response = await client.getToken({
        code: input.authorizationCode,
        codeVerifier: input.codeVerifier,
        redirect_uri: canonicalRedirect,
      });
      idToken = response.tokens.id_token ?? undefined;
    } catch {
      throw invalidGoogleIdentity();
    }
    if (!idToken) {
      throw invalidGoogleIdentity();
    }

    try {
      const ticket = await client.verifyIdToken({ audience: this.config.clientId, idToken });
      const payload = ticket.getPayload();
      if (
        !payload?.sub ||
        (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com')
      ) {
        throw invalidGoogleIdentity();
      }
      return { issuer: payload.iss, subject: payload.sub };
    } catch (error: unknown) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw invalidGoogleIdentity();
    }
  }
}

function invalidGoogleIdentity(): UnauthorizedException {
  return new UnauthorizedException({
    code: 'invalid_google_identity',
    detail: 'Google authorization could not be verified for this client and redirect URI.',
    status: 401,
    title: 'Unauthorized',
  });
}

function googleUnavailable(detail: string): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: 'google_oidc_unavailable',
    detail,
    status: 503,
    title: 'Google sign-in unavailable',
  });
}
