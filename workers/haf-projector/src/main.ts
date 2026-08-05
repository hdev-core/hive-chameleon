import { createDatabasePool, createUuidV7 } from '@hive-chameleon/database';

import { loadHafProjectorConfig, ProjectorConfigurationError } from './config.js';
import {
  createJsonConsoleLogger,
  HafProjectorWorker,
  type ProjectorWorkerLogger,
} from './runtime/projector-worker.js';
import { HafahHttpSource } from './source/hafah-http-source.js';
import { PgProjectionPoolAdapter } from './store/pg-pool-adapter.js';
import { PostgresProjectionStore } from './store/postgres-projection-store.js';
import { ForkAwareHafProjector } from './sync/haf-projector.js';
import { HiveOperationValidator } from './validation/operation-validator.js';

async function run(): Promise<void> {
  const config = loadHafProjectorConfig(process.env);
  const logger = createJsonConsoleLogger();
  const pool = createDatabasePool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
  });
  const abortController = new AbortController();
  const removeSignalHandlers = registerSignalHandlers(abortController, logger);

  try {
    const projectionPool = new PgProjectionPoolAdapter(pool);
    const startupClient = await projectionPool.connect();
    try {
      await startupClient.query('SELECT 1');
    } finally {
      startupClient.release();
    }
    const source = new HafahHttpSource({
      sourceName: config.sourceName,
      hafahApiUrl: config.hafahApiUrl,
      hiveRpcUrl: config.hiveRpcUrl,
      operationTypeIds: config.operationTypeIds,
      pageSize: config.pageSize,
      timeoutMs: config.requestTimeoutMs,
    });
    const store = new PostgresProjectionStore(projectionPool, {
      endpointIdentity: config.hafahApiUrl,
      nextUuidV7: createUuidV7,
    });
    const validator = new HiveOperationValidator({
      collectibleIssuers: new Set(config.collectibleIssuers),
      maximumFutureClockSkewMs: config.maximumFutureClockSkewMs,
    });
    const projector = new ForkAwareHafProjector(source, store, validator, {
      maxBlocksPerRun: config.maxBlocksPerRun,
      maxReorgDepth: config.maxReorgDepth,
    });
    const worker = new HafProjectorWorker(
      projector,
      {
        pollIntervalMs: config.pollIntervalMs,
        initialFailureBackoffMs: config.initialFailureBackoffMs,
        maximumFailureBackoffMs: config.maximumFailureBackoffMs,
      },
      logger,
    );

    logger.info({ event: 'haf_projector_started', source: config.sourceName });
    await worker.run(abortController.signal);
    logger.info({ event: 'haf_projector_stopped', source: config.sourceName });
  } finally {
    removeSignalHandlers();
    await pool.end();
  }
}

function registerSignalHandlers(
  abortController: AbortController,
  logger: ProjectorWorkerLogger,
): () => void {
  const onSignal = (signal: NodeJS.Signals): void => {
    if (!abortController.signal.aborted) {
      logger.info({ event: 'haf_projector_shutdown_requested', signal });
      abortController.abort();
    }
  };
  const onSigint = (): void => onSignal('SIGINT');
  const onSigterm = (): void => onSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  return () => {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  };
}

void run().catch((error: unknown) => {
  // Runtime errors may include credentials or endpoint details. Configuration field names are
  // safe to expose, but values and arbitrary error messages are not.
  const detail =
    error instanceof ProjectorConfigurationError
      ? { errorCode: 'invalid_configuration', field: error.field }
      : { errorCode: 'startup_dependency_unavailable' };
  console.error(
    JSON.stringify({ level: 'error', event: 'haf_projector_startup_failed', ...detail }),
  );
  process.exitCode = 1;
});
