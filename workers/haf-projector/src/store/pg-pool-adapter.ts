import type { Pool, PoolClient } from 'pg';

import { HafProjectorError } from '../errors.js';
import type { SqlClientPort, SqlPoolPort, SqlQueryResult } from './postgres-projection-store.js';

const PROJECTOR_DATABASE_ROLE = 'hc_projector';

interface CurrentRoleRow extends Record<string, unknown> {
  readonly current_role: string;
}

export class PgProjectionPoolAdapter implements SqlPoolPort {
  public constructor(private readonly pool: Pool) {}

  public async connect(): Promise<SqlClientPort> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error: unknown) {
      throw databaseUnavailable(error);
    }

    try {
      await client.query(`SET ROLE ${PROJECTOR_DATABASE_ROLE}`);
      const result = await client.query<CurrentRoleRow>('SELECT current_role');
      if (result.rows[0]?.current_role !== PROJECTOR_DATABASE_ROLE) {
        throw new Error('PostgreSQL did not activate the projector workload role');
      }
      return new PgProjectionClientAdapter(client);
    } catch (error: unknown) {
      try {
        client.release(true);
      } catch {
        // The connection was already unusable; preserve the stable boundary error.
      }
      throw databaseUnavailable(error);
    }
  }
}

class PgProjectionClientAdapter implements SqlClientPort {
  public constructor(private readonly client: PoolClient) {}

  public async query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>> {
    const result = await this.client.query<Row>(text, values === undefined ? [] : [...values]);
    return { rows: result.rows, rowCount: result.rowCount };
  }

  public release(destroy = false): void {
    this.client.release(destroy);
  }
}

function databaseUnavailable(cause: unknown): HafProjectorError {
  return new HafProjectorError(
    'database_unavailable',
    'PostgreSQL projector workload role could not be established',
    { cause },
  );
}
