import { hiveAccountSchema } from '@hive-chameleon/hive-gateway/protocol';

export type ProjectorNodeEnvironment = 'development' | 'production' | 'test';

export interface HafProjectorRuntimeConfig {
  readonly nodeEnvironment: ProjectorNodeEnvironment;
  readonly databaseUrl: string;
  readonly databasePoolMax: number;
  readonly databaseConnectionTimeoutMs: number;
  readonly sourceName: string;
  readonly hafahApiUrl: string;
  readonly hiveRpcUrl: string;
  readonly operationTypeIds: readonly number[];
  readonly matchPublishers: readonly string[];
  readonly collectibleIssuers: readonly string[];
  readonly pageSize: number;
  readonly requestTimeoutMs: number;
  readonly maxBlocksPerRun: number;
  readonly maxReorgDepth: number;
  readonly maximumFutureClockSkewMs: number;
  readonly pollIntervalMs: number;
  readonly initialFailureBackoffMs: number;
  readonly maximumFailureBackoffMs: number;
}

export class ProjectorConfigurationError extends Error {
  public override readonly name = 'ProjectorConfigurationError';

  public constructor(
    public readonly field: string,
    reason: string,
  ) {
    super(`Invalid projector configuration for ${field}: ${reason}`);
  }
}

export function loadHafProjectorConfig(
  environment: Readonly<Record<string, string | undefined>>,
): HafProjectorRuntimeConfig {
  const nodeEnvironment = parseNodeEnvironment(environment.NODE_ENV);
  const databaseUrl = parseDatabaseUrl(required(environment, 'DATABASE_URL'), nodeEnvironment);
  const hafahApiUrl = parseHttpsUrl(
    required(environment, 'HAF_PROJECTOR_HAFAH_API_URL'),
    'HAF_PROJECTOR_HAFAH_API_URL',
  );
  const hiveRpcUrl = parseHttpsUrl(
    required(environment, 'HAF_PROJECTOR_HIVE_RPC_URL'),
    'HAF_PROJECTOR_HIVE_RPC_URL',
  );
  const sourceName = required(environment, 'HAF_PROJECTOR_SOURCE_NAME');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(sourceName)) {
    throw new ProjectorConfigurationError(
      'HAF_PROJECTOR_SOURCE_NAME',
      'expected a lowercase source/network identity',
    );
  }

  const initialFailureBackoffMs = parseInteger(
    environment.HAF_PROJECTOR_INITIAL_FAILURE_BACKOFF_MS,
    'HAF_PROJECTOR_INITIAL_FAILURE_BACKOFF_MS',
    1_000,
    100,
    300_000,
  );
  const maximumFailureBackoffMs = parseInteger(
    environment.HAF_PROJECTOR_MAXIMUM_FAILURE_BACKOFF_MS,
    'HAF_PROJECTOR_MAXIMUM_FAILURE_BACKOFF_MS',
    30_000,
    100,
    900_000,
  );
  if (maximumFailureBackoffMs < initialFailureBackoffMs) {
    throw new ProjectorConfigurationError(
      'HAF_PROJECTOR_MAXIMUM_FAILURE_BACKOFF_MS',
      'must be greater than or equal to the initial failure backoff',
    );
  }

  return Object.freeze({
    nodeEnvironment,
    databaseUrl,
    databasePoolMax: parseInteger(
      environment.HAF_PROJECTOR_DATABASE_POOL_MAX,
      'HAF_PROJECTOR_DATABASE_POOL_MAX',
      10,
      1,
      100,
    ),
    databaseConnectionTimeoutMs: parseInteger(
      environment.HAF_PROJECTOR_DATABASE_CONNECTION_TIMEOUT_MS,
      'HAF_PROJECTOR_DATABASE_CONNECTION_TIMEOUT_MS',
      5_000,
      100,
      120_000,
    ),
    sourceName,
    hafahApiUrl,
    hiveRpcUrl,
    operationTypeIds: Object.freeze(
      parseIntegerList(
        required(environment, 'HAF_PROJECTOR_OPERATION_TYPE_IDS'),
        'HAF_PROJECTOR_OPERATION_TYPE_IDS',
      ),
    ),
    matchPublishers: Object.freeze(
      parseAccountList(
        required(environment, 'HAF_PROJECTOR_MATCH_PUBLISHERS', true),
        'HAF_PROJECTOR_MATCH_PUBLISHERS',
      ),
    ),
    collectibleIssuers: Object.freeze(
      parseAccountList(
        required(environment, 'HAF_PROJECTOR_COLLECTIBLE_ISSUERS', true),
        'HAF_PROJECTOR_COLLECTIBLE_ISSUERS',
      ),
    ),
    pageSize: parseInteger(
      environment.HAF_PROJECTOR_PAGE_SIZE,
      'HAF_PROJECTOR_PAGE_SIZE',
      1_000,
      1,
      10_000,
    ),
    requestTimeoutMs: parseInteger(
      environment.HAF_PROJECTOR_REQUEST_TIMEOUT_MS,
      'HAF_PROJECTOR_REQUEST_TIMEOUT_MS',
      5_000,
      100,
      120_000,
    ),
    maxBlocksPerRun: parseInteger(
      environment.HAF_PROJECTOR_MAX_BLOCKS_PER_RUN,
      'HAF_PROJECTOR_MAX_BLOCKS_PER_RUN',
      50,
      1,
      10_000,
    ),
    maxReorgDepth: parseInteger(
      environment.HAF_PROJECTOR_MAX_REORG_DEPTH,
      'HAF_PROJECTOR_MAX_REORG_DEPTH',
      200,
      1,
      10_000,
    ),
    maximumFutureClockSkewMs: parseInteger(
      environment.HAF_PROJECTOR_MAXIMUM_FUTURE_CLOCK_SKEW_MS,
      'HAF_PROJECTOR_MAXIMUM_FUTURE_CLOCK_SKEW_MS',
      300_000,
      0,
      3_600_000,
    ),
    pollIntervalMs: parseInteger(
      environment.HAF_PROJECTOR_POLL_INTERVAL_MS,
      'HAF_PROJECTOR_POLL_INTERVAL_MS',
      1_000,
      100,
      300_000,
    ),
    initialFailureBackoffMs,
    maximumFailureBackoffMs,
  });
}

function required(
  environment: Readonly<Record<string, string | undefined>>,
  field: string,
  allowEmpty = false,
): string {
  const value = environment[field];
  if (value === undefined || (!allowEmpty && value.trim() === '')) {
    throw new ProjectorConfigurationError(field, 'value is required');
  }
  return value.trim();
}

function parseNodeEnvironment(value: string | undefined): ProjectorNodeEnvironment {
  const normalized = value ?? 'development';
  if (normalized !== 'development' && normalized !== 'production' && normalized !== 'test') {
    throw new ProjectorConfigurationError('NODE_ENV', 'expected development, production, or test');
  }
  return normalized;
}

function parseHttpsUrl(value: string, field: string): string {
  const url = parseUrl(value, field);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new ProjectorConfigurationError(
      field,
      'expected an HTTPS URL without credentials, query, or fragment',
    );
  }
  return url.toString();
}

function parseDatabaseUrl(value: string, nodeEnvironment: ProjectorNodeEnvironment): string {
  const field = 'DATABASE_URL';
  const url = parseUrl(value, field);
  if (
    (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') ||
    url.hostname === '' ||
    url.pathname === '' ||
    url.pathname === '/' ||
    url.hash !== ''
  ) {
    throw new ProjectorConfigurationError(field, 'expected a PostgreSQL database URL');
  }
  if (nodeEnvironment === 'production') {
    const sslMode = url.searchParams.get('sslmode');
    if (sslMode !== 'require' && sslMode !== 'verify-ca' && sslMode !== 'verify-full') {
      throw new ProjectorConfigurationError(
        field,
        'production requires sslmode=require, verify-ca, or verify-full',
      );
    }
  }
  return value;
}

function parseUrl(value: string, field: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new ProjectorConfigurationError(field, 'expected an absolute URL');
  }
}

function parseInteger(
  value: string | undefined,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const normalized = value ?? fallback.toString();
  if (!/^(0|[1-9][0-9]*)$/.test(normalized)) {
    throw new ProjectorConfigurationError(field, 'expected a base-10 integer');
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ProjectorConfigurationError(field, `expected a value from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function parseIntegerList(value: string, field: string): number[] {
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.length === 0 || entries.some((entry) => entry === '')) {
    throw new ProjectorConfigurationError(field, 'expected a non-empty comma-separated list');
  }
  const parsed = entries.map((entry) => parseInteger(entry, field, 0, 0, 2_147_483_647));
  if (new Set(parsed).size !== parsed.length) {
    throw new ProjectorConfigurationError(field, 'duplicate operation type IDs are not allowed');
  }
  return parsed;
}

function parseAccountList(value: string, field: string): string[] {
  if (value === '') {
    return [];
  }
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.some((entry) => !hiveAccountSchema.safeParse(entry).success)) {
    throw new ProjectorConfigurationError(field, 'contains an invalid Hive account name');
  }
  if (new Set(entries).size !== entries.length) {
    throw new ProjectorConfigurationError(field, 'duplicate Hive accounts are not allowed');
  }
  return entries;
}
