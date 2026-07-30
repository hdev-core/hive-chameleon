import { hiveAccountSchema } from '@hive-chameleon/hive-gateway/protocol';

export type MatchPublisherNodeEnvironment = 'development' | 'production' | 'test';

export interface MatchPublisherRuntimeConfig {
  readonly nodeEnvironment: MatchPublisherNodeEnvironment;
  readonly databaseUrl: string;
  readonly databasePoolMax: number;
  readonly databaseConnectionTimeoutMs: number;
  readonly hiveRpcUrl: string;
  readonly hiveRestApiUrl?: string;
  readonly hiveChainId: string;
  readonly hiveApiTimeoutMs: number;
  readonly publisherAccount: string;
  readonly publisherPublicKey: string;
  readonly signerKeyReference: string;
  readonly signerPolicyVersion: string;
  readonly signerUrl: string;
  readonly signerBearerToken: string;
  readonly signerTimeoutMs: number;
  readonly batchMaximumAgeMs: number;
  readonly batchMaximumResults: number;
  readonly batchMaximumPayloadBytes: number;
  readonly transactionExpirationSeconds: number;
  readonly claimLeaseMs: number;
  readonly pollIntervalMs: number;
  readonly initialRetryBackoffMs: number;
  readonly maximumRetryBackoffMs: number;
}

export class MatchPublisherConfigurationError extends Error {
  public override readonly name = 'MatchPublisherConfigurationError';

  public constructor(
    public readonly field: string,
    reason: string,
  ) {
    super(`Invalid match publisher configuration for ${field}: ${reason}`);
  }
}

export function loadMatchPublisherConfig(
  environment: Readonly<Record<string, string | undefined>>,
): MatchPublisherRuntimeConfig {
  const nodeEnvironment = parseNodeEnvironment(environment.NODE_ENV);
  const publisherAccount = required(environment, 'MATCH_PUBLISHER_HIVE_ACCOUNT');
  if (!hiveAccountSchema.safeParse(publisherAccount).success) {
    throw new MatchPublisherConfigurationError(
      'MATCH_PUBLISHER_HIVE_ACCOUNT',
      'expected a normalized Hive account',
    );
  }
  const initialRetryBackoffMs = integer(
    environment.MATCH_PUBLISHER_INITIAL_RETRY_BACKOFF_MS,
    'MATCH_PUBLISHER_INITIAL_RETRY_BACKOFF_MS',
    1_000,
    100,
    300_000,
  );
  const maximumRetryBackoffMs = integer(
    environment.MATCH_PUBLISHER_MAXIMUM_RETRY_BACKOFF_MS,
    'MATCH_PUBLISHER_MAXIMUM_RETRY_BACKOFF_MS',
    60_000,
    100,
    3_600_000,
  );
  if (maximumRetryBackoffMs < initialRetryBackoffMs) {
    throw new MatchPublisherConfigurationError(
      'MATCH_PUBLISHER_MAXIMUM_RETRY_BACKOFF_MS',
      'must not be less than the initial retry backoff',
    );
  }
  const signerBearerToken = required(environment, 'MATCH_PUBLISHER_SIGNER_BEARER_TOKEN');
  if (signerBearerToken.length < 32 || signerBearerToken.length > 4096) {
    throw new MatchPublisherConfigurationError(
      'MATCH_PUBLISHER_SIGNER_BEARER_TOKEN',
      'expected 32..4096 characters',
    );
  }

  return Object.freeze({
    nodeEnvironment,
    databaseUrl: databaseUrl(required(environment, 'DATABASE_URL'), nodeEnvironment),
    databasePoolMax: integer(
      environment.MATCH_PUBLISHER_DATABASE_POOL_MAX,
      'MATCH_PUBLISHER_DATABASE_POOL_MAX',
      10,
      1,
      100,
    ),
    databaseConnectionTimeoutMs: integer(
      environment.MATCH_PUBLISHER_DATABASE_CONNECTION_TIMEOUT_MS,
      'MATCH_PUBLISHER_DATABASE_CONNECTION_TIMEOUT_MS',
      5_000,
      100,
      120_000,
    ),
    hiveRpcUrl: httpsUrl(
      required(environment, 'MATCH_PUBLISHER_HIVE_RPC_URL'),
      'MATCH_PUBLISHER_HIVE_RPC_URL',
    ),
    ...(environment.MATCH_PUBLISHER_HIVE_REST_API_URL === undefined
      ? {}
      : {
          hiveRestApiUrl: httpsUrl(
            required(environment, 'MATCH_PUBLISHER_HIVE_REST_API_URL'),
            'MATCH_PUBLISHER_HIVE_REST_API_URL',
          ),
        }),
    hiveChainId: chainId(required(environment, 'MATCH_PUBLISHER_HIVE_CHAIN_ID')),
    hiveApiTimeoutMs: integer(
      environment.MATCH_PUBLISHER_HIVE_API_TIMEOUT_MS,
      'MATCH_PUBLISHER_HIVE_API_TIMEOUT_MS',
      5_000,
      100,
      120_000,
    ),
    publisherAccount,
    publisherPublicKey: bounded(
      required(environment, 'MATCH_PUBLISHER_PUBLIC_KEY'),
      'MATCH_PUBLISHER_PUBLIC_KEY',
      16,
      128,
    ),
    signerKeyReference: bounded(
      required(environment, 'MATCH_PUBLISHER_SIGNER_KEY_REFERENCE'),
      'MATCH_PUBLISHER_SIGNER_KEY_REFERENCE',
      1,
      256,
    ),
    signerPolicyVersion: policyVersion(
      required(environment, 'MATCH_PUBLISHER_SIGNER_POLICY_VERSION'),
      'MATCH_PUBLISHER_SIGNER_POLICY_VERSION',
    ),
    signerUrl: httpsUrl(
      required(environment, 'MATCH_PUBLISHER_SIGNER_URL'),
      'MATCH_PUBLISHER_SIGNER_URL',
    ),
    signerBearerToken,
    signerTimeoutMs: integer(
      environment.MATCH_PUBLISHER_SIGNER_TIMEOUT_MS,
      'MATCH_PUBLISHER_SIGNER_TIMEOUT_MS',
      5_000,
      100,
      120_000,
    ),
    batchMaximumAgeMs: integer(
      environment.MATCH_PUBLISHER_BATCH_MAXIMUM_AGE_MS,
      'MATCH_PUBLISHER_BATCH_MAXIMUM_AGE_MS',
      300_000,
      1_000,
      3_600_000,
    ),
    batchMaximumResults: integer(
      environment.MATCH_PUBLISHER_BATCH_MAXIMUM_RESULTS,
      'MATCH_PUBLISHER_BATCH_MAXIMUM_RESULTS',
      20,
      1,
      20,
    ),
    batchMaximumPayloadBytes: integer(
      environment.MATCH_PUBLISHER_BATCH_MAXIMUM_PAYLOAD_BYTES,
      'MATCH_PUBLISHER_BATCH_MAXIMUM_PAYLOAD_BYTES',
      6 * 1024,
      512,
      6 * 1024,
    ),
    transactionExpirationSeconds: integer(
      environment.MATCH_PUBLISHER_TRANSACTION_EXPIRATION_SECONDS,
      'MATCH_PUBLISHER_TRANSACTION_EXPIRATION_SECONDS',
      300,
      10,
      3_600,
    ),
    claimLeaseMs: integer(
      environment.MATCH_PUBLISHER_CLAIM_LEASE_MS,
      'MATCH_PUBLISHER_CLAIM_LEASE_MS',
      120_000,
      1_000,
      3_600_000,
    ),
    pollIntervalMs: integer(
      environment.MATCH_PUBLISHER_POLL_INTERVAL_MS,
      'MATCH_PUBLISHER_POLL_INTERVAL_MS',
      1_000,
      100,
      300_000,
    ),
    initialRetryBackoffMs,
    maximumRetryBackoffMs,
  });
}

function required(
  environment: Readonly<Record<string, string | undefined>>,
  field: string,
): string {
  const value = environment[field]?.trim();
  if (value === undefined || value === '') {
    throw new MatchPublisherConfigurationError(field, 'value is required');
  }
  return value;
}

function parseNodeEnvironment(value: string | undefined): MatchPublisherNodeEnvironment {
  const normalized = value ?? 'development';
  if (normalized !== 'development' && normalized !== 'production' && normalized !== 'test') {
    throw new MatchPublisherConfigurationError(
      'NODE_ENV',
      'expected development, production, or test',
    );
  }
  return normalized;
}

function databaseUrl(value: string, environment: MatchPublisherNodeEnvironment): string {
  const url = parseUrl(value, 'DATABASE_URL');
  if (
    (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') ||
    url.hostname === '' ||
    url.pathname === '' ||
    url.pathname === '/' ||
    url.hash !== ''
  ) {
    throw new MatchPublisherConfigurationError('DATABASE_URL', 'expected a PostgreSQL URL');
  }
  if (environment === 'production') {
    const sslMode = url.searchParams.get('sslmode');
    if (sslMode !== 'require' && sslMode !== 'verify-ca' && sslMode !== 'verify-full') {
      throw new MatchPublisherConfigurationError(
        'DATABASE_URL',
        'production requires PostgreSQL TLS',
      );
    }
  }
  return value;
}

function httpsUrl(value: string, field: string): string {
  const url = parseUrl(value, field);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new MatchPublisherConfigurationError(
      field,
      'expected HTTPS without credentials, query, or fragment',
    );
  }
  return url.toString();
}

function parseUrl(value: string, field: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new MatchPublisherConfigurationError(field, 'expected an absolute URL');
  }
}

function integer(
  value: string | undefined,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const normalized = value ?? String(fallback);
  if (!/^(0|[1-9][0-9]*)$/.test(normalized)) {
    throw new MatchPublisherConfigurationError(field, 'expected a base-10 integer');
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new MatchPublisherConfigurationError(field, `expected ${minimum}..${maximum}`);
  }
  return parsed;
}

function chainId(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new MatchPublisherConfigurationError(
      'MATCH_PUBLISHER_HIVE_CHAIN_ID',
      'expected 32 lowercase hexadecimal bytes',
    );
  }
  return value;
}

function bounded(value: string, field: string, minimum: number, maximum: number): string {
  if (value.length < minimum || value.length > maximum) {
    throw new MatchPublisherConfigurationError(field, `expected ${minimum}..${maximum} characters`);
  }
  return value;
}

function policyVersion(value: string, field: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(value)) {
    throw new MatchPublisherConfigurationError(field, 'expected a lowercase policy version');
  }
  return value;
}
