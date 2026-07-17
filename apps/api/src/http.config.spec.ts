import { describe, expect, it } from 'vitest';

import { loadHttpConfig } from './http.config';

describe('loadHttpConfig', () => {
  it('defaults to port 3000 with same-origin browser access', () => {
    expect(loadHttpConfig({})).toEqual({ corsAllowedOrigins: [], port: 3000 });
  });

  it('accepts a deduplicated allowlist of canonical browser origins', () => {
    expect(
      loadHttpConfig({
        HTTP_CORS_ALLOWED_ORIGINS:
          'http://127.0.0.1:8000, https://play.example.com,http://127.0.0.1:8000',
        PORT: '4000',
      }),
    ).toEqual({
      corsAllowedOrigins: ['http://127.0.0.1:8000', 'https://play.example.com'],
      port: 4000,
    });
  });

  it.each([
    '*',
    'https://play.example.com/path',
    'https://user@play.example.com',
    'file:///tmp/client',
  ])('rejects unsafe or non-origin CORS value %s', (origin) => {
    expect(() => loadHttpConfig({ HTTP_CORS_ALLOWED_ORIGINS: origin })).toThrow(
      /HTTP_CORS_ALLOWED_ORIGINS/,
    );
  });

  it.each(['0', '65536', '3000junk'])('rejects invalid port %s', (port) => {
    expect(() => loadHttpConfig({ PORT: port })).toThrow(/PORT/);
  });

  it('requires HTTPS for explicitly allowed production browser origins', () => {
    expect(() =>
      loadHttpConfig({
        HTTP_CORS_ALLOWED_ORIGINS: 'http://play.example.com',
        NODE_ENV: 'production',
      }),
    ).toThrow(/HTTPS in production/);

    expect(
      loadHttpConfig({
        HTTP_CORS_ALLOWED_ORIGINS: 'https://play.example.com',
        NODE_ENV: 'production',
      }).corsAllowedOrigins,
    ).toEqual(['https://play.example.com']);
  });
});
