import type { BlockCheckpoint, HafBlock, OperationDecision, ProjectionCursor } from '../model.js';

export interface ProjectionStore {
  getCursor(source: string): Promise<ProjectionCursor>;
  getCurrentCheckpoint(source: string, blockNumber: number): Promise<BlockCheckpoint | null>;
  applyBlock(
    source: string,
    block: HafBlock,
    decisions: readonly OperationDecision[],
    observedAt: string,
  ): Promise<void>;
  revertAfter(source: string, ancestorBlock: number, revertedAt: string): Promise<void>;
  finalizeThrough(source: string, blockNumber: number, irreversibleAt: string): Promise<void>;
}
