import { createUuidV7, type DatabasePool, withTransaction } from '@hive-chameleon/database';

import type {
  CustodyKeyReference,
  ProvisioningJob,
  ProvisioningRepository,
  ProvisioningState,
} from './provisioning.types';

interface JobRow {
  external_identity_id: string;
  id: string;
  idempotency_key: string;
  requested_hive_username: string;
  sponsor_hive_account: string;
  sponsor_policy_version: string;
  sponsor_program: string;
  state: ProvisioningState;
}

interface KeyRow {
  authority_role: CustodyKeyReference['authorityRole'];
  custody_provider_key_reference: string;
  hive_public_key: string;
}

export class PostgresProvisioningRepository implements ProvisioningRepository {
  public constructor(private readonly pool: DatabasePool) {}

  public async getJobForUpdate(provisioningId: string): Promise<ProvisioningJob | null> {
    const result = await this.pool.query<JobRow>(
      `SELECT id, external_identity_id, idempotency_key, requested_hive_username,
              sponsor_hive_account, sponsor_policy_version, sponsor_program, state
         FROM identity.hive_account_provisioning
        WHERE id = $1`,
      [provisioningId],
    );
    const row = result.rows[0];
    return row ? mapJob(row) : null;
  }

  public async getKeys(provisioningId: string): Promise<readonly CustodyKeyReference[]> {
    const result = await this.pool.query<KeyRow>(
      `SELECT authority_role, hive_public_key, custody_provider_key_reference
         FROM identity.custody_key_reference
        WHERE provisioning_id = $1
          AND state IN ('generated', 'active')
        ORDER BY authority_role`,
      [provisioningId],
    );
    return result.rows.map((row) => ({
      authorityRole: row.authority_role,
      hivePublicKey: row.hive_public_key,
      providerKeyReference: row.custody_provider_key_reference,
    }));
  }

  public async saveKeys(
    provisioningId: string,
    keys: readonly CustodyKeyReference[],
    at: Date,
  ): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      for (const key of keys) {
        await client.query(
          `INSERT INTO identity.custody_key_reference (
             id, provisioning_id, authority_role, hive_public_key,
             custody_provider_key_reference, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (custody_provider_key_reference) DO NOTHING`,
          [
            createUuidV7(),
            provisioningId,
            key.authorityRole,
            key.hivePublicKey,
            key.providerKeyReference,
            at,
          ],
        );
      }
      const count = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM identity.custody_key_reference
          WHERE provisioning_id = $1 AND state = 'generated'`,
        [provisioningId],
      );
      if (count.rows[0]?.count !== '4') {
        throw new Error('Provisioning does not have exactly four generated keys.');
      }
      await client.query(
        `UPDATE identity.hive_account_provisioning
            SET state = 'keys_ready', keys_ready_at = COALESCE(keys_ready_at, $2),
                updated_at = $2, row_version = row_version + 1
          WHERE id = $1 AND state IN ('username_confirmed', 'keys_ready', 'retryable_failed')`,
        [provisioningId, at],
      );
    });
  }

  public async markAccountCreationPending(
    provisioningId: string,
    sponsorRequestReference: string,
    at: Date,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE identity.hive_account_provisioning
          SET state = 'account_creation_pending',
              sponsor_request_reference = COALESCE(sponsor_request_reference, $2),
              last_attempt_at = $3, attempt_count = attempt_count + 1,
              updated_at = $3, row_version = row_version + 1
        WHERE id = $1
          AND state IN ('keys_ready', 'account_creation_pending', 'retryable_failed')`,
      [provisioningId, sponsorRequestReference, at],
    );
  }

  public async markAccountCreated(
    provisioningId: string,
    transactionId: string,
    observedAt: Date,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE identity.hive_account_provisioning
          SET state = 'account_created',
              account_creation_transaction_id = COALESCE(account_creation_transaction_id, $2),
              account_observed_at = COALESCE(account_observed_at, $3),
              updated_at = $3, row_version = row_version + 1
        WHERE id = $1
          AND state IN ('account_creation_pending', 'account_created', 'retryable_failed')`,
      [provisioningId, transactionId, observedAt],
    );
  }

  public async markRcDelegationPending(provisioningId: string, at: Date): Promise<void> {
    await this.pool.query(
      `UPDATE identity.hive_account_provisioning
          SET state = 'rc_delegation_pending', updated_at = $2, row_version = row_version + 1
        WHERE id = $1
          AND state IN ('account_created', 'rc_delegation_pending', 'retryable_failed')`,
      [provisioningId, at],
    );
  }

  public async markRcDelegated(
    provisioningId: string,
    delegationReference: string,
    at: Date,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE identity.hive_account_provisioning
          SET state = 'rc_delegated', initial_rc_delegation_id = $2,
              updated_at = $3, row_version = row_version + 1
        WHERE id = $1
          AND state IN ('rc_delegation_pending', 'rc_delegated', 'retryable_failed')`,
      [provisioningId, delegationReference, at],
    );
  }

  public async markReady(provisioningId: string, at: Date): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const selected = await client.query<JobRow>(
        `SELECT id, external_identity_id, idempotency_key, requested_hive_username,
                sponsor_hive_account, sponsor_policy_version, sponsor_program, state
           FROM identity.hive_account_provisioning
          WHERE id = $1
          FOR UPDATE`,
        [provisioningId],
      );
      const job = selected.rows[0];
      if (!job) {
        throw new Error('Provisioning job disappeared before finalization.');
      }
      if (job.state === 'ready') {
        return;
      }
      const playerId = createUuidV7();
      const player = await client.query<{ id: string }>(
        `INSERT INTO identity.player (id, hive_username, hive_control_state)
         VALUES ($1, $2, 'platform_custodial')
         ON CONFLICT (hive_username) DO UPDATE SET hive_username = EXCLUDED.hive_username
         RETURNING id`,
        [playerId, job.requested_hive_username],
      );
      const resultingPlayerId = player.rows[0]?.id;
      if (!resultingPlayerId) {
        throw new Error('Provisioning could not create the playable identity.');
      }
      await client.query(
        `UPDATE identity.custody_key_reference
            SET player_id = $2, state = 'active', activated_at = COALESCE(activated_at, $3)
          WHERE provisioning_id = $1 AND state IN ('generated', 'active')`,
        [provisioningId, resultingPlayerId, at],
      );
      await client.query(
        `UPDATE identity.hive_account_provisioning
            SET resulting_player_id = $2, state = 'ready',
                account_irreversible_at = COALESCE(account_irreversible_at, $3),
                authorities_verified_at = COALESCE(authorities_verified_at, $3),
                rc_verified_at = COALESCE(rc_verified_at, $3),
                ready_at = COALESCE(ready_at, $3), updated_at = $3,
                last_failure_code = NULL, next_retry_at = NULL,
                row_version = row_version + 1
          WHERE id = $1 AND state IN ('rc_delegated', 'retryable_failed')`,
        [provisioningId, resultingPlayerId, at],
      );
      await client.query(
        `UPDATE identity.external_identity
            SET player_id = $2, status = 'linked', linked_at = COALESCE(linked_at, $3),
                updated_at = $3
          WHERE id = $1 AND status = 'provisioning'`,
        [job.external_identity_id, resultingPlayerId, at],
      );
    });
  }

  public async markRetryableFailure(
    provisioningId: string,
    safeFailureCode: string,
    at: Date,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE identity.hive_account_provisioning
          SET state = 'retryable_failed', last_failure_code = $2,
              next_retry_at = $3 + interval '30 seconds',
              updated_at = $3, row_version = row_version + 1
        WHERE id = $1 AND state NOT IN ('ready', 'terminal_failed')`,
      [provisioningId, safeFailureCode, at],
    );
  }
}

function mapJob(row: JobRow): ProvisioningJob {
  return {
    externalIdentityId: row.external_identity_id,
    id: row.id,
    idempotencyKey: row.idempotency_key,
    requestedHiveUsername: row.requested_hive_username,
    sponsorHiveAccount: row.sponsor_hive_account,
    sponsorPolicyVersion: row.sponsor_policy_version,
    sponsorProgram: row.sponsor_program,
    state: row.state,
  };
}
