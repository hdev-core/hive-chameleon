import { Buffer } from 'node:buffer';

import {
  HiveGatewayError,
  serializeHiveChameleonEvent,
  sha256Hex,
} from '@hive-chameleon/hive-gateway';

import { MatchPublisherError } from './errors.js';
import type { FrozenMatchBatch, MatchBatchEvent, MatchPublicationCandidate } from './model.js';

export interface MatchBatchPolicy {
  readonly publisherAccount: string;
  readonly maximumAgeMs: number;
  readonly maximumResults: number;
  readonly maximumPayloadBytes: number;
  readonly nextUuidV7: () => string;
}

export function planMatchBatch(
  candidates: readonly MatchPublicationCandidate[],
  now: Date,
  policy: MatchBatchPolicy,
): FrozenMatchBatch | null {
  validatePolicy(policy);
  if (Number.isNaN(now.valueOf())) {
    throw new MatchPublisherError('invalid_candidate', 'Batch clock is invalid');
  }
  if (candidates.length === 0) {
    return null;
  }

  const ordered = [...candidates].sort(compareCandidates);
  assertCandidates(ordered, now);
  const eventId = checkedUuid(policy.nextUuidV7(), 'event');
  const batchId = checkedUuid(policy.nextUuidV7(), 'batch');
  const outboxId = checkedUuid(policy.nextUuidV7(), 'outbox');
  const occurredAt = now.toISOString();
  const periodStart = ordered[0]?.completedAt;
  if (periodStart === undefined) {
    return null;
  }
  const latestCompletion = new Date(
    ordered[Math.min(ordered.length, policy.maximumResults) - 1]?.completedAt ?? periodStart,
  );
  const periodEndDate =
    now.valueOf() > latestCompletion.valueOf() ? now : new Date(latestCompletion.valueOf() + 1);
  const periodEnd = periodEndDate.toISOString();

  const selected: MatchPublicationCandidate[] = [];
  let selectedPayload = '';
  let selectedEvent: MatchBatchEvent | undefined;
  let payloadLimitReached = false;

  for (const candidate of ordered.slice(0, policy.maximumResults)) {
    const tentative = [...selected, candidate];
    const event = createEvent(
      tentative,
      policy.publisherAccount,
      eventId,
      batchId,
      occurredAt,
      periodStart,
      periodEnd,
    );
    let payload: string;
    try {
      payload = serializeHiveChameleonEvent(event);
    } catch (error: unknown) {
      if (!(error instanceof HiveGatewayError) || error.code !== 'payload_too_large') {
        throw new MatchPublisherError('invalid_candidate', 'Candidate failed event validation', {
          cause: error,
        });
      }
      if (selected.length === 0) {
        throw new MatchPublisherError(
          'payload_too_large',
          'One complete public match result exceeds the Hive payload limit',
          { cause: error },
        );
      }
      payloadLimitReached = true;
      break;
    }
    const byteCount = Buffer.byteLength(payload, 'utf8');
    if (byteCount > policy.maximumPayloadBytes) {
      if (selected.length === 0) {
        throw new MatchPublisherError(
          'payload_too_large',
          'One complete public match result exceeds the configured payload limit',
        );
      }
      payloadLimitReached = true;
      break;
    }
    selected.push(candidate);
    selectedPayload = payload;
    selectedEvent = event;
  }

  if (selectedEvent === undefined || selectedPayload === '') {
    throw new MatchPublisherError('invalid_candidate', 'No publishable candidate was selected');
  }

  const oldestCompletion = Date.parse(ordered[0]?.completedAt ?? '');
  const ageLimitReached = now.valueOf() - oldestCompletion >= policy.maximumAgeMs;
  const resultLimitReached = selected.length === policy.maximumResults;
  if (!ageLimitReached && !resultLimitReached && !payloadLimitReached) {
    return null;
  }

  return Object.freeze({
    outboxId,
    eventId,
    batchId,
    event: selectedEvent,
    canonicalPayload: selectedPayload,
    payloadSha256: sha256Hex(selectedPayload),
    payloadByteCount: Buffer.byteLength(selectedPayload, 'utf8'),
    publicationPeriodStart: periodStart,
    publicationPeriodEnd: periodEnd,
    candidates: Object.freeze(selected),
  });
}

function createEvent(
  candidates: readonly MatchPublicationCandidate[],
  publisher: string,
  eventId: string,
  batchId: string,
  occurredAt: string,
  periodStart: string,
  periodEnd: string,
): MatchBatchEvent {
  return {
    v: 1,
    type: 'match_results_batch',
    event_version: 1,
    event_id: eventId,
    occurred_at: occurredAt,
    data: {
      batch_id: batchId,
      period_start: periodStart,
      period_end: periodEnd,
      publisher,
      result_count: candidates.length,
      results: candidates.map((candidate) => candidate.publicResult),
    },
  };
}

function compareCandidates(
  left: MatchPublicationCandidate,
  right: MatchPublicationCandidate,
): number {
  const timeDifference = Date.parse(left.completedAt) - Date.parse(right.completedAt);
  return timeDifference === 0 ? left.roundId.localeCompare(right.roundId) : timeDifference;
}

function assertCandidates(candidates: readonly MatchPublicationCandidate[], now: Date): void {
  const roundIds = new Set<string>();
  const requestIds = new Set<string>();
  for (const candidate of candidates) {
    const completedAt = Date.parse(candidate.completedAt);
    if (
      !Number.isFinite(completedAt) ||
      completedAt > now.valueOf() ||
      candidate.publicResult.completed_at !== candidate.completedAt ||
      candidate.publicResult.round_id !== candidate.roundId
    ) {
      throw new MatchPublisherError(
        'invalid_candidate',
        'Candidate identity or completion timestamp is inconsistent',
      );
    }
    if (roundIds.has(candidate.roundId) || requestIds.has(candidate.publicationRequestId)) {
      throw new MatchPublisherError('invalid_candidate', 'Batch candidates must be unique');
    }
    roundIds.add(candidate.roundId);
    requestIds.add(candidate.publicationRequestId);
  }
}

function validatePolicy(policy: MatchBatchPolicy): void {
  if (
    !Number.isSafeInteger(policy.maximumAgeMs) ||
    policy.maximumAgeMs < 1_000 ||
    !Number.isSafeInteger(policy.maximumResults) ||
    policy.maximumResults < 1 ||
    policy.maximumResults > 20 ||
    !Number.isSafeInteger(policy.maximumPayloadBytes) ||
    policy.maximumPayloadBytes < 512 ||
    policy.maximumPayloadBytes > 6 * 1024
  ) {
    throw new MatchPublisherError('configuration_invalid', 'Match batch policy is invalid');
  }
}

function checkedUuid(value: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new MatchPublisherError('configuration_invalid', `${label} ID provider is invalid`);
  }
  return value;
}
