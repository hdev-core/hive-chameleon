import { parseHiveChameleonEvent, type HiveChameleonEvent } from '@hive-chameleon/hive-gateway';

import { HafProjectorError } from '../errors.js';
import type { BlockCheckpoint, HafBlock, OperationDecision, ProjectionCursor } from '../model.js';
import type { ProjectionStore } from './projection-store.js';

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

export interface PostgresProjectionStoreOptions {
  readonly endpointIdentity: string;
  readonly nextUuidV7: () => string;
}

interface CursorRow extends Record<string, unknown> {
  readonly source: string;
  readonly last_processed_block: string | number;
  readonly last_irreversible_block: string | number;
  readonly block_id: string | null;
}

interface CheckpointRow extends Record<string, unknown> {
  readonly source: string;
  readonly block_number: string | number;
  readonly block_id: string;
  readonly previous_block_id: string | null;
  readonly block_timestamp: Date | string;
  readonly state: 'included' | 'irreversible' | 'reverted';
  readonly observed_at: Date | string;
  readonly irreversible_at: Date | string | null;
  readonly reverted_at: Date | string | null;
}

interface IrreversibleOperationRow extends Record<string, unknown> {
  readonly id: string;
  readonly transaction_id: string | null;
  readonly block_number: string | number;
  readonly block_timestamp: Date | string;
  readonly primary_account: string;
  readonly payload: unknown;
  readonly match_event_uuid: string | null;
}

interface ProjectionIdentityRow extends Record<string, unknown> {
  readonly id: string;
  readonly revision_id?: string;
}

export class PostgresProjectionStore implements ProjectionStore {
  private readonly endpointIdentity: string;

  public constructor(
    private readonly pool: SqlPoolPort,
    private readonly options: PostgresProjectionStoreOptions,
  ) {
    this.endpointIdentity = sanitizeEndpointIdentity(options.endpointIdentity);
  }

  public async getCursor(source: string): Promise<ProjectionCursor> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<CursorRow>(
        `SELECT c.source,
                c.last_processed_block,
                c.last_irreversible_block,
                b.block_id
           FROM hive_projection.sync_cursor AS c
           LEFT JOIN hive_projection.block_checkpoint AS b
             ON b.source = c.source
            AND b.block_number = c.last_processed_block
            AND b.state <> 'reverted'
          WHERE c.source = $1`,
        [source],
      );
      const row = result.rows[0];
      return row === undefined ? initialCursor(source) : cursorFromRow(row);
    } finally {
      client.release();
    }
  }

  public async getCurrentCheckpoint(
    source: string,
    blockNumber: number,
  ): Promise<BlockCheckpoint | null> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<CheckpointRow>(
        `SELECT source,
                block_number,
                block_id,
                previous_block_id,
                block_timestamp,
                state,
                observed_at,
                irreversible_at,
                reverted_at
           FROM hive_projection.block_checkpoint
          WHERE source = $1
            AND block_number = $2
            AND state <> 'reverted'`,
        [source, blockNumber],
      );
      const row = result.rows[0];
      return row === undefined ? null : checkpointFromRow(row);
    } finally {
      client.release();
    }
  }

  public async applyBlock(
    source: string,
    block: HafBlock,
    decisions: readonly OperationDecision[],
    observedAt: string,
  ): Promise<void> {
    await this.inTransaction(async (client) => {
      const cursor = await this.lockCursor(client, source);
      if (block.number !== cursor.lastProcessedBlock + 1) {
        throw new HafProjectorError(
          'cursor_conflict',
          'Block does not immediately follow the cursor',
        );
      }
      if (
        cursor.lastProcessedBlockId !== null &&
        cursor.lastProcessedBlockId !== block.previousId
      ) {
        throw new HafProjectorError('cursor_conflict', 'Block parent does not match the cursor');
      }

      const checkpointId = this.nextUuidV7();
      await client.query<Record<string, never>>(
        `INSERT INTO hive_projection.block_checkpoint
          (id, source, block_number, block_id, previous_block_id, block_timestamp, state, observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'included', $7)`,
        [
          checkpointId,
          source,
          block.number,
          block.id,
          block.previousId,
          block.timestamp,
          observedAt,
        ],
      );

      for (const decision of decisions) {
        const operationId = await this.insertOperation(client, checkpointId, decision, observedAt);
        if (decision.validationState === 'accepted' && isMatchEvent(decision.event)) {
          await this.upsertIncludedMatchEvent(client, operationId, decision);
        }
      }

      await client.query<Record<string, never>>(
        `UPDATE hive_projection.sync_cursor
            SET endpoint_url = $2,
                last_processed_block = $3,
                last_successful_sync_at = $4,
                health = 'healthy',
                last_error_code = NULL,
                updated_at = $4
          WHERE source = $1`,
        [source, this.endpointIdentity, block.number, observedAt],
      );
    });
  }

  public async revertAfter(
    source: string,
    ancestorBlock: number,
    revertedAt: string,
  ): Promise<void> {
    await this.inTransaction(async (client) => {
      const cursor = await this.lockCursor(client, source);
      if (ancestorBlock < cursor.lastIrreversibleBlock) {
        throw new HafProjectorError(
          'irreversible_fork',
          'Cannot revert an irreversible checkpoint',
        );
      }

      await client.query<Record<string, never>>(
        `UPDATE hive_projection.match_event AS event
            SET operation_state = 'reverted',
                validation_state = 'reverted',
                irreversible_at = NULL,
                reverted_at = $3
           FROM hive_projection.operation AS operation
           JOIN hive_projection.block_checkpoint AS checkpoint
             ON checkpoint.id = operation.checkpoint_id
          WHERE event.operation_id = operation.id
            AND checkpoint.source = $1
            AND checkpoint.block_number > $2
            AND event.operation_state = 'included'`,
        [source, ancestorBlock, revertedAt],
      );
      await client.query<Record<string, never>>(
        `UPDATE hive_projection.operation AS operation
            SET state = 'reverted', reverted_at = $3
           FROM hive_projection.block_checkpoint AS checkpoint
          WHERE checkpoint.id = operation.checkpoint_id
            AND checkpoint.source = $1
            AND checkpoint.block_number > $2
            AND operation.state <> 'reverted'`,
        [source, ancestorBlock, revertedAt],
      );
      await client.query<Record<string, never>>(
        `UPDATE hive_projection.block_checkpoint
            SET state = 'reverted', reverted_at = $3
          WHERE source = $1
            AND block_number > $2
            AND state <> 'reverted'`,
        [source, ancestorBlock, revertedAt],
      );
      await client.query<Record<string, never>>(
        `UPDATE hive_projection.sync_cursor
            SET last_processed_block = $2,
                updated_at = $3
          WHERE source = $1`,
        [source, ancestorBlock, revertedAt],
      );
    });
  }

  public async finalizeThrough(
    source: string,
    blockNumber: number,
    irreversibleAt: string,
  ): Promise<void> {
    await this.inTransaction(async (client) => {
      const cursor = await this.lockCursor(client, source);
      if (blockNumber > cursor.lastProcessedBlock) {
        throw new HafProjectorError(
          'cursor_conflict',
          'Cannot finalize beyond the processed cursor',
        );
      }

      await client.query<Record<string, never>>(
        `UPDATE hive_projection.match_event AS event
            SET operation_state = 'irreversible',
                validation_state = 'accepted',
                irreversible_at = $3,
                reverted_at = NULL
           FROM hive_projection.operation AS operation
           JOIN hive_projection.block_checkpoint AS checkpoint
             ON checkpoint.id = operation.checkpoint_id
          WHERE event.operation_id = operation.id
            AND checkpoint.source = $1
            AND checkpoint.block_number <= $2
            AND event.operation_state = 'included'`,
        [source, blockNumber, irreversibleAt],
      );
      await client.query<Record<string, never>>(
        `UPDATE hive_projection.operation AS operation
            SET state = 'irreversible', irreversible_at = $3
           FROM hive_projection.block_checkpoint AS checkpoint
          WHERE checkpoint.id = operation.checkpoint_id
            AND checkpoint.source = $1
            AND checkpoint.block_number <= $2
            AND operation.state = 'included'`,
        [source, blockNumber, irreversibleAt],
      );
      await client.query<Record<string, never>>(
        `UPDATE hive_projection.block_checkpoint
            SET state = 'irreversible', irreversible_at = $3
          WHERE source = $1
            AND block_number <= $2
            AND state = 'included'`,
        [source, blockNumber, irreversibleAt],
      );
      await client.query<Record<string, never>>(
        `UPDATE hive_projection.sync_cursor
            SET last_irreversible_block = GREATEST(last_irreversible_block, $2),
                last_successful_sync_at = $3,
                health = 'healthy',
                last_error_code = NULL,
                updated_at = $3
          WHERE source = $1`,
        [source, blockNumber, irreversibleAt],
      );
      await this.materializeIrreversibleEvents(client, source, blockNumber, irreversibleAt);
    });
  }

  private async lockCursor(client: SqlClientPort, source: string): Promise<ProjectionCursor> {
    await client.query<Record<string, never>>(
      `INSERT INTO hive_projection.sync_cursor
        (source, endpoint_url, last_processed_block, last_irreversible_block, health)
       VALUES ($1, $2, 0, 0, 'healthy')
       ON CONFLICT (source) DO NOTHING`,
      [source, this.endpointIdentity],
    );
    const result = await client.query<CursorRow>(
      `SELECT c.source,
              c.last_processed_block,
              c.last_irreversible_block,
              b.block_id
         FROM hive_projection.sync_cursor AS c
         LEFT JOIN hive_projection.block_checkpoint AS b
           ON b.source = c.source
          AND b.block_number = c.last_processed_block
          AND b.state <> 'reverted'
        WHERE c.source = $1
          FOR UPDATE OF c`,
      [source],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new HafProjectorError('cursor_conflict', 'Projection cursor could not be locked');
    }
    return cursorFromRow(row);
  }

  private async insertOperation(
    client: SqlClientPort,
    checkpointId: string,
    decision: OperationDecision,
    observedAt: string,
  ): Promise<string> {
    const evidence = decision.evidence;
    const operationId = this.nextUuidV7();
    await client.query<Record<string, never>>(
      `INSERT INTO hive_projection.operation
        (id, checkpoint_id, source_operation_id, transaction_id, operation_index, is_virtual,
         block_number, block_id, block_timestamp, operation_type, primary_account,
         required_authority, application_id, payload, state, observed_at,
         validation_state, rejection_reason, validated_at)
       VALUES
        ($1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11,
         $12, $13, $14::jsonb, 'included', $15,
         $16, $17, $15)`,
      [
        operationId,
        checkpointId,
        evidence.sourceOperationId,
        evidence.transactionId,
        evidence.operationIndex,
        evidence.isVirtual,
        evidence.blockNumber,
        evidence.blockId,
        evidence.blockTimestamp,
        evidence.operationType,
        evidence.primaryAccount,
        evidence.requiredAuthority,
        evidence.applicationId,
        JSON.stringify(evidence.payload),
        observedAt,
        decision.validationState,
        decision.rejectionReason ?? null,
      ],
    );
    return operationId;
  }

  private async upsertIncludedMatchEvent(
    client: SqlClientPort,
    operationId: string,
    decision: OperationDecision,
  ): Promise<void> {
    const event = decision.event;
    if (!isMatchEvent(event)) {
      return;
    }
    const fields = matchEventFields(event);
    const values = [
      event.event_id,
      fields.batchId,
      operationId,
      event.type,
      event.v,
      `match-event-${event.event_version}`,
      fields.periodStart,
      fields.periodEnd,
      fields.publisher,
      fields.resultCount,
      decision.evidence.blockTimestamp,
    ] as const;

    const replay = await client.query<Record<string, never>>(
      `UPDATE hive_projection.match_event
          SET operation_id = $2,
              operation_state = 'included',
              validation_state = 'accepted',
              rejection_reason = NULL,
              included_at = $3,
              irreversible_at = NULL,
              reverted_at = NULL
        WHERE event_uuid = $1
          AND operation_state = 'reverted'`,
      [event.event_id, operationId, decision.evidence.blockTimestamp],
    );
    if (replay.rowCount !== 0) {
      return;
    }

    // Duplicate logical events on another included transaction are retained as raw operations but
    // do not replace the first binding. A reverted binding is replaced only by the exact-payload
    // replay path above, which the database trigger independently verifies.
    await client.query<Record<string, never>>(
      `INSERT INTO hive_projection.match_event
        (event_uuid, batch_uuid, operation_id, event_type, schema_version,
         event_contract_version, publication_period_start, publication_period_end,
         publisher_hive_account, result_count, operation_state, validation_state, included_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'included', 'accepted', $11)
       ON CONFLICT DO NOTHING`,
      values,
    );
  }

  private async materializeIrreversibleEvents(
    client: SqlClientPort,
    source: string,
    blockNumber: number,
    irreversibleAt: string,
  ): Promise<void> {
    const result = await client.query<IrreversibleOperationRow>(
      `SELECT operation.id,
              operation.transaction_id,
              operation.block_number,
              operation.block_timestamp,
              operation.primary_account,
              operation.payload,
              match_event.event_uuid AS match_event_uuid
         FROM hive_projection.operation AS operation
         JOIN hive_projection.block_checkpoint AS checkpoint
           ON checkpoint.id = operation.checkpoint_id
         LEFT JOIN hive_projection.match_event AS match_event
           ON match_event.operation_id = operation.id
        WHERE checkpoint.source = $1
          AND checkpoint.block_number <= $2
          AND operation.state = 'irreversible'
          AND operation.irreversible_at = $3
          AND operation.validation_state = 'accepted'
          AND operation.application_id = 'hive.chameleon'
        ORDER BY operation.block_number, operation.operation_index, operation.id`,
      [source, blockNumber, irreversibleAt],
    );

    for (const row of result.rows) {
      const event = eventFromOperationPayload(row.payload);
      switch (event.type) {
        case 'match_results_batch':
          if (row.match_event_uuid !== event.event_id) break;
          await this.materializeInitialMatchResults(client, event, irreversibleAt);
          break;
        case 'match_result_corrected':
          if (row.match_event_uuid !== event.event_id) break;
          await this.materializeMatchCorrection(client, event, irreversibleAt);
          break;
        case 'match_result_invalidated':
          if (row.match_event_uuid !== event.event_id) break;
          await this.materializeMatchInvalidation(client, event);
          break;
        case 'collectible_issued':
          await this.materializeCollectibleIssue(client, row, event, irreversibleAt);
          break;
        case 'collectible_revoked':
          await this.materializeCollectibleRevocation(client, row, event);
          break;
      }
    }
  }

  private async materializeInitialMatchResults(
    client: SqlClientPort,
    event: Extract<HiveChameleonEvent, { type: 'match_results_batch' }>,
    irreversibleAt: string,
  ): Promise<void> {
    for (const [position, result] of event.data.results.entries()) {
      await client.query<Record<string, never>>(
        `WITH local_result AS (
           SELECT round.id AS round_id,
                  matching_revision.id AS revision_id
             FROM game.game_round AS round
             JOIN content.map_version AS map_version
               ON map_version.id = round.map_version_id
              AND map_version.id = $7
              AND map_version.map_id = $8
             LEFT JOIN LATERAL (
               SELECT revision.id
                 FROM game.round_result_revision AS revision
                WHERE revision.round_id = round.id
                  AND revision.result_schema_version = $5
                  AND revision.scoring_rule_version = $6
                  AND revision.canonical_complete_result_sha256 = $12
                ORDER BY revision.revision_number DESC
                LIMIT 1
             ) AS matching_revision ON true
            WHERE round.id = $4
              AND EXISTS (
                SELECT 1
                  FROM content.map_asset AS asset
                 WHERE asset.map_version_id = map_version.id
                   AND asset.kind = 'package'
                   AND asset.sha256 = $9
              )
         )
         INSERT INTO hive_projection.match_result
          (id, initial_event_uuid, result_position, round_id, result_schema_version,
           scoring_rule_version, map_version_id, map_content_sha256,
           server_build_version, match_protocol_version, public_result_sha256,
           current_state, current_event_uuid, matched_result_revision_id,
           reconciliation_state, reconciled_at)
         SELECT $1, $2, $3, local_result.round_id, $5,
                $6, $7, $9, $10, $11, $12,
                'current', $2, local_result.revision_id,
                CASE WHEN local_result.revision_id IS NULL THEN 'pending'
                     ELSE 'matched' END::hive_projection.reconciliation_state,
                CASE WHEN local_result.revision_id IS NULL THEN NULL ELSE $13::timestamptz END
           FROM local_result
         ON CONFLICT (round_id) DO NOTHING`,
        [
          this.nextUuidV7(),
          event.event_id,
          position,
          result.round_id,
          result.result_schema,
          result.scoring_rules,
          result.map.version_id,
          result.map.map_id,
          result.map.content_sha256,
          result.server.build,
          result.server.protocol,
          result.result_sha256,
          irreversibleAt,
        ],
      );
    }
  }

  private async materializeMatchCorrection(
    client: SqlClientPort,
    event: Extract<HiveChameleonEvent, { type: 'match_result_corrected' }>,
    irreversibleAt: string,
  ): Promise<void> {
    const replacement = event.data.replacement_result;
    const lookup = await client.query<ProjectionIdentityRow>(
      `SELECT result.id,
              revision.id AS revision_id
         FROM hive_projection.match_result AS result
         JOIN game.round_result_revision AS revision
           ON revision.round_id = result.round_id
          AND revision.revision_type = 'correction'
          AND revision.reason_code = $5
          AND revision.result_schema_version = $6
          AND revision.scoring_rule_version = $7
          AND revision.canonical_complete_result_sha256 = $12
        WHERE result.round_id = $1
          AND result.initial_event_uuid = $2
          AND result.current_event_uuid = $3
          AND EXISTS (
            SELECT 1
              FROM content.map_version AS map_version
             WHERE map_version.id = $8
               AND map_version.map_id = $9
               AND EXISTS (
                 SELECT 1
                   FROM content.map_asset AS asset
                  WHERE asset.map_version_id = map_version.id
                    AND asset.kind = 'package'
                    AND asset.sha256 = $10
               )
          )
        ORDER BY revision.revision_number DESC
        LIMIT 1`,
      [
        event.data.round_id,
        event.data.original_event_id,
        event.data.supersedes_event_id,
        event.event_id,
        event.data.reason_code,
        replacement.result_schema,
        replacement.scoring_rules,
        replacement.map.version_id,
        replacement.map.map_id,
        replacement.map.content_sha256,
        replacement.server.build,
        replacement.result_sha256,
      ],
    );
    const projected = lookup.rows[0];
    if (projected?.revision_id === undefined) {
      return;
    }

    const inserted = await client.query<Record<string, never>>(
      `INSERT INTO hive_projection.match_result_change
        (event_uuid, projected_result_id, round_id, original_batch_uuid,
         original_event_uuid, supersedes_event_uuid, change_type, reason_code,
         replacement_result_revision_id, replacement_result_schema_version,
         replacement_scoring_rule_version, replacement_map_version_id,
         replacement_map_content_sha256, replacement_server_build_version,
         replacement_match_protocol_version, replacement_public_result_sha256)
       VALUES
        ($1, $2, $3, $4, $5, $6, 'correction', $7,
         $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (event_uuid) DO NOTHING`,
      [
        event.event_id,
        projected.id,
        event.data.round_id,
        event.data.original_batch_id,
        event.data.original_event_id,
        event.data.supersedes_event_id,
        event.data.reason_code,
        projected.revision_id,
        replacement.result_schema,
        replacement.scoring_rules,
        replacement.map.version_id,
        replacement.map.content_sha256,
        replacement.server.build,
        replacement.server.protocol,
        replacement.result_sha256,
      ],
    );
    if (inserted.rowCount === 0) {
      return;
    }
    await client.query<Record<string, never>>(
      `UPDATE hive_projection.match_result
          SET current_event_uuid = $2,
              current_state = 'corrected',
              matched_result_revision_id = $3,
              reconciliation_state = 'matched',
              reconciled_at = $4,
              divergence_detected_at = NULL,
              divergence_reason_code = NULL
        WHERE id = $1
          AND current_event_uuid = $5`,
      [
        projected.id,
        event.event_id,
        projected.revision_id,
        irreversibleAt,
        event.data.supersedes_event_id,
      ],
    );
  }

  private async materializeMatchInvalidation(
    client: SqlClientPort,
    event: Extract<HiveChameleonEvent, { type: 'match_result_invalidated' }>,
  ): Promise<void> {
    const lookup = await client.query<ProjectionIdentityRow>(
      `SELECT result.id
         FROM hive_projection.match_result AS result
        WHERE result.round_id = $1
          AND result.initial_event_uuid = $2
          AND result.current_event_uuid = $3
        LIMIT 1`,
      [event.data.round_id, event.data.original_event_id, event.data.supersedes_event_id],
    );
    const projected = lookup.rows[0];
    if (projected === undefined) {
      return;
    }
    const inserted = await client.query<Record<string, never>>(
      `INSERT INTO hive_projection.match_result_change
        (event_uuid, projected_result_id, round_id, original_batch_uuid,
         original_event_uuid, supersedes_event_uuid, change_type, reason_code)
       VALUES ($1, $2, $3, $4, $5, $6, 'invalidation', $7)
       ON CONFLICT (event_uuid) DO NOTHING`,
      [
        event.event_id,
        projected.id,
        event.data.round_id,
        event.data.original_batch_id,
        event.data.original_event_id,
        event.data.supersedes_event_id,
        event.data.reason_code,
      ],
    );
    if (inserted.rowCount === 0) {
      return;
    }
    await client.query<Record<string, never>>(
      `UPDATE hive_projection.match_result
          SET current_event_uuid = $2,
              current_state = 'invalidated'
        WHERE id = $1
          AND current_event_uuid = $3`,
      [projected.id, event.event_id, event.data.supersedes_event_id],
    );
  }

  private async materializeCollectibleIssue(
    client: SqlClientPort,
    operation: IrreversibleOperationRow,
    event: Extract<HiveChameleonEvent, { type: 'collectible_issued' }>,
    irreversibleAt: string,
  ): Promise<void> {
    if (operation.transaction_id === null) {
      return;
    }
    const inserted = await client.query<Record<string, never>>(
      `INSERT INTO hive_projection.collectible_event
        (event_id, operation_id, schema_version, event_type, collectible_id,
         collectible_definition_id, owner_hive_username, issuer_hive_username,
         metadata_uri, metadata_sha256, issuance_reason, payment_transaction_id,
         occurred_at, validation_state)
       SELECT $1, $2, $3, 'issued', $4,
              definition.id, player.hive_username, $5,
              $6, $7, $8, payment.id,
              $9, 'accepted'
         FROM commerce.collectible_definition AS definition
         JOIN identity.player AS player ON player.hive_username = $10
         LEFT JOIN commerce.payment_transaction AS payment
           ON payment.external_transaction_id = $11
        WHERE definition.definition_code = $12
          AND definition.kind::text = $13
          AND definition.metadata_uri = $6
          AND definition.metadata_sha256 = $7
          AND ($11::text IS NULL OR payment.id IS NOT NULL)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        event.event_id,
        operation.id,
        event.v,
        event.data.collectible_id,
        event.data.issuer,
        event.data.metadata_uri,
        event.data.metadata_sha256,
        event.data.reason,
        event.occurred_at,
        event.data.owner,
        event.data.payment_tx_id ?? null,
        event.data.definition_id,
        event.data.kind,
      ],
    );
    if (inserted.rowCount === 0) {
      return;
    }
    await client.query<Record<string, never>>(
      `INSERT INTO commerce.collectible_instance
        (id, collectible_definition_id, owner_player_id, issuer_hive_account,
         issuance_reason, metadata_uri, metadata_sha256, state, issued_event_id,
         issued_hive_transaction_id, issued_hive_block_number, irreversible_at,
         payment_transaction_id)
       SELECT event.collectible_id,
              event.collectible_definition_id,
              player.id,
              event.issuer_hive_username,
              event.issuance_reason,
              event.metadata_uri,
              event.metadata_sha256,
              'finalized',
              event.event_id,
              $2,
              $3,
              $4,
              event.payment_transaction_id
         FROM hive_projection.collectible_event AS event
         JOIN identity.player AS player
           ON player.hive_username = event.owner_hive_username
        WHERE event.event_id = $1
       ON CONFLICT (id) DO NOTHING`,
      [
        event.event_id,
        operation.transaction_id,
        parseDatabaseInteger(operation.block_number),
        irreversibleAt,
      ],
    );
  }

  private async materializeCollectibleRevocation(
    client: SqlClientPort,
    operation: IrreversibleOperationRow,
    event: Extract<HiveChameleonEvent, { type: 'collectible_revoked' }>,
  ): Promise<void> {
    const inserted = await client.query<Record<string, never>>(
      `INSERT INTO hive_projection.collectible_event
        (event_id, operation_id, schema_version, event_type, collectible_id,
         collectible_definition_id, owner_hive_username, issuer_hive_username,
         metadata_uri, metadata_sha256, issuance_reason, payment_transaction_id,
         occurred_at, validation_state)
       SELECT $1, $2, $3, 'revoked', issued.collectible_id,
              issued.collectible_definition_id, issued.owner_hive_username, $4,
              issued.metadata_uri, issued.metadata_sha256, issued.issuance_reason,
              issued.payment_transaction_id, $5, 'accepted'
         FROM hive_projection.collectible_event AS issued
         JOIN commerce.collectible_instance AS instance
           ON instance.id = issued.collectible_id
          AND instance.issued_event_id = issued.event_id
          AND instance.state = 'finalized'
        WHERE issued.event_id = $6
          AND issued.event_type = 'issued'
          AND issued.collectible_id = $7
       ON CONFLICT (event_id) DO NOTHING`,
      [
        event.event_id,
        operation.id,
        event.v,
        operation.primary_account,
        event.occurred_at,
        event.data.issued_event_id,
        event.data.collectible_id,
      ],
    );
    if (inserted.rowCount === 0) {
      return;
    }
    await client.query<Record<string, never>>(
      `UPDATE commerce.collectible_instance
          SET state = 'revoked',
              revoked_event_id = $2,
              revoked_at = $3
        WHERE id = $1
          AND issued_event_id = $4
          AND state = 'finalized'`,
      [event.data.collectible_id, event.event_id, event.occurred_at, event.data.issued_event_id],
    );
  }

  private nextUuidV7(): string {
    const value = this.options.nextUuidV7();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
      throw new HafProjectorError(
        'cursor_conflict',
        'ID provider did not return a lowercase UUIDv7',
      );
    }
    return value;
  }

  private async inTransaction(work: (client: SqlClientPort) => Promise<void>): Promise<void> {
    const client = await this.pool.connect();
    let released = false;
    try {
      await client.query<Record<string, never>>('BEGIN');
      await work(client);
      await client.query<Record<string, never>>('COMMIT');
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

type ProjectedMatchEvent = Extract<
  HiveChameleonEvent,
  {
    type: 'match_results_batch' | 'match_result_corrected' | 'match_result_invalidated';
  }
>;

function isMatchEvent(event: HiveChameleonEvent | undefined): event is ProjectedMatchEvent {
  return (
    event !== undefined &&
    (event.type === 'match_results_batch' ||
      event.type === 'match_result_corrected' ||
      event.type === 'match_result_invalidated')
  );
}

function matchEventFields(event: ProjectedMatchEvent): {
  readonly batchId: string | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly publisher: string;
  readonly resultCount: number;
} {
  if (event.type === 'match_results_batch') {
    return {
      batchId: event.data.batch_id,
      periodStart: event.data.period_start,
      periodEnd: event.data.period_end,
      publisher: event.data.publisher,
      resultCount: event.data.result_count,
    };
  }
  return {
    batchId: null,
    periodStart: null,
    periodEnd: null,
    publisher: event.data.publisher,
    resultCount: 1,
  };
}

function eventFromOperationPayload(payload: unknown): HiveChameleonEvent {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HafProjectorError('cursor_conflict', 'Accepted operation payload is not an object');
  }
  const serialized = (payload as Record<string, unknown>).json;
  if (typeof serialized !== 'string') {
    throw new HafProjectorError(
      'cursor_conflict',
      'Accepted operation payload does not contain an event string',
    );
  }
  return parseHiveChameleonEvent(serialized);
}

function initialCursor(source: string): ProjectionCursor {
  return {
    source,
    lastProcessedBlock: 0,
    lastProcessedBlockId: null,
    lastIrreversibleBlock: 0,
  };
}

function cursorFromRow(row: CursorRow): ProjectionCursor {
  return {
    source: row.source,
    lastProcessedBlock: parseDatabaseInteger(row.last_processed_block),
    lastProcessedBlockId: row.block_id,
    lastIrreversibleBlock: parseDatabaseInteger(row.last_irreversible_block),
  };
}

function checkpointFromRow(row: CheckpointRow): BlockCheckpoint {
  return {
    source: row.source,
    number: parseDatabaseInteger(row.block_number),
    id: row.block_id,
    previousId: row.previous_block_id ?? '',
    timestamp: toIsoString(row.block_timestamp),
    state: row.state,
    includedAt: toIsoString(row.observed_at),
    ...(row.irreversible_at === null ? {} : { irreversibleAt: toIsoString(row.irreversible_at) }),
    ...(row.reverted_at === null ? {} : { revertedAt: toIsoString(row.reverted_at) }),
  };
}

function parseDatabaseInteger(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new HafProjectorError('cursor_conflict', 'Database returned an invalid block number');
  }
  return parsed;
}

function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new HafProjectorError('cursor_conflict', 'Database returned an invalid timestamp');
  }
  return date.toISOString();
}

function sanitizeEndpointIdentity(value: string): string {
  const url = new URL(value);
  if (url.username !== '' || url.password !== '') {
    throw new HafProjectorError(
      'cursor_conflict',
      'Endpoint identity must not include credentials',
    );
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}
