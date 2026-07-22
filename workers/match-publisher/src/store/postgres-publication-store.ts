import {
  matchResultSchema,
  parseHiveChameleonEvent,
  serializeHiveChameleonEvent,
  sha256Hex,
} from '@hive-chameleon/hive-gateway';

import { planMatchBatch, type MatchBatchPolicy } from '../batch-builder.js';
import { MatchPublisherError } from '../errors.js';
import type {
  FrozenMatchBatch,
  MatchOutboxAttempt,
  MatchPublicationCandidate,
  PublicMatchResult,
  SigningAttemptRecord,
} from '../model.js';
import type { MatchPublicationStore } from './publication-store.js';

export interface SqlQueryResult<Row extends Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

export interface SqlClientPort {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>>;
  release(destroy?: boolean): void;
}

export interface SqlPoolPort {
  connect(): Promise<SqlClientPort>;
}

interface CandidateRow extends Record<string, unknown> {
  readonly publication_request_id: string;
  readonly result_revision_id: string;
  readonly round_id: string;
  readonly completed_at: Date | string;
  readonly requested_at: Date | string;
  readonly tournament_id: string | null;
  readonly mode: 'casual' | 'infection';
  readonly result_schema_version: string;
  readonly scoring_rule_version: string;
  readonly map_id: string;
  readonly map_version_id: string;
  readonly map_version: string;
  readonly map_content_sha256: string;
  readonly game_server_build_version: string;
  readonly protocol_version: string;
  readonly winning_side: 'hiders' | 'hunters' | 'none';
  readonly winner_accounts: unknown;
  readonly participants: unknown;
  readonly discoveries: unknown;
  readonly survivors: unknown;
  readonly likes: unknown;
  readonly result_sha256: string;
}

interface OutboxRow extends Record<string, unknown> {
  readonly id: string;
  readonly event_uuid: string;
  readonly batch_uuid: string;
  readonly attempt_count: number;
  readonly canonical_payload: string;
  readonly payload_sha256: string;
}

interface CountRow extends Record<string, unknown> {
  readonly changed_count: number | string;
}

const candidateSql = `WITH selected_requests AS (
  SELECT request.id,
         request.round_id,
         request.result_revision_id,
         request.created_at
    FROM game.match_publication_request AS request
    JOIN game.game_round AS round ON round.id = request.round_id
   WHERE request.request_type = 'initial'
     AND request.state IN ('queued', 'retryable_failed')
     AND (request.next_retry_at IS NULL OR request.next_retry_at <= $1)
     AND round.status = 'completed'
   ORDER BY round.ended_at, round.id
   LIMIT $2
   FOR UPDATE OF request SKIP LOCKED
)
SELECT request.id AS publication_request_id,
       request.result_revision_id,
       round.id AS round_id,
       round.ended_at AS completed_at,
       request.created_at AS requested_at,
       tournament_match.tournament_id,
       round.mode::text AS mode,
       revision.result_schema_version,
       revision.scoring_rule_version,
       map.id AS map_id,
       map_version.id AS map_version_id,
       map_version.version_number AS map_version,
       map_package.sha256 AS map_content_sha256,
       round.game_server_build_version,
       round.protocol_version,
       round.winning_side::text AS winning_side,
       result_players.winner_accounts,
       result_players.participants,
       discoveries.discoveries,
       result_players.survivors,
       likes.likes,
       revision.canonical_complete_result_sha256 AS result_sha256
  FROM selected_requests AS request
  JOIN game.game_round AS round ON round.id = request.round_id
  JOIN game.round_result_revision AS revision ON revision.id = request.result_revision_id
  JOIN content.map_version AS map_version ON map_version.id = round.map_version_id
  JOIN content.map AS map ON map.id = map_version.map_id
  JOIN LATERAL (
    SELECT asset.sha256
      FROM content.map_asset AS asset
     WHERE asset.map_version_id = map_version.id
       AND asset.kind = 'package'
     ORDER BY asset.created_at, asset.id
     LIMIT 1
  ) AS map_package ON true
  JOIN LATERAL (
    SELECT jsonb_agg(
             jsonb_build_object(
               'account', player.hive_username,
               'initial_role', participant.initial_role::text,
               'final_role', participant.final_role::text,
               'outcome', CASE participant.outcome::text
                 WHEN 'hider_survived' THEN 'survived'
                 WHEN 'hider_found' THEN 'found'
                 WHEN 'hider_converted' THEN 'converted'
                 ELSE participant.outcome::text
               END,
               'score', participant.final_score::text
             ) ORDER BY player.hive_username
           ) AS participants,
           COALESCE(
             jsonb_agg(player.hive_username ORDER BY player.hive_username)
               FILTER (WHERE participant.outcome IN ('hunter_win', 'hider_survived')),
             '[]'::jsonb
           ) AS winner_accounts,
           COALESCE(
             jsonb_agg(player.hive_username ORDER BY player.hive_username)
               FILTER (WHERE participant.outcome = 'hider_survived'),
             '[]'::jsonb
           ) AS survivors
      FROM game.round_participant AS participant
      JOIN identity.player AS player ON player.id = participant.player_id
     WHERE participant.round_id = round.id
  ) AS result_players ON true
  JOIN LATERAL (
    SELECT COALESCE(
             jsonb_agg(
               jsonb_build_object('hunter', hunter.hive_username, 'hider', hider.hive_username)
               ORDER BY discovery.discovery_sequence
             ),
             '[]'::jsonb
           ) AS discoveries
      FROM game.round_discovery AS discovery
      JOIN identity.player AS hunter ON hunter.id = discovery.hunter_player_id
      JOIN identity.player AS hider ON hider.id = discovery.hider_player_id
     WHERE discovery.round_id = round.id
  ) AS discoveries ON true
  JOIN LATERAL (
    SELECT COALESCE(
             jsonb_agg(
               jsonb_build_object('account', aggregate.hive_username, 'received', aggregate.received)
               ORDER BY aggregate.hive_username
             ),
             '[]'::jsonb
           ) AS likes
      FROM (
        SELECT target.hive_username, count(*)::integer AS received
          FROM game.round_like AS round_like
          JOIN identity.player AS target ON target.id = round_like.target_hider_player_id
         WHERE round_like.round_id = round.id
         GROUP BY target.hive_username
      ) AS aggregate
  ) AS likes ON true
  LEFT JOIN tournament.match_game_round AS tournament_round
    ON tournament_round.game_round_id = round.id
  LEFT JOIN tournament.tournament_match AS tournament_match
    ON tournament_match.id = tournament_round.tournament_match_id
 ORDER BY round.ended_at, round.id`;

export class PostgresMatchPublicationStore implements MatchPublicationStore {
  public constructor(private readonly pool: SqlPoolPort) {}

  public async freezeNextBatch(
    now: Date,
    policy: MatchBatchPolicy,
  ): Promise<FrozenMatchBatch | null> {
    let frozen: FrozenMatchBatch | null = null;
    let deferredPlanningError: unknown;
    await this.inTransaction(async (client) => {
      const result = await client.query<CandidateRow>(candidateSql, [
        now.toISOString(),
        policy.maximumResults + 1,
      ]);
      const candidates: MatchPublicationCandidate[] = [];
      for (const row of result.rows) {
        try {
          candidates.push(candidateFromRow(row));
        } catch (error: unknown) {
          await this.deferInvalidRequest(client, row.publication_request_id, now, error);
          deferredPlanningError = error;
          return;
        }
      }
      try {
        frozen = planMatchBatch(candidates, now, policy);
      } catch (error: unknown) {
        const first = candidates[0];
        if (first !== undefined) {
          await this.deferInvalidRequest(client, first.publicationRequestId, now, error);
        }
        deferredPlanningError = error;
        return;
      }
      if (frozen === null) {
        return;
      }

      await client.query<Record<string, never>>(
        `INSERT INTO game.match_publication_outbox
          (id, event_uuid, batch_uuid, event_type, schema_version, event_contract_version,
           publication_period_start, publication_period_end, publisher_hive_account,
           result_count, canonical_payload, parsed_payload, payload_sha256, payload_byte_count)
         VALUES
          ($1, $2, $3, 'match_results_batch', 1, 'match-event-1',
           $4, $5, $6, $7, $8::text, $8::jsonb, $9, $10)`,
        [
          frozen.outboxId,
          frozen.eventId,
          frozen.batchId,
          frozen.publicationPeriodStart,
          frozen.publicationPeriodEnd,
          policy.publisherAccount,
          frozen.candidates.length,
          frozen.canonicalPayload,
          frozen.payloadSha256,
          frozen.payloadByteCount,
        ],
      );

      for (const [position, candidate] of frozen.candidates.entries()) {
        await client.query<Record<string, never>>(
          `INSERT INTO game.match_publication_item
            (id, outbox_id, publication_request_id, round_id, result_revision_id, result_position)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            checkedUuid(policy.nextUuidV7()),
            frozen.outboxId,
            candidate.publicationRequestId,
            candidate.roundId,
            candidate.resultRevisionId,
            position,
          ],
        );
      }

      const requestIds = frozen.candidates.map((candidate) => candidate.publicationRequestId);
      const updated = await client.query<Record<string, never>>(
        `UPDATE game.match_publication_request
            SET state = 'batched',
                last_failure_code = NULL,
                next_retry_at = NULL,
                updated_at = $2
          WHERE id = ANY($1::uuid[])
            AND state IN ('queued', 'retryable_failed')`,
        [requestIds, now.toISOString()],
      );
      if (updated.rowCount !== requestIds.length) {
        throw new MatchPublisherError(
          'database_unavailable',
          'Publication requests changed while freezing a batch',
        );
      }
    }, 'serializable');
    if (deferredPlanningError !== undefined) {
      throw deferredPlanningError;
    }
    return frozen;
  }

  public async claimNextOutbox(now: Date, leaseUntil: Date): Promise<MatchOutboxAttempt | null> {
    return this.inTransaction(async (client) => {
      const result = await client.query<OutboxRow>(
        `WITH candidate AS (
           SELECT id
             FROM game.match_publication_outbox
            WHERE event_type = 'match_results_batch'
              AND state IN ('queued', 'retryable_failed', 'reverted')
              AND (next_retry_at IS NULL OR next_retry_at <= $1)
            ORDER BY created_at, id
            LIMIT 1
            FOR UPDATE SKIP LOCKED
         )
         UPDATE game.match_publication_outbox AS outbox
            SET attempt_count = outbox.attempt_count + 1,
                last_attempt_at = $1,
                next_retry_at = $2,
                last_failure_code = NULL,
                updated_at = $1
           FROM candidate
          WHERE outbox.id = candidate.id
         RETURNING outbox.id,
                   outbox.event_uuid,
                   outbox.batch_uuid,
                   outbox.attempt_count,
                   outbox.canonical_payload,
                   outbox.payload_sha256`,
        [now.toISOString(), leaseUntil.toISOString()],
      );
      const row = result.rows[0];
      return row === undefined ? null : outboxAttemptFromRow(row);
    });
  }

  public async recordSigningAttempt(record: SigningAttemptRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query<Record<string, never>>(
        `INSERT INTO hive_projection.transaction_intent
          (id, idempotency_key, operation_kind, required_authority,
           canonical_operation_hash, authorization_mode, official_service_role,
           allowlist_policy_version, authorization_validated_at, state,
           requested_at, expires_at, hive_transaction_id)
         VALUES
          ($1, $2, $3, 'posting', $4, 'official_service', 'match_publisher',
           $5, $6, 'awaiting_signature', $6, $7, $8)`,
        [
          record.id,
          record.idempotencyKey,
          record.operationKind,
          record.canonicalOperationHash,
          record.policyVersion,
          record.validatedAt,
          record.expiresAt,
          record.transactionId,
        ],
      );
    } finally {
      client.release();
    }
  }

  public async markBroadcast(
    outboxId: string,
    signingAttemptId: string,
    transactionId: string,
    broadcastAt: Date,
  ): Promise<void> {
    await this.inTransaction(async (client) => {
      await client.query<Record<string, never>>(
        `UPDATE game.match_publication_outbox
            SET state = 'broadcast',
                hive_transaction_id = $2,
                next_retry_at = NULL,
                last_failure_code = NULL,
                updated_at = $3
          WHERE id = $1`,
        [outboxId, transactionId, broadcastAt.toISOString()],
      );
      await client.query<Record<string, never>>(
        `UPDATE hive_projection.transaction_intent
            SET state = 'broadcast',
                hive_transaction_id = $2,
                failure_code = NULL,
                updated_at = $3
          WHERE id = $1`,
        [signingAttemptId, transactionId, broadcastAt.toISOString()],
      );
    });
  }

  public async markRetryableFailure(
    outboxId: string,
    signingAttemptId: string | null,
    transactionId: string | null,
    failureCode: string,
    retryAt: Date,
  ): Promise<void> {
    const stableCode = stableFailureCode(failureCode);
    await this.inTransaction(async (client) => {
      await client.query<Record<string, never>>(
        `UPDATE game.match_publication_outbox
            SET state = 'retryable_failed',
                hive_transaction_id = COALESCE($2, hive_transaction_id),
                next_retry_at = $3,
                last_failure_code = $4,
                updated_at = now()
          WHERE id = $1`,
        [outboxId, transactionId, retryAt.toISOString(), stableCode],
      );
      if (signingAttemptId !== null) {
        await client.query<Record<string, never>>(
          `UPDATE hive_projection.transaction_intent
              SET state = 'failed',
                  hive_transaction_id = COALESCE($2, hive_transaction_id),
                  failure_code = $3,
                  updated_at = now()
            WHERE id = $1`,
          [signingAttemptId, transactionId, stableCode],
        );
      }
    });
  }

  public async reconcileProjectedFinality(now: Date): Promise<number> {
    return this.inTransaction(async (client) => {
      const result = await client.query<CountRow>(
        `WITH updated_outbox AS (
           UPDATE game.match_publication_outbox AS outbox
              SET state = event.operation_state::text::game.match_publication_outbox_state,
                  operation_id = event.operation_id,
                  included_at = event.included_at,
                  irreversible_at = event.irreversible_at,
                  reverted_at = event.reverted_at,
                  next_retry_at = CASE
                    WHEN event.operation_state = 'reverted' THEN $1::timestamptz
                    ELSE NULL
                  END,
                  updated_at = $1
             FROM hive_projection.match_event AS event
            WHERE event.event_uuid = outbox.event_uuid
              AND event.operation_state::text <> outbox.state::text
              AND outbox.state <> 'irreversible'
           RETURNING outbox.id, outbox.state
         ), published_requests AS (
           UPDATE game.match_publication_request AS request
              SET state = 'published',
                  published_at = $1,
                  updated_at = $1
             FROM game.match_publication_item AS item
             JOIN updated_outbox AS outbox
               ON outbox.id = item.outbox_id
              AND outbox.state = 'irreversible'
            WHERE request.id = item.publication_request_id
              AND request.state <> 'published'
           RETURNING request.id
         )
         SELECT count(*)::integer AS changed_count FROM updated_outbox`,
        [now.toISOString()],
      );
      return parseCount(result.rows[0]?.changed_count ?? 0);
    });
  }

  private async deferInvalidRequest(
    client: SqlClientPort,
    publicationRequestId: string,
    now: Date,
    error: unknown,
  ): Promise<void> {
    const code =
      error instanceof MatchPublisherError && error.code === 'payload_too_large'
        ? 'payload_too_large'
        : 'invalid_candidate';
    await client.query<Record<string, never>>(
      `UPDATE game.match_publication_request
          SET state = 'retryable_failed',
              attempt_count = attempt_count + 1,
              last_attempt_at = $2,
              next_retry_at = $3,
              last_failure_code = $4,
              updated_at = $2
        WHERE id = $1`,
      [
        publicationRequestId,
        now.toISOString(),
        new Date(now.valueOf() + 60 * 60 * 1_000).toISOString(),
        code,
      ],
    );
  }

  private async inTransaction<T>(
    work: (client: SqlClientPort) => Promise<T>,
    isolation: 'read committed' | 'serializable' = 'read committed',
  ): Promise<T> {
    const client = await this.pool.connect();
    let released = false;
    try {
      await client.query<Record<string, never>>(
        isolation === 'serializable' ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN',
      );
      const value = await work(client);
      await client.query<Record<string, never>>('COMMIT');
      return value;
    } catch (error: unknown) {
      try {
        await client.query<Record<string, never>>('ROLLBACK');
      } catch {
        client.release(true);
        released = true;
      }
      throw error;
    } finally {
      if (!released) {
        client.release();
      }
    }
  }
}

function candidateFromRow(row: CandidateRow): MatchPublicationCandidate {
  const completedAt = toIsoString(row.completed_at);
  const base = {
    round_id: row.round_id,
    completed_at: completedAt,
    context: row.tournament_id === null ? ('normal' as const) : ('tournament' as const),
    ...(row.tournament_id === null ? {} : { tournament_id: row.tournament_id }),
    mode: row.mode,
    result_schema: row.result_schema_version,
    scoring_rules: row.scoring_rule_version,
    map: {
      map_id: row.map_id,
      version_id: row.map_version_id,
      version: row.map_version,
      content_sha256: row.map_content_sha256,
    },
    server: { build: row.game_server_build_version, protocol: row.protocol_version },
    winning_side: row.winning_side,
    winner_accounts: row.winner_accounts,
    participants: row.participants,
    discoveries: row.discoveries,
    survivors: row.survivors,
    likes: row.likes,
    result_sha256: row.result_sha256,
  };
  const parsed = matchResultSchema.safeParse(base);
  if (!parsed.success) {
    throw new MatchPublisherError(
      'invalid_candidate',
      'Committed terminal result cannot be represented by the public match contract',
      { cause: parsed.error },
    );
  }
  return {
    publicationRequestId: row.publication_request_id,
    resultRevisionId: row.result_revision_id,
    roundId: row.round_id,
    completedAt,
    requestedAt: toIsoString(row.requested_at),
    publicResult: parsed.data as PublicMatchResult,
  };
}

function outboxAttemptFromRow(row: OutboxRow): MatchOutboxAttempt {
  const event = parseHiveChameleonEvent(row.canonical_payload);
  if (
    event.type !== 'match_results_batch' ||
    event.event_id !== row.event_uuid ||
    event.data.batch_id !== row.batch_uuid ||
    serializeHiveChameleonEvent(event) !== row.canonical_payload ||
    sha256Hex(row.canonical_payload) !== row.payload_sha256
  ) {
    throw new MatchPublisherError(
      'invalid_candidate',
      'Frozen outbox identity, canonical payload, or hash is inconsistent',
    );
  }
  return {
    outboxId: row.id,
    eventId: row.event_uuid,
    batchId: row.batch_uuid,
    attemptCount: row.attempt_count,
    canonicalPayload: row.canonical_payload,
    payloadSha256: row.payload_sha256,
    event,
  };
}

function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new MatchPublisherError('invalid_candidate', 'Database timestamp is invalid');
  }
  return date.toISOString();
}

function checkedUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new MatchPublisherError('configuration_invalid', 'ID provider returned a non-UUIDv7');
  }
  return value;
}

function stableFailureCode(value: string): string {
  return /^[a-z][a-z0-9_]{1,63}$/.test(value) ? value : 'publication_failed';
}

function parseCount(value: number | string): number {
  const count = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new MatchPublisherError('database_unavailable', 'Database returned an invalid count');
  }
  return count;
}
