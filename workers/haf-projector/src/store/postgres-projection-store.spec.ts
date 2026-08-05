import { describe, expect, it } from 'vitest';

import { serializeHiveChameleonEvent } from '@hive-chameleon/hive-gateway';
import { COLLECTIBLE_EVENT_FIXTURE } from '@hive-chameleon/hive-gateway/testing';

import type { HafBlock, OperationDecision } from '../model.js';
import {
  PostgresProjectionStore,
  type SqlClientPort,
  type SqlPoolPort,
  type SqlQueryResult,
} from './postgres-projection-store.js';

const block: HafBlock = {
  number: 1,
  id: 'a'.repeat(40),
  previousId: '0'.repeat(40),
  timestamp: '2026-07-11T12:06:01.000Z',
};

const decision: OperationDecision = {
  evidence: {
    sourceOperationId: '18446744073709551615',
    transactionId: 'b'.repeat(40),
    operationIndex: 0,
    isVirtual: false,
    blockNumber: 1,
    blockId: block.id,
    blockTimestamp: block.timestamp,
    operationType: 'custom_json_operation',
    primaryAccount: 'unknown-signer',
    requiredAuthority: 'posting',
    applicationId: 'hive.chameleon',
    payload: { id: 'hive.chameleon', json: '{}' },
  },
  validationState: 'rejected',
  rejectionReason: 'invalid_event',
};

describe('PostgreSQL projection store', () => {
  it('atomically writes the checkpoint, raw decision, and sanitized cursor identity', async () => {
    const client = new RecordingSqlClient();
    const ids = ['0190f6d2-7c00-7000-8000-000000000001', '0190f6d2-7c00-7000-8000-000000000002'];
    const store = new PostgresProjectionStore(new SingleClientPool(client), {
      endpointIdentity: 'https://hafah.example/api?credential=redacted#fragment',
      nextUuidV7: () => ids.shift() ?? 'unexpected',
    });

    await store.applyBlock('hive-mainnet', block, [decision], '2026-07-11T12:07:00.000Z');

    expect(client.statements[0]?.text).toBe('BEGIN');
    expect(client.statements.at(-1)?.text).toBe('COMMIT');
    expect(client.statements.some(({ text }) => text.includes('block_checkpoint'))).toBe(true);
    const operationInsert = client.statements.find(({ text }) =>
      text.includes('INSERT INTO hive_projection.operation'),
    );
    expect(operationInsert?.values?.[15]).toBe('rejected');
    expect(operationInsert?.values?.[16]).toBe('invalid_event');
    expect(JSON.parse(operationInsert?.values?.[13] as string)).toEqual(decision.evidence.payload);
    const cursorUpdate = client.statements.find(({ text }) =>
      text.includes('UPDATE hive_projection.sync_cursor'),
    );
    expect(cursorUpdate?.values?.[1]).toBe('https://hafah.example/api');
    expect(client.releaseCount).toBe(1);
  });

  it('rolls back and releases the connection when an ID provider violates UUIDv7', async () => {
    const client = new RecordingSqlClient();
    const store = new PostgresProjectionStore(new SingleClientPool(client), {
      endpointIdentity: 'https://hafah.example/api',
      nextUuidV7: () => 'not-a-uuid',
    });

    await expect(
      store.applyBlock('hive-mainnet', block, [], '2026-07-11T12:07:00.000Z'),
    ).rejects.toMatchObject({ code: 'cursor_conflict' });
    expect(client.statements.map(({ text }) => text)).toContain('ROLLBACK');
    expect(client.statements.map(({ text }) => text)).not.toContain('COMMIT');
    expect(client.releaseCount).toBe(1);
  });

  it('destroys a connection when rollback fails', async () => {
    const client = new RecordingSqlClient(true);
    const store = new PostgresProjectionStore(new SingleClientPool(client), {
      endpointIdentity: 'https://hafah.example/api',
      nextUuidV7: () => 'not-a-uuid',
    });

    await expect(
      store.applyBlock('hive-mainnet', block, [], '2026-07-11T12:07:00.000Z'),
    ).rejects.toMatchObject({ code: 'cursor_conflict' });
    expect(client.releaseCount).toBe(1);
    expect(client.destroyed).toBe(true);
  });

  it('preserves a real originating transaction ID on virtual-operation evidence', async () => {
    const client = new RecordingSqlClient();
    const ids = ['0190f6d2-7c00-7000-8000-000000000001', '0190f6d2-7c00-7000-8000-000000000002'];
    const store = new PostgresProjectionStore(new SingleClientPool(client), {
      endpointIdentity: 'https://hafah.example/api',
      nextUuidV7: () => ids.shift() ?? 'unexpected',
    });
    const virtualDecision: OperationDecision = {
      ...decision,
      evidence: {
        ...decision.evidence,
        isVirtual: true,
        transactionId: 'c'.repeat(40),
      },
    };

    await store.applyBlock('hive-mainnet', block, [virtualDecision], '2026-07-11T12:07:00.000Z');

    const operationInsert = client.statements.find(({ text }) =>
      text.includes('INSERT INTO hive_projection.operation'),
    );
    expect(operationInsert?.values?.[3]).toBe('c'.repeat(40));
    expect(operationInsert?.values?.[5]).toBe(true);
  });

  it('stores an accepted application event as reversible raw evidence in the block transaction', async () => {
    const client = new RecordingSqlClient();
    const operationId = '0190f6d2-7c00-7000-8000-000000000002';
    const ids = ['0190f6d2-7c00-7000-8000-000000000001', operationId];
    const store = new PostgresProjectionStore(new SingleClientPool(client), {
      endpointIdentity: 'https://hafah.example/api',
      nextUuidV7: () => ids.shift() ?? 'unexpected',
    });
    const acceptedDecision: OperationDecision = {
      evidence: {
        ...decision.evidence,
        payload: {
          required_auths: [],
          required_posting_auths: ['item-issuer'],
          id: 'hive.chameleon',
          json: serializeHiveChameleonEvent(COLLECTIBLE_EVENT_FIXTURE),
        },
      },
      validationState: 'accepted',
      event: COLLECTIBLE_EVENT_FIXTURE,
    };

    await store.applyBlock('hive-mainnet', block, [acceptedDecision], '2026-07-11T12:07:00.000Z');

    const operationInsert = client.statements.find(({ text }) =>
      text.includes('INSERT INTO hive_projection.operation'),
    );
    expect(operationInsert?.values?.[0]).toBe(operationId);
    expect(operationInsert?.values?.[15]).toBe('accepted');
    expect(client.statements.some(({ text }) => text.includes('collectible_event'))).toBe(false);
  });

  it('materializes accepted collectible evidence only at irreversibility', async () => {
    const client = new FinalizationSqlClient({
      required_auths: [],
      required_posting_auths: ['item-issuer'],
      id: 'hive.chameleon',
      json: serializeHiveChameleonEvent(COLLECTIBLE_EVENT_FIXTURE),
    });
    const store = new PostgresProjectionStore(new SingleClientPool(client), {
      endpointIdentity: 'https://hafah.example/api',
      nextUuidV7: () => '0190f6d2-7c00-7000-8000-000000000099',
    });

    await store.finalizeThrough('hive-mainnet', 1, '2026-07-11T12:08:00.000Z');

    expect(client.statements.some(({ text }) => text.includes("SET state = 'irreversible'"))).toBe(
      true,
    );
    expect(
      client.statements.some(({ text }) =>
        text.includes('INSERT INTO hive_projection.collectible_event'),
      ),
    ).toBe(true);
  });
});

interface RecordedStatement {
  readonly text: string;
  readonly values?: readonly unknown[];
}

class RecordingSqlClient implements SqlClientPort {
  public readonly statements: RecordedStatement[] = [];
  public releaseCount = 0;
  public destroyed = false;

  public constructor(private readonly failRollback = false) {}

  public async query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>> {
    this.statements.push({ text, ...(values === undefined ? {} : { values }) });
    if (text === 'ROLLBACK' && this.failRollback) {
      throw new Error('connection lost');
    }
    const rows = text.includes('FOR UPDATE OF c')
      ? [
          {
            source: 'hive-mainnet',
            last_processed_block: 0,
            last_irreversible_block: 0,
            block_id: null,
          },
        ]
      : [];
    return { rows: rows as unknown as readonly Row[], rowCount: rows.length };
  }

  public release(destroy = false): void {
    this.releaseCount += 1;
    this.destroyed = destroy;
  }
}

class FinalizationSqlClient implements SqlClientPort {
  public readonly statements: RecordedStatement[] = [];

  public constructor(private readonly payload: unknown) {}

  public async query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>> {
    this.statements.push({ text, ...(values === undefined ? {} : { values }) });
    let rows: readonly Record<string, unknown>[] = [];
    if (text.includes('FOR UPDATE OF c')) {
      rows = [
        {
          source: 'hive-mainnet',
          last_processed_block: 1,
          last_irreversible_block: 0,
          block_id: 'a'.repeat(40),
        },
      ];
    } else if (text.includes('SELECT operation.id')) {
      rows = [
        {
          id: '0190f6d2-7c00-7000-8000-000000000002',
          transaction_id: 'b'.repeat(40),
          block_number: 1,
          block_timestamp: block.timestamp,
          primary_account: 'item-issuer',
          payload: this.payload,
        },
      ];
    }
    return { rows: rows as readonly Row[], rowCount: rows.length };
  }

  public release(): void {}
}

class SingleClientPool implements SqlPoolPort {
  public constructor(private readonly client: SqlClientPort) {}

  public async connect(): Promise<SqlClientPort> {
    return this.client;
  }
}
