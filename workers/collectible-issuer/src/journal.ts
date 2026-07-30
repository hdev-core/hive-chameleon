import type { CollectibleSigningRecord } from './model.js';

export interface CollectibleIssuerJournal {
  recordPrepared(record: CollectibleSigningRecord): Promise<void>;
  markBroadcast(recordId: string, transactionId: string, broadcastAt: string): Promise<void>;
  markFailed(
    recordId: string,
    transactionId: string,
    failureCode: string,
    failedAt: string,
  ): Promise<void>;
}
