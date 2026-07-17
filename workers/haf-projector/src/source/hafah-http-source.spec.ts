import { describe, expect, it } from 'vitest';

import type { FetchPort, HttpResponsePort } from './hafah-http-source.js';
import { HafahHttpSource } from './hafah-http-source.js';

describe('HAfAH HTTP source', () => {
  it('paginates with 64-bit operation identifiers kept as strings', async () => {
    const requests: string[] = [];
    const firstId = '464662461530767364';
    const secondId = '464662465825734675';
    const fetchPort: FetchPort = async (input) => {
      requests.push(input);
      const url = new URL(input);
      const operationBegin = url.searchParams.get('operation-begin');
      if (operationBegin === null) {
        return response(
          operationPage([sourceOperation(firstId, 100, 'a'.repeat(40))], 100, firstId),
        );
      }
      expect(operationBegin).toBe(firstId);
      return response(operationPage([sourceOperation(secondId, 101, 'b'.repeat(40))]));
    };
    const source = createSource(fetchPort, 1);

    const operations = await source.getOperations(100, 101);

    expect(operations.map((operation) => operation.sourceOperationId)).toEqual([firstId, secondId]);
    expect(requests[1]).toContain(`operation-begin=${firstId}`);
  });

  it('stops on the HAfAH zero pagination sentinels', async () => {
    let requestCount = 0;
    const fetchPort: FetchPort = async () => {
      requestCount += 1;
      return response(
        operationPage([sourceOperation('464662461530767364', 100, 'a'.repeat(40))], 0, '0'),
      );
    };
    const source = createSource(fetchPort, 1);

    const operations = await source.getOperations(100, 100);

    expect(operations).toHaveLength(1);
    expect(requestCount).toBe(1);
  });

  it('fails closed when a non-virtual operation has no transaction ID', async () => {
    const fetchPort: FetchPort = async () =>
      response(
        operationPage([
          {
            ...sourceOperation('464662461530767364', 100, 'a'.repeat(40)),
            trx_id: undefined,
          },
        ]),
      );
    const source = createSource(fetchPort, 10);

    await expect(source.getOperations(100, 100)).rejects.toMatchObject({
      code: 'invalid_source_response',
    });
  });

  it('rejects operation identifiers outside the unsigned 64-bit range', async () => {
    const fetchPort: FetchPort = async () =>
      response(operationPage([sourceOperation('18446744073709551616', 100, 'a'.repeat(40))]));
    const source = createSource(fetchPort, 10);

    await expect(source.getOperations(100, 100)).rejects.toMatchObject({
      code: 'invalid_source_response',
    });
  });

  it('preserves an originating transaction ID carried by a virtual operation', async () => {
    const transactionId = 'a'.repeat(40);
    const fetchPort: FetchPort = async () =>
      response(
        operationPage([
          {
            ...sourceOperation('464662461530767364', 100, transactionId),
            virtual_op: true,
          },
        ]),
      );
    const source = createSource(fetchPort, 10);

    const operations = await source.getOperations(100, 100);

    expect(operations[0]).toMatchObject({ isVirtual: true, transactionId });
  });

  it('normalizes the HAfAH zero transaction sentinel on a virtual operation', async () => {
    const fetchPort: FetchPort = async () =>
      response(
        operationPage([
          {
            ...sourceOperation('464662461530767364', 100, '0'.repeat(40)),
            virtual_op: true,
          },
        ]),
      );
    const source = createSource(fetchPort, 10);

    const operations = await source.getOperations(100, 100);

    expect(operations[0]).toMatchObject({ isVirtual: true, transactionId: null });
  });

  it('reads the LIB identity from Hive RPC rather than trusting height alone', async () => {
    const blockNumber = 100;
    const blockId = `00000064${'a'.repeat(32)}`;
    const methods: string[] = [];
    const fetchPort: FetchPort = async (_input, init) => {
      const body = JSON.parse(init?.body as string) as { method: string };
      methods.push(body.method);
      return body.method === 'database_api.get_dynamic_global_properties'
        ? response({ result: { last_irreversible_block_num: blockNumber } })
        : response({ result: { block: { block_id: blockId } } });
    };
    const source = createSource(fetchPort, 10);

    await expect(source.getLastIrreversibleBlock()).resolves.toEqual({
      number: blockNumber,
      id: blockId,
    });
    expect(methods).toEqual(['database_api.get_dynamic_global_properties', 'block_api.get_block']);
  });

  it.each([
    {
      hafahApiUrl: 'http://hafah.test/hafah-api/?api_key=redacted',
      hiveRpcUrl: 'http://rpc.test/',
    },
    {
      hafahApiUrl: 'http://hafah.test/hafah-api/',
      hiveRpcUrl: 'http://rpc.test/#credential-reference',
    },
  ])('rejects source URL query or fragment data', (urls) => {
    expect(
      () =>
        new HafahHttpSource({
          sourceName: 'test-mainnet',
          ...urls,
          operationTypeIds: [18],
          allowHttpForTests: true,
        }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_source_response' }));
  });

  it('allows a HAfAH base path without query or fragment data', () => {
    expect(() => createSource(async () => response(operationPage([])), 10)).not.toThrow();
  });
});

function createSource(fetchPort: FetchPort, pageSize: number): HafahHttpSource {
  return new HafahHttpSource(
    {
      sourceName: 'test-mainnet',
      hafahApiUrl: 'http://hafah.test/hafah-api/',
      hiveRpcUrl: 'http://rpc.test/',
      operationTypeIds: [18],
      pageSize,
      allowHttpForTests: true,
    },
    fetchPort,
  );
}

function response(value: unknown): HttpResponsePort {
  return { ok: true, status: 200, json: async () => value };
}

function operationPage(
  ops: readonly unknown[],
  nextBlock?: number,
  nextOperation?: string,
): unknown {
  return {
    ops,
    ...(nextBlock === undefined ? {} : { next_block_range_begin: nextBlock }),
    ...(nextOperation === undefined ? {} : { next_operation_begin: nextOperation }),
  };
}

function sourceOperation(
  operationId: string,
  block: number,
  transactionId: string,
): Record<string, unknown> {
  return {
    op: {
      type: 'custom_json_operation',
      value: {
        required_auths: [],
        required_posting_auths: ['match-pub'],
        id: 'hive.chameleon',
        json: '{}',
      },
    },
    block,
    trx_id: transactionId,
    op_pos: 0,
    timestamp: '2026-07-11T12:06:00',
    virtual_op: false,
    operation_id: operationId,
  };
}
