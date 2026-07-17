import type { HafBlock, HafIrreversibleBlock, HafOperation } from '../model.js';

export interface HafSource {
  readonly sourceName: string;
  getHeadBlockNumber(): Promise<number>;
  /** Returns the Hive RPC LIB height and identity as one finality checkpoint. */
  getLastIrreversibleBlock(): Promise<HafIrreversibleBlock>;
  /** Returns the HAfAH block identity used to bracket operation reads and verify RPC finality. */
  getBlock(blockNumber: number): Promise<HafBlock>;
  getOperations(fromBlock: number, toBlock: number): Promise<readonly HafOperation[]>;
}
