import type { Pool, PoolClient } from 'pg';

import type { CollectibleIssuerJournal } from './journal.js';
import type { CollectibleSigningRecord } from './model.js';

const COLLECTIBLE_ISSUER_DATABASE_ROLE = 'hc_collectible_issuer';

export class PostgresCollectibleIssuerJournal implements CollectibleIssuerJournal {
  public constructor(private readonly pool: Pool) {}

  public async recordPrepared(record: CollectibleSigningRecord): Promise<void> {
    const client = await this.connect();
    try {
      await client.query(
        `INSERT INTO hive_projection.transaction_intent
          (id, idempotency_key, operation_kind, required_authority,
           canonical_operation_hash, authorization_mode, official_service_role,
           allowlist_policy_version, authorization_validated_at, state,
           requested_at, expires_at, hive_transaction_id)
         VALUES
          ($1, $2, $3, 'posting', $4, 'official_service', 'collectible_issuer',
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
    recordId: string,
    transactionId: string,
    broadcastAt: string,
  ): Promise<void> {
    await this.update(recordId, transactionId, 'broadcast', null, broadcastAt);
  }

  public async markFailed(
    recordId: string,
    transactionId: string,
    failureCode: string,
    failedAt: string,
  ): Promise<void> {
    await this.update(recordId, transactionId, 'failed', stableFailureCode(failureCode), failedAt);
  }

  private async update(
    recordId: string,
    transactionId: string,
    state: 'broadcast' | 'failed',
    failureCode: string | null,
    updatedAt: string,
  ): Promise<void> {
    const client = await this.connect();
    try {
      await client.query(
        `UPDATE hive_projection.transaction_intent
            SET state = $2,
                hive_transaction_id = $3,
                failure_code = $4,
                updated_at = $5
          WHERE id = $1`,
        [recordId, state, transactionId, failureCode, updatedAt],
      );
    } finally {
      client.release();
    }
  }

  private async connect(): Promise<PoolClient> {
    const client = await this.pool.connect();
    try {
      await client.query(`SET ROLE ${COLLECTIBLE_ISSUER_DATABASE_ROLE}`);
      const result = await client.query<{ current_role: string }>('SELECT current_role');
      if (result.rows[0]?.current_role !== COLLECTIBLE_ISSUER_DATABASE_ROLE) {
        throw new Error('PostgreSQL did not activate the collectible-issuer workload role');
      }
      return client;
    } catch (error: unknown) {
      client.release(true);
      throw new Error('Collectible issuer database role is unavailable', { cause: error });
    }
  }
}

function stableFailureCode(value: string): string {
  return /^[a-z][a-z0-9_]{1,63}$/.test(value) ? value : 'publication_failed';
}
