import { describe, expect, it } from 'vitest';

import { loadRealtimeConfig, matchesDevelopmentBearer } from './realtime.config';

const bridgeKey = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64url');

describe('loadRealtimeConfig', () => {
  it('keeps the scaffold startable when realtime is not configured', () => {
    expect(loadRealtimeConfig({ NODE_ENV: 'development' })).toEqual({
      developmentPrincipal: null,
      nakama: null,
      nodeEnvironment: 'development',
    });
  });

  it('loads a complete local bridge and fixed development principal', () => {
    const config = loadRealtimeConfig(developmentEnvironment());

    expect(config.nakama).toMatchObject({
      assertionTtlSeconds: 30,
      httpUrl: 'http://127.0.0.1:7350/',
      requestTimeoutMs: 5_000,
      socketUrl: 'ws://127.0.0.1:7350/ws',
    });
    expect(config.developmentPrincipal).toMatchObject({
      authSessionId: '01980abc-def1-7abc-9def-0123456789ab',
      playerId: '01980abc-def0-7abc-8def-0123456789ab',
    });
  });

  it('refuses the temporary principal in production', () => {
    expect(() =>
      loadRealtimeConfig({
        ...developmentEnvironment(),
        NAKAMA_HTTP_URL: 'https://nakama.internal.example',
        NAKAMA_SOCKET_URL: 'wss://game.example/ws',
        NODE_ENV: 'production',
      }),
    ).toThrow(/cannot be enabled in production/);
  });

  it('refuses partial or weak bridge configuration', () => {
    expect(() => loadRealtimeConfig({ NAKAMA_HTTP_URL: 'http://127.0.0.1:7350' })).toThrow(
      /configured together/,
    );
    expect(() =>
      loadRealtimeConfig({
        NAKAMA_BRIDGE_HMAC_KEY: Buffer.from('short').toString('base64url'),
        NAKAMA_HTTP_URL: 'http://127.0.0.1:7350',
        NAKAMA_SERVER_KEY: 'public-key',
        NAKAMA_SOCKET_URL: 'ws://127.0.0.1:7350/ws',
      }),
    ).toThrow(/at least 32 bytes/);
  });
});

describe('matchesDevelopmentBearer', () => {
  it('accepts only the exact configured bearer token', () => {
    expect(matchesDevelopmentBearer('Bearer abcdef', 'abcdef')).toBe(true);
    expect(matchesDevelopmentBearer('Bearer abcdeg', 'abcdef')).toBe(false);
    expect(matchesDevelopmentBearer(undefined, 'abcdef')).toBe(false);
  });
});

function developmentEnvironment(): NodeJS.ProcessEnv {
  return {
    NAKAMA_BRIDGE_HMAC_KEY: bridgeKey,
    NAKAMA_HTTP_URL: 'http://127.0.0.1:7350',
    NAKAMA_SERVER_KEY: 'local-public-key',
    NAKAMA_SOCKET_URL: 'ws://127.0.0.1:7350/ws',
    NODE_ENV: 'development',
    REALTIME_DEV_AUTH_SESSION_ID: '01980abc-def1-7abc-9def-0123456789ab',
    REALTIME_DEV_BEARER_TOKEN: '0123456789abcdef0123456789abcdef',
    REALTIME_DEV_DISCLOSURE_ACKNOWLEDGED: 'true',
    REALTIME_DEV_PLAYER_ID: '01980abc-def0-7abc-8def-0123456789ab',
    REALTIME_DEV_PRINCIPAL_ENABLED: 'true',
  };
}
