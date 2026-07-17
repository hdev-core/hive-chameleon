import { serializeHiveChameleonEvent } from '@hive-chameleon/hive-gateway';
import { MATCH_EVENT_FIXTURE } from '@hive-chameleon/hive-gateway/testing';
import { describe, expect, it } from 'vitest';

import type { HafBlock, HafOperation } from '../model.js';
import { FixtureHafSource } from '../testing/fixture-source.js';
import { InMemoryProjectionStore } from '../testing/in-memory-store.js';
import { HiveOperationValidator } from '../validation/operation-validator.js';
import { ForkAwareHafProjector, type HafProjectorOptions } from './haf-projector.js';

describe('fork-aware HAF projector', () => {
  it('persists pending evidence and promotes it only through LIB', async () => {
    const source = new FixtureHafSource();
    const blocks = chain('a', 2);
    source.replaceChain(blocks, [matchOperation(2, '2000')]);
    source.lastIrreversibleBlock = 1;
    const store = new InMemoryProjectionStore();
    const projector = createProjector(source, store);

    await projector.runOnce();
    expect(store.operations).toMatchObject([
      { validationState: 'accepted', state: 'included', event: { type: 'match_results_batch' } },
    ]);

    source.lastIrreversibleBlock = 2;
    await projector.runOnce();
    expect(store.operations[0]?.state).toBe('irreversible');
    expect((await store.getCursor(source.sourceName)).lastIrreversibleBlock).toBe(2);
  });

  it('finds a common ancestor, retains reverted evidence, and applies the replacement branch', async () => {
    const source = new FixtureHafSource();
    const initial = chain('a', 3);
    source.replaceChain(initial, [matchOperation(2, '2000')]);
    source.lastIrreversibleBlock = 1;
    const store = new InMemoryProjectionStore();
    const projector = createProjector(source, store);
    await projector.runOnce();

    const replacement = [initial[0] as HafBlock, ...chainFrom('b', 2, 4, initial[0]?.id ?? '')];
    source.replaceChain(replacement, [matchOperation(3, '3000')]);

    const reconciliation = await projector.runOnce();
    expect(reconciliation.revertedTo).toBe(1);
    expect(store.operations[0]?.state).toBe('reverted');

    const replay = await projector.runOnce();
    expect(replay.appliedBlocks).toBe(3);
    expect(store.operations.map((operation) => operation.state)).toEqual(['reverted', 'included']);
    expect((await store.getCursor(source.sourceName)).lastProcessedBlock).toBe(4);
  });

  it('fails closed when the current source changes an irreversible block', async () => {
    const source = new FixtureHafSource();
    const initial = chain('a', 2);
    source.replaceChain(initial);
    source.lastIrreversibleBlock = 2;
    const store = new InMemoryProjectionStore();
    const projector = createProjector(source, store);
    await projector.runOnce();

    source.replaceChain([initial[0] as HafBlock, ...chainFrom('b', 2, 2, initial[0]?.id ?? '')]);

    await expect(projector.runOnce()).rejects.toMatchObject({ code: 'irreversible_fork' });
  });

  it('keeps finality and fork state isolated between configured sources', async () => {
    const firstSource = new FixtureHafSource('first-source');
    const secondSource = new FixtureHafSource('second-source');
    firstSource.replaceChain(chain('a', 1), [matchOperation(1, '1000')]);
    secondSource.replaceChain(chain('b', 1), [matchOperation(1, '2000')]);
    const store = new InMemoryProjectionStore();
    const firstProjector = createProjector(firstSource, store);
    const secondProjector = createProjector(secondSource, store);

    await firstProjector.runOnce();
    await secondProjector.runOnce();
    firstSource.lastIrreversibleBlock = 1;
    await firstProjector.runOnce();

    expect(store.operations.map(({ source, state }) => ({ source, state }))).toEqual([
      { source: 'first-source', state: 'irreversible' },
      { source: 'second-source', state: 'included' },
    ]);
  });

  it('rejects operation evidence that disagrees with the block checkpoint', async () => {
    const source = new FixtureHafSource();
    source.replaceChain(chain('a', 1), [
      { ...matchOperation(1, '1000'), timestamp: '2026-07-11T12:06:59.000Z' },
    ]);
    const projector = createProjector(source, new InMemoryProjectionStore());

    await expect(projector.runOnce()).rejects.toMatchObject({
      code: 'invalid_source_response',
    });
  });

  it('does not bind fetched operations when reversible block identities change around the read', async () => {
    const initial = chain('a', 2);
    const replacement = chain('b', 2);
    const source = new ChangingDuringOperationReadSource(replacement);
    source.replaceChain(initial, [matchOperation(2, '2000')]);
    const store = new InMemoryProjectionStore();
    const projector = createProjector(source, store);

    await expect(projector.runOnce()).rejects.toMatchObject({ code: 'source_divergence' });
    expect(store.checkpoints).toHaveLength(0);
    expect(store.operations).toHaveLength(0);
  });

  it('refuses finality when Hive RPC and HAfAH disagree on the LIB identity', async () => {
    const source = new FixtureHafSource();
    source.replaceChain(chain('a', 2), [matchOperation(2, '2000')]);
    source.lastIrreversibleBlock = 2;
    source.irreversibleBlockIdOverride = 'f'.repeat(40);
    const store = new InMemoryProjectionStore();
    const projector = createProjector(source, store);

    await expect(projector.runOnce()).rejects.toMatchObject({ code: 'source_divergence' });
    expect(store.operations[0]?.state).toBe('included');
    expect((await store.getCursor(source.sourceName)).lastIrreversibleBlock).toBe(0);
  });

  it('rechecks the stored checkpoint against HAfAH immediately before finalization', async () => {
    const initial = chain('a', 2);
    const changedFirstBlock: HafBlock = {
      ...(initial[0] as HafBlock),
      id: `c${'0'.repeat(39)}`,
    };
    const source = new ChangingAtFinalizationSource(changedFirstBlock);
    source.replaceChain(initial, [matchOperation(1, '1000')]);
    source.lastIrreversibleBlock = 2;
    const store = new InMemoryProjectionStore();
    const projector = createProjector(source, store, { maxBlocksPerRun: 1 });

    await expect(projector.runOnce()).rejects.toMatchObject({ code: 'source_divergence' });
    expect(store.operations[0]?.state).toBe('included');
    expect((await store.getCursor(source.sourceName)).lastIrreversibleBlock).toBe(0);
  });
});

function createProjector(
  source: FixtureHafSource,
  store: InMemoryProjectionStore,
  options: HafProjectorOptions = {},
): ForkAwareHafProjector {
  return new ForkAwareHafProjector(
    source,
    store,
    new HiveOperationValidator({
      matchPublishers: new Set(['match-pub']),
      collectibleIssuers: new Set(['item-issuer']),
    }),
    { ...options, now: () => new Date('2026-07-11T12:07:00.000Z') },
  );
}

class ChangingDuringOperationReadSource extends FixtureHafSource {
  private changed = false;

  public constructor(private readonly replacement: readonly HafBlock[]) {
    super();
  }

  public override async getOperations(
    fromBlock: number,
    toBlock: number,
  ): Promise<readonly HafOperation[]> {
    const operations = await super.getOperations(fromBlock, toBlock);
    if (!this.changed) {
      this.changed = true;
      this.replaceChain(this.replacement, operations);
    }
    return operations;
  }
}

class ChangingAtFinalizationSource extends FixtureHafSource {
  private firstBlockReads = 0;

  public constructor(private readonly finalizationBlock: HafBlock) {
    super();
  }

  public override async getBlock(blockNumber: number): Promise<HafBlock> {
    if (blockNumber === this.finalizationBlock.number) {
      this.firstBlockReads += 1;
      if (this.firstBlockReads >= 3) {
        return this.finalizationBlock;
      }
    }
    return super.getBlock(blockNumber);
  }
}

function chain(prefix: string, length: number): HafBlock[] {
  return chainFrom(prefix, 1, length, '0'.repeat(40));
}

function chainFrom(prefix: string, from: number, to: number, previousId: string): HafBlock[] {
  const blocks: HafBlock[] = [];
  let previous = previousId;
  for (let blockNumber = from; blockNumber <= to; blockNumber += 1) {
    const id = `${prefix}${blockNumber.toString(16).padStart(39, '0')}`;
    blocks.push({
      number: blockNumber,
      id,
      previousId: previous,
      timestamp: `2026-07-11T12:06:${blockNumber.toString().padStart(2, '0')}.000Z`,
    });
    previous = id;
  }
  return blocks;
}

function matchOperation(blockNumber: number, sourceOperationId: string): HafOperation {
  return {
    sourceOperationId,
    transactionId: blockNumber.toString(16).padStart(40, '0'),
    operationIndex: 0,
    isVirtual: false,
    blockNumber,
    timestamp: `2026-07-11T12:06:${blockNumber.toString().padStart(2, '0')}.000Z`,
    operationType: 'custom_json_operation',
    value: {
      required_auths: [],
      required_posting_auths: ['match-pub'],
      id: 'hive.chameleon',
      json: serializeHiveChameleonEvent(MATCH_EVENT_FIXTURE),
    },
  };
}
