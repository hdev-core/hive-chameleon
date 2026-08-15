import { Pool, type PoolClient, type PoolConfig } from 'pg';

export type DatabasePool = Pool;

export type TransactionIsolation = 'read committed' | 'repeatable read' | 'serializable';

export interface TransactionOptions {
  isolation?: TransactionIsolation;
  readOnly?: boolean;
}

export function createDatabasePool(config: PoolConfig): Pool {
  const pool = new Pool({
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...config,
  });

  // `pg` emits 'error' on the Pool when an *idle* backend connection fails
  // (e.g. Postgres restarts and sends "terminating connection due to
  // administrator command"). With no listener, Node treats it as an unhandled
  // 'error' event and crashes the whole process — which silently stranded the
  // publication workers whenever the database bounced. A default listener keeps
  // the drop non-fatal: pg evicts the broken client and the next `connect()`
  // dials a fresh one. Callers may still attach their own 'error' listeners for
  // richer handling; pg supports multiple.
  pool.on('error', (error: Error) => {
    process.stderr.write(
      `${JSON.stringify({
        level: 'warn',
        event: 'database_pool_idle_client_error',
        message: error.message,
      })}\n`,
    );
  });

  return pool;
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
