import { HafProjectorError } from '../errors.js';
import type {
  BlockCheckpoint,
  HafBlock,
  HafIrreversibleBlock,
  HafOperation,
  OperationDecision,
  ProjectionCursor,
} from '../model.js';
import type { HafSource } from '../source/haf-source.js';
import type { ProjectionStore } from '../store/projection-store.js';
import type { HiveOperationValidator } from '../validation/operation-validator.js';

export interface HafProjectorOptions {
  readonly maxBlocksPerRun?: number;
  readonly maxReorgDepth?: number;
  readonly now?: () => Date;
}

export interface HafProjectorRunResult {
  readonly appliedBlocks: number;
  readonly finalizedThrough: number;
  readonly revertedTo: number | null;
  readonly sourceHead: number;
}

export class ForkAwareHafProjector {
  private readonly maxBlocksPerRun: number;
  private readonly maxReorgDepth: number;
  private readonly now: () => Date;

  public constructor(
    private readonly source: HafSource,
    private readonly store: ProjectionStore,
    private readonly validator: HiveOperationValidator,
    options: HafProjectorOptions = {},
  ) {
    this.maxBlocksPerRun = options.maxBlocksPerRun ?? 50;
    this.maxReorgDepth = options.maxReorgDepth ?? 200;
    this.now = options.now ?? (() => new Date());
  }

  public async runOnce(): Promise<HafProjectorRunResult> {
    let cursor = await this.store.getCursor(this.source.sourceName);
    const [sourceHead, sourceIrreversible] = await Promise.all([
      this.source.getHeadBlockNumber(),
      this.source.getLastIrreversibleBlock(),
    ]);

    if (sourceHead < cursor.lastProcessedBlock) {
      return {
        appliedBlocks: 0,
        finalizedThrough: cursor.lastIrreversibleBlock,
        revertedTo: null,
        sourceHead,
      };
    }

    const tipRevert = await this.verifyCurrentTip(cursor);
    if (tipRevert !== null) {
      return {
        appliedBlocks: 0,
        finalizedThrough: cursor.lastIrreversibleBlock,
        revertedTo: tipRevert,
        sourceHead,
      };
    }

    const target = Math.min(sourceHead, cursor.lastProcessedBlock + this.maxBlocksPerRun);
    let appliedBlocks = 0;
    if (target > cursor.lastProcessedBlock) {
      const firstBlock = cursor.lastProcessedBlock + 1;
      const beforeOperations = await this.readBlockSnapshot(firstBlock, target);
      const operations = await this.source.getOperations(firstBlock, target);
      const afterOperations = await this.readBlockSnapshot(firstBlock, target);
      assertStableSnapshot(beforeOperations, afterOperations);
      const operationsByBlock = groupOperationsByBlock(operations);

      for (const block of afterOperations) {
        if (
          cursor.lastProcessedBlockId !== null &&
          block.previousId !== cursor.lastProcessedBlockId
        ) {
          const ancestor = await this.reconcileFork(cursor, block.number - 1);
          return {
            appliedBlocks,
            finalizedThrough: cursor.lastIrreversibleBlock,
            revertedTo: ancestor,
            sourceHead,
          };
        }

        const decisions = this.validateBlockOperations(
          block,
          operationsByBlock.get(block.number) ?? [],
        );
        await this.store.applyBlock(
          this.source.sourceName,
          block,
          decisions,
          this.now().toISOString(),
        );
        cursor = {
          ...cursor,
          lastProcessedBlock: block.number,
          lastProcessedBlockId: block.id,
        };
        appliedBlocks += 1;
      }
    }

    const finalizable = Math.min(sourceIrreversible.number, cursor.lastProcessedBlock);
    if (finalizable > cursor.lastIrreversibleBlock) {
      await this.assertFinalityAgreement(sourceIrreversible, finalizable, sourceHead);
      await this.store.finalizeThrough(
        this.source.sourceName,
        finalizable,
        this.now().toISOString(),
      );
    }

    return {
      appliedBlocks,
      finalizedThrough: Math.max(cursor.lastIrreversibleBlock, finalizable),
      revertedTo: null,
      sourceHead,
    };
  }

  private async readBlockSnapshot(
    fromBlock: number,
    toBlock: number,
  ): Promise<readonly HafBlock[]> {
    const blocks: HafBlock[] = [];
    for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber += 1) {
      const block = await this.source.getBlock(blockNumber);
      const previous = blocks.at(-1);
      if (
        block.number !== blockNumber ||
        (previous !== undefined && block.previousId !== previous.id)
      ) {
        throw new HafProjectorError(
          'source_divergence',
          'HAfAH block snapshot changed while it was being read',
        );
      }
      blocks.push(block);
    }
    return blocks;
  }

  private async assertFinalityAgreement(
    irreversible: HafIrreversibleBlock,
    finalizable: number,
    sourceHead: number,
  ): Promise<void> {
    if (irreversible.number <= 0 || irreversible.id === null || irreversible.number > sourceHead) {
      throw new HafProjectorError(
        'source_divergence',
        'Hive RPC finality cannot be anchored to the HAfAH source head',
      );
    }

    const hafahIrreversible = await this.source.getBlock(irreversible.number);
    if (hafahIrreversible.id !== irreversible.id) {
      throw new HafProjectorError(
        'source_divergence',
        'Hive RPC and HAfAH disagree on the irreversible block identity',
      );
    }

    const stored = await this.store.getCurrentCheckpoint(this.source.sourceName, finalizable);
    const current =
      finalizable === irreversible.number
        ? hafahIrreversible
        : await this.source.getBlock(finalizable);
    if (stored === null || !sameBlock(stored, current)) {
      throw new HafProjectorError(
        'source_divergence',
        'Finalizable checkpoint no longer matches the HAfAH block identity',
      );
    }
  }

  private async verifyCurrentTip(cursor: ProjectionCursor): Promise<number | null> {
    if (cursor.lastProcessedBlock === 0 || cursor.lastProcessedBlockId === null) {
      return null;
    }
    const current = await this.source.getBlock(cursor.lastProcessedBlock);
    if (current.id === cursor.lastProcessedBlockId) {
      return null;
    }
    return this.reconcileFork(cursor, cursor.lastProcessedBlock);
  }

  private async reconcileFork(cursor: ProjectionCursor, startHeight: number): Promise<number> {
    const lowerBound = Math.max(0, startHeight - this.maxReorgDepth);
    for (let blockNumber = startHeight; blockNumber >= lowerBound; blockNumber -= 1) {
      if (blockNumber === 0) {
        if (cursor.lastIrreversibleBlock > 0) {
          throw new HafProjectorError(
            'irreversible_fork',
            'No common ancestor exists above the irreversible cursor',
          );
        }
        await this.store.revertAfter(this.source.sourceName, 0, this.now().toISOString());
        return 0;
      }

      const stored = await this.store.getCurrentCheckpoint(this.source.sourceName, blockNumber);
      const current = await this.source.getBlock(blockNumber);
      if (stored !== null && stored.id === current.id) {
        if (blockNumber < cursor.lastIrreversibleBlock) {
          throw new HafProjectorError('irreversible_fork', 'Fork crosses the irreversible cursor');
        }
        await this.store.revertAfter(this.source.sourceName, blockNumber, this.now().toISOString());
        return blockNumber;
      }

      if (blockNumber <= cursor.lastIrreversibleBlock) {
        throw new HafProjectorError('irreversible_fork', 'Fork changes an irreversible block');
      }
    }

    throw new HafProjectorError(
      'reorg_too_deep',
      'Fork exceeds the configured reconciliation depth',
    );
  }

  private validateBlockOperations(
    block: HafBlock,
    operations: readonly HafOperation[],
  ): readonly OperationDecision[] {
    const decisions: OperationDecision[] = [];
    const sourceIds = new Set<string>();
    for (const operation of operations) {
      if (operation.blockNumber !== block.number || operation.timestamp !== block.timestamp) {
        throw new HafProjectorError(
          'invalid_source_response',
          'Hive operation does not match its block checkpoint',
        );
      }
      if (sourceIds.has(operation.sourceOperationId)) {
        throw new HafProjectorError(
          'invalid_source_response',
          'Hive source returned a duplicate operation identity in one block',
        );
      }
      sourceIds.add(operation.sourceOperationId);
      const decision = this.validator.validate(operation, block);
      if (decision !== null) {
        decisions.push(decision);
      }
    }
    return decisions;
  }
}

function assertStableSnapshot(
  beforeOperations: readonly HafBlock[],
  afterOperations: readonly HafBlock[],
): void {
  if (
    beforeOperations.length !== afterOperations.length ||
    beforeOperations.some((block, index) => {
      const after = afterOperations[index];
      return after === undefined || !sameBlock(block, after);
    })
  ) {
    throw new HafProjectorError(
      'source_divergence',
      'HAfAH block identities changed while operations were fetched',
    );
  }
}

function sameBlock(left: HafBlock | BlockCheckpoint, right: HafBlock): boolean {
  return (
    left.number === right.number &&
    left.id === right.id &&
    left.previousId === right.previousId &&
    left.timestamp === right.timestamp
  );
}

function groupOperationsByBlock(
  operations: readonly HafOperation[],
): ReadonlyMap<number, readonly HafOperation[]> {
  const grouped = new Map<number, HafOperation[]>();
  const sourceIds = new Set<string>();
  for (const operation of operations) {
    if (sourceIds.has(operation.sourceOperationId)) {
      throw new HafProjectorError(
        'invalid_source_response',
        'Hive source returned a duplicate operation identity in one range',
      );
    }
    sourceIds.add(operation.sourceOperationId);
    const items = grouped.get(operation.blockNumber) ?? [];
    items.push(operation);
    grouped.set(operation.blockNumber, items);
  }
  return grouped;
}
