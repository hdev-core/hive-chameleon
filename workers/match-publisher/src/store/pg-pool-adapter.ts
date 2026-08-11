import type { Pool, PoolClient } from 'pg';

import { MatchPublisherError } from '../errors.js';
import type { SqlClientPort, SqlPoolPort, SqlQueryResult } from './postgres-publication-store.js';

const MATCH_PUBLISHER_DATABASE_ROLE = 'hc_match_publisher';

interface CurrentRoleRow extends Record<string, unknown> {
  readonly current_role: string;
}

export class PgMatchPublisherPoolAdapter implements SqlPoolPort {
  public constructor(private readonly pool: Pool) {}

  public async connect(): Promise<SqlClientPort> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error: unknown) {
      throw unavailable(error);
    }
    try {
      await client.query(`SET ROLE ${MATCH_PUBLISHER_DATABASE_ROLE}`);
      const result = await client.query<CurrentRoleRow>('SELECT current_role');
      if (result.rows[0]?.current_role !== MATCH_PUBLISHER_DATABASE_ROLE) {
        throw new Error('PostgreSQL did not activate the match-publisher workload role');
      }
      return new PgMatchPublisherClientAdapter(client);
    } catch (error: unknown) {
      client.release(true);
      throw unavailable(error);
    }
  }
}

class PgMatchPublisherClientAdapter implements SqlClientPort {
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

function unavailable(cause: unknown): MatchPublisherError {
  return new MatchPublisherError(
    'database_unavailable',
    'PostgreSQL match-publisher workload role could not be established',
    { cause },
  );
}
