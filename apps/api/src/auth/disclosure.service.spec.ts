import { ConflictException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthRepository } from './auth.types';
import { DisclosureService } from './disclosure.service';

const contentSha256 = '64ae0b7b385c6f4c1287e25979c44fce05c51583f61f20c7bb7e31171d921cc3';
const now = new Date('2026-07-23T01:00:00.000Z');

describe('DisclosureService', () => {
  let repository: AuthRepository;

  beforeEach(() => {
    repository = {
      acknowledgeCurrentDisclosure: vi.fn(),
      consumeHiveChallenge: vi.fn(),
      createHiveChallenge: vi.fn(),
      createSession: vi.fn(),
      findActiveSession: vi.fn(),
      findOrCreateDirectHivePlayer: vi.fn(),
      getCurrentDisclosure: vi.fn().mockResolvedValue({
        contentSha256,
        effectiveAt: new Date('2026-07-22T00:00:00.000Z'),
        version: '2026-07-22',
      }),
      revokeSession: vi.fn(),
      rotateSession: vi.fn(),
      upsertGoogleIdentity: vi.fn(),
    };
  });

  it('returns the exact content bound to the database hash', async () => {
    const result = await new DisclosureService(repository).getCurrent(now);

    expect(result).toMatchObject({
      contentSha256,
      permanentFields: [
        'hive_username',
        'match_participation',
        'role',
        'score',
        'outcome',
        'aggregated_likes',
      ],
      version: '2026-07-22',
    });
  });

  it('rejects stale content rather than acknowledging a changed disclosure', async () => {
    await expect(
      new DisclosureService(repository).acknowledge(
        {
          contentSha256: 'a'.repeat(64),
          disclosureVersion: '2026-07-22',
          externalIdentityId: null,
          playerId: '01980abc-def0-7abc-8def-0123456789ab',
        },
        now,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.acknowledgeCurrentDisclosure).not.toHaveBeenCalled();
  });
});
