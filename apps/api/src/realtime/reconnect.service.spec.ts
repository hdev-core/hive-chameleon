import { describe, expect, it, vi } from 'vitest';

import { ReconnectService } from './reconnect.service';
import type { ReconnectRepository } from './reconnect.types';

const playerId = '01980abc-def0-7abc-8def-0123456789ab';
const lobbyId = '01980abc-def2-7abc-8def-0123456789ab';
const checkedAt = new Date('2026-08-01T12:00:00.000Z');

describe('ReconnectService', () => {
  it('returns only the current player reconnect descriptor', async () => {
    const expiresAt = new Date('2026-08-01T12:00:45.000Z');
    const repository: ReconnectRepository = {
      findAvailable: vi.fn().mockResolvedValue({
        expiresAt,
        lobbyId,
        restorationMode: 'same_role',
      }),
    };

    const result = await new ReconnectService(repository).getDescriptor(playerId, checkedAt);

    expect(repository.findAvailable).toHaveBeenCalledWith(playerId, checkedAt);
    expect(result).toEqual({
      available: true,
      expiresAt: expiresAt.toISOString(),
      lobbyId,
      restorationMode: 'same_role',
    });
    expect(result).not.toHaveProperty('roundId');
  });

  it('does not expose another player or expired reservation', async () => {
    const unavailable: ReconnectRepository = {
      findAvailable: vi.fn().mockResolvedValue(null),
    };
    await expect(
      new ReconnectService(unavailable).getDescriptor(playerId, checkedAt),
    ).resolves.toEqual({ available: false });

    const expired: ReconnectRepository = {
      findAvailable: vi.fn().mockResolvedValue({
        expiresAt: checkedAt,
        lobbyId,
        restorationMode: 'same_role',
      }),
    };
    await expect(new ReconnectService(expired).getDescriptor(playerId, checkedAt)).resolves.toEqual(
      { available: false },
    );
  });
});
