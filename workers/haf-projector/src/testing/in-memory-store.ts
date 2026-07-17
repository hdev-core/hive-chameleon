import { HafProjectorError } from '../errors.js';
import type {
  BlockCheckpoint,
  HafBlock,
  OperationDecision,
  ProjectionCursor,
  StoredOperationDecision,
} from '../model.js';
import type { ProjectionStore } from '../store/projection-store.js';

export class InMemoryProjectionStore implements ProjectionStore {
  public readonly checkpoints: BlockCheckpoint[] = [];
  public readonly operations: StoredOperationDecision[] = [];

  private readonly cursors = new Map<string, ProjectionCursor>();

  public constructor() {
    assertNonProductionFixture();
  }

  public async getCursor(source: string): Promise<ProjectionCursor> {
    return (
      this.cursors.get(source) ?? {
        source,
        lastProcessedBlock: 0,
        lastProcessedBlockId: null,
        lastIrreversibleBlock: 0,
      }
    );
  }

  public async getCurrentCheckpoint(
    source: string,
    blockNumber: number,
  ): Promise<BlockCheckpoint | null> {
    return (
      this.checkpoints.find(
        (checkpoint) =>
          checkpoint.source === source &&
          checkpoint.number === blockNumber &&
          checkpoint.state !== 'reverted',
      ) ?? null
    );
  }

  public async applyBlock(
    source: string,
    block: HafBlock,
    decisions: readonly OperationDecision[],
    observedAt: string,
  ): Promise<void> {
    const cursor = await this.getCursor(source);
    if (block.number !== cursor.lastProcessedBlock + 1) {
      throw new HafProjectorError(
        'cursor_conflict',
        'Block does not immediately follow the cursor',
      );
    }
    if (cursor.lastProcessedBlockId !== null && block.previousId !== cursor.lastProcessedBlockId) {
      throw new HafProjectorError('cursor_conflict', 'Block parent does not match the cursor');
    }
    if ((await this.getCurrentCheckpoint(source, block.number)) !== null) {
      throw new HafProjectorError(
        'cursor_conflict',
        'A current checkpoint already exists at this height',
      );
    }

    this.checkpoints.push({
      ...block,
      source,
      state: 'included',
      includedAt: observedAt,
    });

    for (const decision of decisions) {
      const duplicate = this.operations.find(
        (stored) => stored.evidence.sourceOperationId === decision.evidence.sourceOperationId,
      );
      if (duplicate !== undefined) {
        throw new HafProjectorError('cursor_conflict', 'An operation identity already exists');
      }
      this.operations.push({ ...decision, source, state: 'included' });
    }

    this.cursors.set(source, {
      ...cursor,
      lastProcessedBlock: block.number,
      lastProcessedBlockId: block.id,
    });
  }

  public async revertAfter(
    source: string,
    ancestorBlock: number,
    revertedAt: string,
  ): Promise<void> {
    const cursor = await this.getCursor(source);
    if (ancestorBlock < cursor.lastIrreversibleBlock) {
      throw new HafProjectorError('irreversible_fork', 'Cannot revert an irreversible checkpoint');
    }

    replaceWhere(
      this.checkpoints,
      (checkpoint) =>
        checkpoint.source === source &&
        checkpoint.number > ancestorBlock &&
        checkpoint.state !== 'reverted',
      (checkpoint) => ({ ...checkpoint, state: 'reverted' as const, revertedAt }),
    );
    replaceWhere(
      this.operations,
      (operation) =>
        operation.source === source &&
        operation.evidence.blockNumber > ancestorBlock &&
        operation.state !== 'reverted',
      (operation) => ({ ...operation, state: 'reverted' as const, revertedAt }),
    );

    const ancestor = await this.getCurrentCheckpoint(source, ancestorBlock);
    this.cursors.set(source, {
      ...cursor,
      lastProcessedBlock: ancestorBlock,
      lastProcessedBlockId: ancestor?.id ?? null,
    });
  }

  public async finalizeThrough(
    source: string,
    blockNumber: number,
    irreversibleAt: string,
  ): Promise<void> {
    const cursor = await this.getCursor(source);
    if (blockNumber > cursor.lastProcessedBlock) {
      throw new HafProjectorError('cursor_conflict', 'Cannot finalize beyond the processed cursor');
    }

    replaceWhere(
      this.checkpoints,
      (checkpoint) =>
        checkpoint.source === source &&
        checkpoint.number <= blockNumber &&
        checkpoint.state === 'included',
      (checkpoint) => ({ ...checkpoint, state: 'irreversible' as const, irreversibleAt }),
    );
    replaceWhere(
      this.operations,
      (operation) =>
        operation.source === source &&
        operation.evidence.blockNumber <= blockNumber &&
        operation.state === 'included',
      (operation) => ({ ...operation, state: 'irreversible' as const, irreversibleAt }),
    );
    this.cursors.set(source, {
      ...cursor,
      lastIrreversibleBlock: Math.max(cursor.lastIrreversibleBlock, blockNumber),
    });
  }
}

function replaceWhere<T>(
  values: T[],
  predicate: (value: T) => boolean,
  replacement: (value: T) => T,
): void {
  values.forEach((value, index) => {
    if (predicate(value)) {
      values[index] = replacement(value);
    }
  });
}

function assertNonProductionFixture(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('HAF projector in-memory store is disabled in production');
  }
}
