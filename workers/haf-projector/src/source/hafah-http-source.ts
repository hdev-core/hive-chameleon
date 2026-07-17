import { z } from 'zod';

import { HafProjectorError } from '../errors.js';
import type { HafBlock, HafIrreversibleBlock, HafOperation } from '../model.js';
import type { HafSource } from './haf-source.js';

export interface HttpResponsePort {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type FetchPort = (input: string, init?: RequestInit) => Promise<HttpResponsePort>;

export interface HafahHttpSourceConfig {
  readonly sourceName: string;
  readonly hafahApiUrl: string;
  readonly hiveRpcUrl: string;
  readonly operationTypeIds: readonly number[];
  readonly pageSize?: number;
  readonly timeoutMs?: number;
  readonly allowHttpForTests?: boolean;
}

const blockHashSchema = z.string().regex(/^[0-9a-f]{40}$/);
const uint64DecimalSchema = z
  .string()
  .refine(
    (value) => /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n,
  );
const globalStateSchema = z.object({
  block_num: z.number().int().nonnegative(),
  hash: blockHashSchema,
  prev: blockHashSchema,
  created_at: z.string().min(1),
});
const hafahOperationSchema = z.object({
  op: z.object({ type: z.string().min(1), value: z.unknown() }),
  block: z.number().int().nonnegative(),
  trx_id: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullable()
    .optional(),
  op_pos: z.number().int().nonnegative(),
  timestamp: z.string().min(1),
  virtual_op: z.boolean(),
  operation_id: uint64DecimalSchema,
});
const operationsPageSchema = z.object({
  next_block_range_begin: z.number().int().nonnegative().nullable().optional(),
  next_operation_begin: uint64DecimalSchema.nullable().optional(),
  ops: z.array(hafahOperationSchema),
});
const rpcPropertiesSchema = z.object({
  result: z.object({ last_irreversible_block_num: z.number().int().nonnegative() }),
});
const rpcBlockSchema = z.object({
  result: z.object({ block: z.object({ block_id: blockHashSchema }) }),
});

const ZERO_TRANSACTION_ID = '0'.repeat(40);

export class HafahHttpSource implements HafSource {
  public readonly sourceName: string;

  private readonly apiBase: URL;
  private readonly rpcUrl: URL;
  private readonly operationTypeIds: readonly number[];
  private readonly pageSize: number;
  private readonly timeoutMs: number;

  public constructor(
    config: HafahHttpSourceConfig,
    private readonly fetchPort: FetchPort = globalThis.fetch,
  ) {
    if (config.allowHttpForTests === true && process.env.NODE_ENV === 'production') {
      throw new HafProjectorError(
        'invalid_source_response',
        'Plain HTTP source overrides are disabled in production',
      );
    }
    this.sourceName = config.sourceName;
    this.apiBase = normalizeBaseUrl(config.hafahApiUrl, config.allowHttpForTests ?? false);
    this.rpcUrl = validateUrl(config.hiveRpcUrl, config.allowHttpForTests ?? false);
    this.operationTypeIds = [...config.operationTypeIds];
    this.pageSize = config.pageSize ?? 1_000;
    this.timeoutMs = config.timeoutMs ?? 5_000;

    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(this.sourceName)) {
      throw new HafProjectorError('invalid_source_response', 'HAF source name is invalid');
    }
    if (
      this.operationTypeIds.length === 0 ||
      this.operationTypeIds.some((value) => !Number.isInteger(value) || value < 0)
    ) {
      throw new HafProjectorError('invalid_source_response', 'Operation type IDs are invalid');
    }
    if (!Number.isInteger(this.pageSize) || this.pageSize < 1 || this.pageSize > 10_000) {
      throw new HafProjectorError('invalid_source_response', 'HAfAH page size is invalid');
    }
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 120_000) {
      throw new HafProjectorError('invalid_source_response', 'Hive source timeout is invalid');
    }
  }

  public async getHeadBlockNumber(): Promise<number> {
    const value = await this.getJson(new URL('headblock', this.apiBase));
    const result = z.number().int().nonnegative().safeParse(value);
    if (!result.success) {
      throw invalidResponse('HAfAH head block response is invalid', result.error);
    }
    return result.data;
  }

  public async getLastIrreversibleBlock(): Promise<HafIrreversibleBlock> {
    const value = await this.requestJson(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'database_api.get_dynamic_global_properties',
        params: {},
        id: 1,
      }),
    });
    const result = rpcPropertiesSchema.safeParse(value);
    if (!result.success) {
      throw invalidResponse('Hive RPC finality response is invalid', result.error);
    }
    const blockNumber = result.data.result.last_irreversible_block_num;
    if (blockNumber === 0) {
      return { number: 0, id: null };
    }

    const blockValue = await this.requestJson(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'block_api.get_block',
        params: { block_num: blockNumber },
        id: 2,
      }),
    });
    const blockResult = rpcBlockSchema.safeParse(blockValue);
    if (
      !blockResult.success ||
      !blockIdMatchesNumber(blockResult.data.result.block.block_id, blockNumber)
    ) {
      throw invalidResponse(
        'Hive RPC irreversible block response is invalid',
        blockResult.success ? undefined : blockResult.error,
      );
    }
    return { number: blockNumber, id: blockResult.data.result.block.block_id };
  }

  public async getBlock(blockNumber: number): Promise<HafBlock> {
    assertBlockNumber(blockNumber);
    const url = new URL('global-state', this.apiBase);
    url.searchParams.set('block-num', blockNumber.toString());
    const value = await this.getJson(url);
    const result = globalStateSchema.safeParse(value);
    if (
      !result.success ||
      result.data.block_num !== blockNumber ||
      !blockIdMatchesNumber(result.data.hash, blockNumber)
    ) {
      throw invalidResponse(
        'HAfAH block checkpoint response is invalid',
        result.success ? undefined : result.error,
      );
    }

    return {
      number: blockNumber,
      id: result.data.hash,
      previousId: result.data.prev,
      timestamp: normalizeHiveTimestamp(result.data.created_at),
    };
  }

  public async getOperations(fromBlock: number, toBlock: number): Promise<readonly HafOperation[]> {
    assertBlockNumber(fromBlock);
    assertBlockNumber(toBlock);
    if (toBlock < fromBlock) {
      throw new HafProjectorError('invalid_source_response', 'Operation block range is inverted');
    }

    const operations = new Map<string, HafOperation>();
    const visitedPages = new Set<string>();
    let pageFrom = fromBlock;
    let operationBegin: string | undefined;

    for (;;) {
      const pageKey = `${pageFrom}:${operationBegin ?? ''}`;
      if (visitedPages.has(pageKey)) {
        throw new HafProjectorError('invalid_source_response', 'HAfAH pagination loop detected');
      }
      visitedPages.add(pageKey);

      const url = new URL('operations', this.apiBase);
      url.searchParams.set('from-block', pageFrom.toString());
      url.searchParams.set('to-block', toBlock.toString());
      url.searchParams.set('operation-types', this.operationTypeIds.join(','));
      url.searchParams.set('operation-group-type', 'all');
      url.searchParams.set('page-size', this.pageSize.toString());
      url.searchParams.set('include-reversible', 'true');
      if (operationBegin !== undefined) {
        // HAfAH operation IDs are unsigned 64-bit decimal strings and must never pass through Number.
        url.searchParams.set('operation-begin', operationBegin);
      }

      const raw = await this.getJson(url);
      const parsed = operationsPageSchema.safeParse(raw);
      if (!parsed.success) {
        throw invalidResponse('HAfAH operations response is invalid', parsed.error);
      }

      for (const item of parsed.data.ops) {
        if (item.block < fromBlock || item.block > toBlock) {
          throw new HafProjectorError(
            'invalid_source_response',
            'HAfAH returned an operation outside the range',
          );
        }
        const hasTransactionId = item.trx_id != null && item.trx_id !== ZERO_TRANSACTION_ID;
        if (!item.virtual_op && !hasTransactionId) {
          throw new HafProjectorError(
            'invalid_source_response',
            'HAfAH operation transaction identity is inconsistent with virtuality',
          );
        }

        const normalized: HafOperation = {
          sourceOperationId: item.operation_id,
          transactionId: hasTransactionId ? (item.trx_id ?? null) : null,
          operationIndex: item.op_pos,
          isVirtual: item.virtual_op,
          blockNumber: item.block,
          timestamp: normalizeHiveTimestamp(item.timestamp),
          operationType: item.op.type,
          value: item.op.value,
        };
        const previous = operations.get(normalized.sourceOperationId);
        if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(normalized)) {
          throw new HafProjectorError(
            'invalid_source_response',
            'Conflicting duplicate HAfAH operation',
          );
        }
        operations.set(normalized.sourceOperationId, normalized);
      }

      const nextBlock = parsed.data.next_block_range_begin;
      const nextOperation = parsed.data.next_operation_begin;
      if (
        nextBlock === null ||
        nextBlock === undefined ||
        nextBlock === 0 ||
        nextOperation === null ||
        nextOperation === undefined ||
        nextOperation === '0' ||
        nextBlock > toBlock
      ) {
        break;
      }
      pageFrom = nextBlock;
      operationBegin = nextOperation;
    }

    return [...operations.values()].sort((left, right) => {
      return left.blockNumber - right.blockNumber || left.operationIndex - right.operationIndex;
    });
  }

  private async getJson(url: URL): Promise<unknown> {
    return this.requestJson(url, { method: 'GET' });
  }

  private async requestJson(url: URL, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchPort(url.toString(), { ...init, signal: controller.signal });
      if (!response.ok) {
        throw new HafProjectorError(
          'source_unavailable',
          `Hive source returned HTTP ${response.status}`,
        );
      }
      return await response.json();
    } catch (error: unknown) {
      if (error instanceof HafProjectorError) {
        throw error;
      }
      throw new HafProjectorError('source_unavailable', 'Hive source request failed', {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeBaseUrl(value: string, allowHttp: boolean): URL {
  const url = validateUrl(value, allowHttp);
  if (!url.pathname.endsWith('/')) {
    url.pathname += '/';
  }
  return url;
}

function validateUrl(value: string, allowHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error: unknown) {
    throw new HafProjectorError('invalid_source_response', 'Hive source URL is invalid', {
      cause: error,
    });
  }
  const protocolAllowed = url.protocol === 'https:' || (allowHttp && url.protocol === 'http:');
  if (
    !protocolAllowed ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new HafProjectorError(
      'invalid_source_response',
      'Source URL must use HTTPS and contain no credentials, query, or fragment',
    );
  }
  return url;
}

function normalizeHiveTimestamp(value: string): string {
  const withZone = /(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(value) ? value : `${value}Z`;
  const timestamp = new Date(withZone);
  if (Number.isNaN(timestamp.valueOf())) {
    throw new HafProjectorError('invalid_source_response', 'Hive timestamp is invalid');
  }
  return timestamp.toISOString();
}

function assertBlockNumber(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HafProjectorError('invalid_source_response', 'Hive block number is invalid');
  }
}

function invalidResponse(message: string, cause?: unknown): HafProjectorError {
  return new HafProjectorError('invalid_source_response', message, { cause });
}

function blockIdMatchesNumber(blockId: string, blockNumber: number): boolean {
  return (
    blockNumber <= 0xffff_ffff && blockId.slice(0, 8) === blockNumber.toString(16).padStart(8, '0')
  );
}
