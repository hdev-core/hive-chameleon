import { describe, expect, it } from 'vitest';

import { loadMatchPublisherConfig } from './config.js';

const validEnvironment = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://worker:secret@db.internal/hive?sslmode=verify-full',
  MATCH_PUBLISHER_HIVE_RPC_URL: 'https://api.hive.example/',
  MATCH_PUBLISHER_HIVE_CHAIN_ID: 'a'.repeat(64),
  MATCH_PUBLISHER_HIVE_ACCOUNT: 'match-pub',
  MATCH_PUBLISHER_PUBLIC_KEY: 'STM7u41yX66A2r6JNBrgawxT51sPxRMTJAW1QaEwdxQfFePGvCDET',
  MATCH_PUBLISHER_SIGNER_KEY_REFERENCE: 'production/match-publisher/posting',
  MATCH_PUBLISHER_SIGNER_POLICY_VERSION: 'match-policy-1',
  MATCH_PUBLISHER_SIGNER_URL: 'https://signer.internal.example/v1/sign',
  MATCH_PUBLISHER_SIGNER_BEARER_TOKEN: 'a-secure-fixture-token-with-32-characters',
} as const;

describe('loadMatchPublisherConfig', () => {
  it('loads the production-safe defaults', () => {
    expect(loadMatchPublisherConfig(validEnvironment)).toMatchObject({
      nodeEnvironment: 'production',
      publisherAccount: 'match-pub',
      batchMaximumAgeMs: 300_000,
      batchMaximumResults: 20,
      batchMaximumPayloadBytes: 6 * 1024,
    });
  });

  it('rejects production PostgreSQL without TLS', () => {
    expect(() =>
      loadMatchPublisherConfig({
        ...validEnvironment,
        DATABASE_URL: 'postgres://worker:secret@db.internal/hive?sslmode=disable',
      }),
    ).toThrow(/requires PostgreSQL TLS/);
  });
});
