import { HafProjectorError } from '../errors.js';
import type { HafBlock, HafIrreversibleBlock, HafOperation } from '../model.js';
import type { HafSource } from '../source/haf-source.js';

export class FixtureHafSource implements HafSource {
  public lastIrreversibleBlock = 0;
  public irreversibleBlockIdOverride: string | null | undefined;

  private blocks = new Map<number, HafBlock>();
  private operations: readonly HafOperation[] = [];

  public constructor(public readonly sourceName = 'fixture-mainnet') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('HAF projector fixture source is disabled in production');
    }
  }

  public replaceChain(blocks: readonly HafBlock[], operations: readonly HafOperation[] = []): void {
    this.blocks = new Map(blocks.map((block) => [block.number, block]));
    this.operations = [...operations];
  }

  public async getHeadBlockNumber(): Promise<number> {
    return Math.max(0, ...this.blocks.keys());
  }

  public async getLastIrreversibleBlock(): Promise<HafIrreversibleBlock> {
    return {
      number: this.lastIrreversibleBlock,
      id:
        this.irreversibleBlockIdOverride !== undefined
          ? this.irreversibleBlockIdOverride
          : this.lastIrreversibleBlock === 0
            ? null
            : (this.blocks.get(this.lastIrreversibleBlock)?.id ?? null),
    };
  }

  public async getBlock(blockNumber: number): Promise<HafBlock> {
    const block = this.blocks.get(blockNumber);
    if (block === undefined) {
      throw new HafProjectorError(
        'invalid_source_response',
        `Missing fixture block ${blockNumber}`,
      );
    }
    return block;
  }

  public async getOperations(fromBlock: number, toBlock: number): Promise<readonly HafOperation[]> {
    return this.operations.filter(
      (operation) => operation.blockNumber >= fromBlock && operation.blockNumber <= toBlock,
    );
  }
}
