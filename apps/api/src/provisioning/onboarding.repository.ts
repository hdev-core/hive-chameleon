import { createUuidV7, type DatabasePool, withTransaction } from '@hive-chameleon/database';
import { ServiceUnavailableException } from '@nestjs/common';

import type { OnboardingConfig } from './onboarding.config';
import type { ProvisioningJob, ProvisioningState } from './provisioning.types';

interface ProvisioningRow {
  external_identity_id: string;
  id: string;
  idempotency_key: string;
  last_failure_code: string | null;
  next_retry_at: Date | null;
  requested_hive_username: string;
  sponsor_hive_account: string;
  sponsor_policy_version: string;
  sponsor_program: string;
  state: ProvisioningState;
  updated_at: Date;
}

export interface ProvisioningStatus extends ProvisioningJob {
  readonly retryAfter: string | null;
  readonly safeFailureCode: string | null;
  readonly updatedAt: string;
}

export class PostgresOnboardingRepository {
  public constructor(private readonly pool: DatabasePool | null) {}

  public async isUsernamePending(hiveUsername: string): Promise<boolean> {
    const result = await this.requirePool().query(
      `SELECT 1
         FROM identity.hive_account_provisioning
        WHERE requested_hive_username = $1
          AND (state <> 'terminal_failed' OR account_observed_at IS NOT NULL)
        LIMIT 1`,
      [hiveUsername],
    );
    return result.rowCount === 1;
  }

  public async confirmUsername(input: {
    readonly config: OnboardingConfig;
    readonly externalIdentityId: string;
    readonly hiveUsername: string;
    readonly idempotencyKey: string;
    readonly now: Date;
  }): Promise<ProvisioningStatus> {
    return withTransaction(this.requirePool(), async (client) => {
      const identity = await client.query<{ status: string }>(
        `SELECT status
           FROM identity.external_identity
          WHERE id = $1
          FOR UPDATE`,
        [input.externalIdentityId],
      );
      if (identity.rows[0]?.status !== 'provisioning') {
        throw new Error('Onboarding identity is not available for provisioning.');
      }
      const existing = await client.query<ProvisioningRow>(
        `SELECT * FROM identity.hive_account_provisioning WHERE external_identity_id = $1`,
        [input.externalIdentityId],
      );
      const current = existing.rows[0];
      if (current) {
        if (current.requested_hive_username !== input.hiveUsername) {
          throw new Error('A different permanent Hive username is already confirmed.');
        }
        return mapStatus(current);
      }
      const inserted = await client.query<ProvisioningRow>(
        `INSERT INTO identity.hive_account_provisioning (
           id, external_identity_id, idempotency_key, requested_hive_username,
           sponsor_program, sponsor_policy_version, sponsor_hive_account,
           username_confirmed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          createUuidV7(),
          input.externalIdentityId,
          input.idempotencyKey,
          input.hiveUsername,
          input.config.sponsorProgram,
          input.config.sponsorPolicyVersion,
          input.config.sponsorHiveAccount,
          input.now,
        ],
      );
      return mapStatus(requireRow(inserted.rows[0]));
    });
  }

  public async findForIdentity(externalIdentityId: string): Promise<ProvisioningStatus | null> {
    const result = await this.requirePool().query<ProvisioningRow>(
      `SELECT *
         FROM identity.hive_account_provisioning
        WHERE external_identity_id = $1`,
      [externalIdentityId],
    );
    const row = result.rows[0];
    return row ? mapStatus(row) : null;
  }

  public async findByIdForIdentity(
    provisioningId: string,
    externalIdentityId: string,
  ): Promise<ProvisioningStatus | null> {
    const result = await this.requirePool().query<ProvisioningRow>(
      `SELECT *
         FROM identity.hive_account_provisioning
        WHERE id = $1 AND external_identity_id = $2`,
      [provisioningId, externalIdentityId],
    );
    const row = result.rows[0];
    return row ? mapStatus(row) : null;
  }

  private requirePool(): DatabasePool {
    if (!this.pool) {
      throw new ServiceUnavailableException({
        code: 'identity_store_unavailable',
        detail: 'Onboarding is unavailable because the identity store is not configured.',
        status: 503,
        title: 'Onboarding unavailable',
      });
    }
    return this.pool;
  }
}

function mapStatus(row: ProvisioningRow): ProvisioningStatus {
  return {
    externalIdentityId: row.external_identity_id,
    id: row.id,
    idempotencyKey: row.idempotency_key,
    requestedHiveUsername: row.requested_hive_username,
    retryAfter: row.next_retry_at?.toISOString() ?? null,
    safeFailureCode: row.last_failure_code,
    sponsorHiveAccount: row.sponsor_hive_account,
    sponsorPolicyVersion: row.sponsor_policy_version,
    sponsorProgram: row.sponsor_program,
    state: row.state,
    updatedAt: row.updated_at.toISOString(),
  };
}

function requireRow<T>(row: T | undefined): T {
  if (!row) {
    throw new Error('The identity store did not return the expected row.');
  }
  return row;
}
