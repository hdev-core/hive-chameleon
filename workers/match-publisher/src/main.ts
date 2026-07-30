import { createDatabasePool, createUuidV7 } from '@hive-chameleon/database';
import {
  HiveGateway,
  HttpIsolatedSignerClient,
  WaxHiveChainAdapter,
  type OfficialServiceAuthorization,
} from '@hive-chameleon/hive-gateway';

import { loadMatchPublisherConfig, MatchPublisherConfigurationError } from './config.js';
import { createJsonConsoleLogger, MatchPublisherWorker } from './runtime/match-publisher-worker.js';
import { PgMatchPublisherPoolAdapter } from './store/pg-pool-adapter.js';
import { PostgresMatchPublicationStore } from './store/postgres-publication-store.js';

async function run(): Promise<void> {
  const config = loadMatchPublisherConfig(process.env);
  const logger = createJsonConsoleLogger();
  const pool = createDatabasePool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
  });
  const abortController = new AbortController();
  const removeSignalHandlers = registerSignalHandlers(abortController);

  try {
    const rolePool = new PgMatchPublisherPoolAdapter(pool);
    const roleCheck = await rolePool.connect();
    try {
      await roleCheck.query('SELECT 1');
    } finally {
      roleCheck.release();
    }
    const chain = new WaxHiveChainAdapter({
      apiEndpoint: config.hiveRpcUrl,
      chainId: config.hiveChainId,
      apiTimeoutMs: config.hiveApiTimeoutMs,
      ...(config.hiveRestApiUrl === undefined ? {} : { restApiEndpoint: config.hiveRestApiUrl }),
      waxApiCaller: 'hive-chameleon-match-publisher',
    });
    const authorization: OfficialServiceAuthorization = {
      mode: 'official_service',
      role: 'match_publisher',
      account: config.publisherAccount,
      authority: 'posting',
      expectedPublicKey: config.publisherPublicKey,
      signerKeyReference: config.signerKeyReference,
      policyVersion: config.signerPolicyVersion,
    };
    const worker = new MatchPublisherWorker(
      new PostgresMatchPublicationStore(rolePool),
      new HiveGateway(chain),
      new HttpIsolatedSignerClient({
        endpoint: config.signerUrl,
        bearerToken: config.signerBearerToken,
        timeoutMs: config.signerTimeoutMs,
      }),
      {
        authorization,
        batchPolicy: {
          publisherAccount: config.publisherAccount,
          maximumAgeMs: config.batchMaximumAgeMs,
          maximumResults: config.batchMaximumResults,
          maximumPayloadBytes: config.batchMaximumPayloadBytes,
          nextUuidV7: createUuidV7,
        },
        transactionExpirationSeconds: config.transactionExpirationSeconds,
        claimLeaseMs: config.claimLeaseMs,
        initialRetryBackoffMs: config.initialRetryBackoffMs,
        maximumRetryBackoffMs: config.maximumRetryBackoffMs,
        pollIntervalMs: config.pollIntervalMs,
        nextUuidV7: createUuidV7,
      },
      logger,
    );

    logger.info({ event: 'match_publisher_started' });
    await worker.run(abortController.signal);
    logger.info({ event: 'match_publisher_stopped' });
  } finally {
    removeSignalHandlers();
    await pool.end();
  }
}

function registerSignalHandlers(abortController: AbortController): () => void {
  const stop = (): void => abortController.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return () => {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  };
}

void run().catch((error: unknown) => {
  const detail =
    error instanceof MatchPublisherConfigurationError
      ? { errorCode: 'invalid_configuration', field: error.field }
      : { errorCode: 'startup_dependency_unavailable' };
  console.error(
    JSON.stringify({ level: 'error', event: 'match_publisher_startup_failed', ...detail }),
  );
  process.exitCode = 1;
});
