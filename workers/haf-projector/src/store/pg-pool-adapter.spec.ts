import type { Pool, PoolClient, QueryResult } from 'pg';
import { describe, expect, it } from 'vitest';

import { PgProjectionPoolAdapter } from './pg-pool-adapter.js';

describe('PostgreSQL projection pool adapter', () => {
  it('pins and verifies the projector role before exposing a checked-out client', async () => {
    const client = new RecordingPoolClient('hc_projector');
    const adapter = new PgProjectionPoolAdapter(poolReturning(client));

    const checkedOut = await adapter.connect();
    await checkedOut.query('SELECT 1');
    checkedOut.release();

    expect(client.statements).toEqual(['SET ROLE hc_projector', 'SELECT current_role', 'SELECT 1']);
    expect(client.releaseFlags).toEqual([false]);
  });

  it('destroys a connection when PostgreSQL does not activate the projector role', async () => {
    const client = new RecordingPoolClient('deployment_login');
    const adapter = new PgProjectionPoolAdapter(poolReturning(client));

    await expect(adapter.connect()).rejects.toMatchObject({ code: 'database_unavailable' });

    expect(client.statements).toEqual(['SET ROLE hc_projector', 'SELECT current_role']);
    expect(client.releaseFlags).toEqual([true]);
  });

  it('destroys a connection when SET ROLE fails', async () => {
    const client = new RecordingPoolClient('deployment_login', true);
    const adapter = new PgProjectionPoolAdapter(poolReturning(client));

    await expect(adapter.connect()).rejects.toMatchObject({ code: 'database_unavailable' });

    expect(client.statements).toEqual(['SET ROLE hc_projector']);
    expect(client.releaseFlags).toEqual([true]);
  });
});

class RecordingPoolClient {
  public readonly statements: string[] = [];
  public readonly releaseFlags: boolean[] = [];

  public constructor(
    private readonly currentRole: string,
    private readonly failSetRole = false,
  ) {}

  public async query<Row extends Record<string, unknown>>(text: string): Promise<QueryResult<Row>> {
    this.statements.push(text);
    if (text === 'SET ROLE hc_projector' && this.failSetRole) {
      throw new Error('permission denied');
    }
    const rows =
      text === 'SELECT current_role'
        ? ([{ current_role: this.currentRole }] as unknown as Row[])
        : [];
    return { rows, rowCount: rows.length } as QueryResult<Row>;
  }

  public release(destroy = false): void {
    this.releaseFlags.push(destroy);
  }
}

function poolReturning(client: RecordingPoolClient): Pool {
  return {
    connect: async () => client as unknown as PoolClient,
  } as unknown as Pool;
}
