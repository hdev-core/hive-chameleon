import { describe, expect, it } from 'vitest';

import { loadRealtimeConfig } from './realtime.config';

const bridgeKey = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64url');

describe('loadRealtimeConfig', () => {
  it('keeps the scaffold startable when realtime is not configured', () => {
    expect(loadRealtimeConfig({ NODE_ENV: 'development' })).toEqual({
      nakama: null,
      nodeEnvironment: 'development',
    });
  });

  it('loads a complete local bridge', () => {
    const config = loadRealtimeConfig(developmentEnvironment());

    expect(config.nakama).toMatchObject({
      assertionTtlSeconds: 30,
      httpUrl: 'http://127.0.0.1:7350/',
      requestTimeoutMs: 5_000,
      socketUrl: 'ws://127.0.0.1:7350/ws',
    });
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

  it('allows only the explicitly opted-in Compose HTTP service in production', () => {
    const production = {
      ...developmentEnvironment(),
      NAKAMA_SOCKET_URL: 'wss://game.example.test/ws',
      NODE_ENV: 'production',
    };
    expect(() =>
      loadRealtimeConfig({ ...production, NAKAMA_HTTP_URL: 'http://nakama:7350' }),
    ).toThrow(/must use TLS/);
    expect(
      loadRealtimeConfig({
        ...production,
        NAKAMA_ALLOW_PRIVATE_NETWORK_HTTP: 'true',
        NAKAMA_HTTP_URL: 'http://nakama:7350',
      }).nakama?.httpUrl,
    ).toBe('http://nakama:7350/');
    expect(() =>
      loadRealtimeConfig({
        ...production,
        NAKAMA_ALLOW_PRIVATE_NETWORK_HTTP: 'true',
        NAKAMA_HTTP_URL: 'http://untrusted.example:7350',
      }),
    ).toThrow(/must use TLS/);
  });
});

function developmentEnvironment(): NodeJS.ProcessEnv {
  return {
    NAKAMA_BRIDGE_HMAC_KEY: bridgeKey,
    NAKAMA_HTTP_URL: 'http://127.0.0.1:7350',
    NAKAMA_SERVER_KEY: 'local-public-key',
    NAKAMA_SOCKET_URL: 'ws://127.0.0.1:7350/ws',
    NODE_ENV: 'development',
  };
}
