import { describe, expect, it } from 'vitest';

import { MATCH_EVENT_FIXTURE } from '@hive-chameleon/hive-gateway/testing';

import { planMatchBatch } from './batch-builder.js';
import type { MatchPublicationCandidate } from './model.js';

const ids = [
  '01910000-0000-7000-8000-000000000001',
  '01910000-0000-7000-8000-000000000002',
  '01910000-0000-7000-8000-000000000003',
];

describe('planMatchBatch', () => {
  it('sorts results and freezes canonical IDs, bytes, and hash when age is reached', () => {
    const later = candidate('0190f6d2-7c00-7000-8000-000000000010', '2026-07-11T12:04:00.000Z');
    const earlier = candidate('0190f6d2-7c00-7000-8000-000000000003', '2026-07-11T12:03:42.000Z');
    let index = 0;
    const frozen = planMatchBatch([later, earlier], new Date('2026-07-11T12:10:00.000Z'), {
      publisherAccount: 'match-pub',
      maximumAgeMs: 5 * 60 * 1_000,
      maximumResults: 20,
      maximumPayloadBytes: 6 * 1024,
      nextUuidV7: () => ids[index++] ?? 'missing',
    });

    expect(frozen).not.toBeNull();
    expect(frozen?.eventId).toBe(ids[0]);
    expect(frozen?.batchId).toBe(ids[1]);
    expect(frozen?.outboxId).toBe(ids[2]);
    expect(frozen?.event.data.results.map((result) => result.round_id)).toEqual([
      earlier.roundId,
      later.roundId,
    ]);
    expect(Buffer.byteLength(frozen?.canonicalPayload ?? '', 'utf8')).toBe(
      frozen?.payloadByteCount,
    );
    expect(frozen?.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(frozen?.canonicalPayload ?? '{}')).toEqual(frozen?.event);
  });

  it('waits while no age, result-count, or payload limit is reached', () => {
    let index = 0;
    expect(
      planMatchBatch(
        [candidate('0190f6d2-7c00-7000-8000-000000000003', '2026-07-11T12:03:42.000Z')],
        new Date('2026-07-11T12:04:00.000Z'),
        {
          publisherAccount: 'match-pub',
          maximumAgeMs: 5 * 60 * 1_000,
          maximumResults: 20,
          maximumPayloadBytes: 6 * 1024,
          nextUuidV7: () => ids[index++] ?? 'missing',
        },
      ),
    ).toBeNull();
  });

  it('flushes exactly at the configured result limit', () => {
    let index = 0;
    const frozen = planMatchBatch(
      [
        candidate('0190f6d2-7c00-7000-8000-000000000003', '2026-07-11T12:03:42.000Z'),
        candidate('0190f6d2-7c00-7000-8000-000000000010', '2026-07-11T12:03:43.000Z'),
      ],
      new Date('2026-07-11T12:04:00.000Z'),
      {
        publisherAccount: 'match-pub',
        maximumAgeMs: 5 * 60 * 1_000,
        maximumResults: 2,
        maximumPayloadBytes: 6 * 1024,
        nextUuidV7: () => ids[index++] ?? 'missing',
      },
    );
    expect(frozen?.candidates).toHaveLength(2);
  });
});

function candidate(roundId: string, completedAt: string): MatchPublicationCandidate {
  if (MATCH_EVENT_FIXTURE.type !== 'match_results_batch') {
    throw new Error('fixture is not a match batch');
  }
  const fixtureResult = MATCH_EVENT_FIXTURE.data.results[0];
  if (fixtureResult === undefined) {
    throw new Error('fixture result is missing');
  }
  return {
    publicationRequestId: roundId.replace(/.$/, 'a'),
    resultRevisionId: roundId.replace(/.$/, 'b'),
    roundId,
    completedAt,
    requestedAt: completedAt,
    publicResult: { ...fixtureResult, round_id: roundId, completed_at: completedAt },
  };
}
