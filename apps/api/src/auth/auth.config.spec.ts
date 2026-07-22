import { describe, expect, it } from 'vitest';

import { loadAuthConfig } from './auth.config';

const secret = Buffer.alloc(32, 7).toString('base64url');

describe('loadAuthConfig', () => {
  it('requires independent production token and identity lookup secrets', () => {
    expect(() => loadAuthConfig({ NODE_ENV: 'production' })).toThrow(/AUTH_TOKEN_SECRET/);
    expect(() => loadAuthConfig({ AUTH_TOKEN_SECRET: secret, NODE_ENV: 'production' })).toThrow(
      /AUTH_IDENTITY_LOOKUP_KEY/,
    );
  });

  it('accepts a complete Google OIDC configuration and exact redirect allowlist', () => {
    const config = loadAuthConfig({
      AUTH_IDENTITY_LOOKUP_KEY: secret,
      AUTH_TOKEN_SECRET: secret,
      GOOGLE_OIDC_CLIENT_ID: 'client-id',
      GOOGLE_OIDC_CLIENT_SECRET: 'client-secret',
      GOOGLE_OIDC_REDIRECT_URIS: 'https://play.example.com/oidc/callback',
      NODE_ENV: 'production',
    });

    expect(config.google?.redirectUris.has('https://play.example.com/oidc/callback')).toBe(true);
  });

  it('rejects partial Google configuration and non-TLS production redirects', () => {
    expect(() => loadAuthConfig({ GOOGLE_OIDC_CLIENT_ID: 'client-id' })).toThrow(
      /requires .* together/,
    );
    expect(() =>
      loadAuthConfig({
        AUTH_IDENTITY_LOOKUP_KEY: secret,
        AUTH_TOKEN_SECRET: secret,
        GOOGLE_OIDC_CLIENT_ID: 'client-id',
        GOOGLE_OIDC_CLIENT_SECRET: 'client-secret',
        GOOGLE_OIDC_REDIRECT_URIS: 'http://play.example.com/callback',
        NODE_ENV: 'production',
      }),
    ).toThrow(/HTTPS/);
  });
});
