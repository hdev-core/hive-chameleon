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
        await this.insertOperation(client, checkpointId, decision, observedAt);
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
              operation.payload
         FROM hive_projection.operation AS operation
         JOIN hive_projection.block_checkpoint AS checkpoint
           ON checkpoint.id = operation.checkpoint_id
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
        case 'collectible_issued':
          await this.materializeCollectibleIssue(client, row, event, irreversibleAt);
          break;
        case 'collectible_revoked':
          await this.materializeCollectibleRevocation(client, row, event);
          break;
      }
    }
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
