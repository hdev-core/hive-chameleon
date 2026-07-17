import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { RealtimeConfig } from './realtime.config';
import { RealtimeService } from './realtime.service';
import type { NakamaAuthClient } from './realtime.types';

const principal = {
  authSessionId: '01980abc-def1-7abc-9def-0123456789ab',
  playerId: '01980abc-def0-7abc-8def-0123456789ab',
};

describe('RealtimeService', () => {
  it('returns only the short-lived token contract', async () => {
    const expiresAt = Math.floor(Date.now() / 1_000) + 900;
    const authenticateCustom = vi.fn().mockResolvedValue({
      expires_at: expiresAt,
      refresh_token: 'must-not-leak',
      token: 'nakama-session-token',
    });
    const service = new RealtimeService(config(), { authenticateCustom });

    const result = await service.createSession(principal);

    expect(authenticateCustom).toHaveBeenCalledOnce();
    expect(authenticateCustom.mock.calls[0]?.[0]).toMatch(/^v1\./);
    expect(authenticateCustom.mock.calls[0]?.[1]).toBe(true);
    expect(result).toEqual({
      expiresAt: new Date(expiresAt * 1_000).toISOString(),
      nakamaToken: 'nakama-session-token',
      socketUrl: 'ws://127.0.0.1:7350/ws',
    });
    expect(result).not.toHaveProperty('refreshToken');
  });

  it('maps upstream failure to a stable unavailable response', async () => {
    const client: NakamaAuthClient = {
      authenticateCustom: vi.fn().mockRejectedValue(new Error('provider details')),
    };
    const service = new RealtimeService(config(), client);

    await expect(service.createSession(principal)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('fails closed when realtime configuration is absent', async () => {
    const service = new RealtimeService(
      { developmentPrincipal: null, nakama: null, nodeEnvironment: 'test' },
      null,
    );

    await expect(service.createSession(principal)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

function config(): RealtimeConfig {
  return {
    developmentPrincipal: null,
    nakama: {
      assertionTtlSeconds: 30,
      bridgeHmacKey: Buffer.from('0123456789abcdef0123456789abcdef'),
      httpUrl: 'http://127.0.0.1:7350/',
      requestTimeoutMs: 5_000,
      serverKey: 'local-public-key',
      socketUrl: 'ws://127.0.0.1:7350/ws',
    },
    nodeEnvironment: 'test',
  };
}
