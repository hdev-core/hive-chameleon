import { createWaxFoundation } from '@hiveio/wax';
import { describe, expect, it } from 'vitest';

import { WaxHiveChainAdapter } from './wax-chain.js';

describe('WAX chain adapter', () => {
  it('recomputes the digest and inspects exactly one HF26 custom_json operation', async () => {
    const chainId = `beeab0de${'0'.repeat(56)}`;
    const wax = await createWaxFoundation({ chainId });
    const transaction = wax.createTransactionWithTaPoS(
      '04c507a8c7fe5be96be64ce7c86855e1806cbde3',
      '2026-07-11T12:05:00Z',
    );
    transaction
      .pushOperation({
        custom_json_operation: {
          required_auths: [],
          required_posting_auths: ['match-pub'],
          id: 'hive.chameleon',
          json: '{}',
        },
      })
      .validate();
    const adapter = new WaxHiveChainAdapter({
      apiEndpoint: 'https://api.hive.blog',
      chainId,
    });

    const inspected = await adapter.inspectTransaction(transaction.toApi());

    expect(inspected.isSigned).toBe(false);
    expect(inspected.signatureDigest).toBe(transaction.sigDigest);
    expect(inspected.transactionId).toBe(transaction.id);
    expect(inspected.operation).toEqual({
      required_auths: [],
      required_posting_auths: ['match-pub'],
      id: 'hive.chameleon',
      json: '{}',
    });
  });

  it('rejects insecure secondary endpoints before constructing WAX', () => {
    expect(
      () =>
        new WaxHiveChainAdapter({
          apiEndpoint: 'https://api.hive.blog',
          restApiEndpoint: 'http://rest.example.test',
          chainId: `beeab0de${'0'.repeat(56)}`,
        }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_operation' }));
  });

  it.each([
    'https://api.hive.blog?api_key=redacted',
    'https://api.hive.blog/#credential-reference',
  ])('rejects RPC endpoint query or fragment data: %s', (apiEndpoint) => {
    expect(
      () =>
        new WaxHiveChainAdapter({
          apiEndpoint,
          chainId: `beeab0de${'0'.repeat(56)}`,
        }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_operation' }));
  });

  it('allows an HTTPS endpoint with a base path', () => {
    expect(
      () =>
        new WaxHiveChainAdapter({
          apiEndpoint: 'https://api.hive.blog/rpc/',
          chainId: `beeab0de${'0'.repeat(56)}`,
        }),
    ).not.toThrow();
  });
});
