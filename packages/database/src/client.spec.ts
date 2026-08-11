import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { createDatabasePool, withTransaction, type TransactionOptions } from './client.js';

function databaseDouble(query: PoolClient['query'] = vi.fn().mockResolvedValue({})) {
  const client = {
    query,
    release: vi.fn(),
  } as unknown as PoolClient;
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool;

  return { client, pool };
}

describe('withTransaction', () => {
  it('uses a fixed isolation statement and commits before release', async () => {
    const { client, pool } = databaseDouble();

    const result = await withTransaction(
      pool,
      async (transaction) => {
        expect(transaction).toBe(client);
        return 'committed';
      },
      { isolation: 'repeatable read', readOnly: true },
    );

    expect(result).toBe('committed');
    expect(client.query).toHaveBeenNthCalledWith(
      1,
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    expect(client.query).toHaveBeenNthCalledWith(2, 'COMMIT');
    expect(client.release).toHaveBeenCalledWith();
  });

  it('rolls back and releases a healthy connection when work fails', async () => {
    const { client, pool } = databaseDouble();
    const failure = new Error('work failed');

    await expect(
      withTransaction(pool, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(client.query).toHaveBeenNthCalledWith(1, 'BEGIN ISOLATION LEVEL READ COMMITTED');
    expect(client.query).toHaveBeenNthCalledWith(2, 'ROLLBACK');
    expect(client.release).toHaveBeenCalledWith();
  });

  it('destroys a connection when rollback itself fails', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('connection lost'));
    const { client, pool } = databaseDouble(query);

    await expect(
      withTransaction(pool, async () => {
        throw new Error('work failed');
      }),
    ).rejects.toThrow('work failed');

    expect(client.release).toHaveBeenCalledWith(true);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rejects an untrusted isolation value before acquiring a connection', async () => {
    const { pool } = databaseDouble();
    const untrusted = {
      isolation: 'read committed; DROP SCHEMA public CASCADE',
    } as unknown as TransactionOptions;

    await expect(withTransaction(pool, async () => undefined, untrusted)).rejects.toThrow(
      'Unsupported transaction isolation level',
    );
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe('createDatabasePool', () => {
  it('keeps an idle-client backend error non-fatal instead of crashing the process', async () => {
    const pool = createDatabasePool({
      // A port with no listener: the pool is never actually dialed here, so the
      // test only asserts the default 'error' listener the factory installs.
      connectionString: 'postgres://unused:unused@127.0.0.1:1/unused',
    });
    try {
      expect(pool.listenerCount('error')).toBeGreaterThanOrEqual(1);

      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      // Emitting 'error' with no listener would throw here (Node's unhandled
      // 'error' semantics); with the factory's listener it is swallowed + logged.
      expect(() =>
        pool.emit('error', new Error('terminating connection due to administrator command')),
      ).not.toThrow();
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('database_pool_idle_client_error'),
      );
      stderr.mockRestore();
    } finally {
      await pool.end();
    }
  });
});
