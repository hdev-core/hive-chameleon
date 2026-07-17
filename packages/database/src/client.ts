import { Pool, type PoolClient, type PoolConfig } from 'pg';

export type TransactionIsolation = 'read committed' | 'repeatable read' | 'serializable';

export interface TransactionOptions {
  isolation?: TransactionIsolation;
  readOnly?: boolean;
}

export function createDatabasePool(config: PoolConfig): Pool {
  return new Pool({
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...config,
  });
}

export async function checkDatabaseConnection(pool: Pool): Promise<void> {
  await pool.query('SELECT 1');
}

export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const beginStatement = buildBeginStatement(options);
  const client = await pool.connect();
  let released = false;

  try {
    await client.query(beginStatement);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (!(await rollbackQuietly(client))) {
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

function buildBeginStatement(options: TransactionOptions): string {
  let isolationClause: string;

  switch (options.isolation ?? 'read committed') {
    case 'read committed':
      isolationClause = 'READ COMMITTED';
      break;
    case 'repeatable read':
      isolationClause = 'REPEATABLE READ';
      break;
    case 'serializable':
      isolationClause = 'SERIALIZABLE';
      break;
    default:
      throw new TypeError('Unsupported transaction isolation level');
  }

  return `BEGIN ISOLATION LEVEL ${isolationClause}${options.readOnly === true ? ' READ ONLY' : ''}`;
}

async function rollbackQuietly(client: PoolClient): Promise<boolean> {
  try {
    await client.query('ROLLBACK');
    return true;
  } catch {
    return false;
  }
}
