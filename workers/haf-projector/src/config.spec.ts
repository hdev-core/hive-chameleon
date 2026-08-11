import { describe, expect, it } from 'vitest';

import { loadHafProjectorConfig } from './config.js';

const validEnvironment = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://projector:secret@database.internal:5432/hive_chameleon',
  HAF_PROJECTOR_SOURCE_NAME: 'hive-mainnet',
  HAF_PROJECTOR_HAFAH_API_URL: 'https://hafah.example.invalid/api/',
  HAF_PROJECTOR_HIVE_RPC_URL: 'https://hive-rpc.example.invalid/',
  HAF_PROJECTOR_OPERATION_TYPE_IDS: '18, 91',
  HAF_PROJECTOR_MATCH_PUBLISHERS: 'match-pub,other-pub',
  HAF_PROJECTOR_COLLECTIBLE_ISSUERS: '',
} as const;

describe('HAF projector runtime configuration', () => {
  it('loads explicit identities and safe bounded defaults', () => {
    const config = loadHafProjectorConfig(validEnvironment);

    expect(config.sourceName).toBe('hive-mainnet');
    expect(config.operationTypeIds).toEqual([18, 91]);
    expect(config.matchPublishers).toEqual(['match-pub', 'other-pub']);
    expect(config.collectibleIssuers).toEqual([]);
    expect(config.pageSize).toBe(1_000);
    expect(config.maxReorgDepth).toBe(200);
    expect(config.databaseUrl).toBe(validEnvironment.DATABASE_URL);
  });

  it('does not supply a production chain or database endpoint', () => {
    const withoutHafah: Record<string, string | undefined> = { ...validEnvironment };
    delete withoutHafah.HAF_PROJECTOR_HAFAH_API_URL;

    expect(() => loadHafProjectorConfig(withoutHafah)).toThrow('HAF_PROJECTOR_HAFAH_API_URL');
    expect(() => loadHafProjectorConfig({ ...validEnvironment, DATABASE_URL: undefined })).toThrow(
      'DATABASE_URL',
    );
  });

  it('requires encrypted PostgreSQL transport in production', () => {
    expect(() => loadHafProjectorConfig({ ...validEnvironment, NODE_ENV: 'production' })).toThrow(
      'production requires sslmode',
    );

    const config = loadHafProjectorConfig({
      ...validEnvironment,
      NODE_ENV: 'production',
      DATABASE_URL: `${validEnvironment.DATABASE_URL}?sslmode=verify-full`,
    });
    expect(config.nodeEnvironment).toBe('production');
  });

  it('rejects insecure source URLs and ambiguous lists', () => {
    expect(() =>
      loadHafProjectorConfig({
        ...validEnvironment,
        HAF_PROJECTOR_HIVE_RPC_URL: 'http://hive-rpc.example.invalid/',
      }),
    ).toThrow('expected an HTTPS URL');
    expect(() =>
      loadHafProjectorConfig({
        ...validEnvironment,
        HAF_PROJECTOR_OPERATION_TYPE_IDS: '18,18',
      }),
    ).toThrow('duplicate operation type IDs');
    expect(() =>
      loadHafProjectorConfig({
        ...validEnvironment,
        HAF_PROJECTOR_MATCH_PUBLISHERS: 'Not-Normalized',
      }),
    ).toThrow('invalid Hive account');
  });

  it('rejects unsafe polling and reorganization bounds', () => {
    expect(() =>
      loadHafProjectorConfig({
        ...validEnvironment,
        HAF_PROJECTOR_MAX_REORG_DEPTH: '0',
      }),
    ).toThrow('HAF_PROJECTOR_MAX_REORG_DEPTH');
    expect(() =>
      loadHafProjectorConfig({
        ...validEnvironment,
        HAF_PROJECTOR_INITIAL_FAILURE_BACKOFF_MS: '5000',
        HAF_PROJECTOR_MAXIMUM_FAILURE_BACKOFF_MS: '1000',
      }),
    ).toThrow('must be greater than or equal');
  });
});
