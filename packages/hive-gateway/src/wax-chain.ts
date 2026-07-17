import { createHiveChain, type IHiveChainInterface } from '@hiveio/wax';
import { z } from 'zod';

import { canonicalCustomJsonOperation } from './policy.js';
import type {
  HiveChainPort,
  HiveCustomJsonOperation,
  InspectedChainTransaction,
  PreparedChainTransaction,
} from './contracts.js';
import { HiveGatewayError } from './errors.js';

const customJsonValueSchema = z.strictObject({
  required_auths: z.array(z.string()),
  required_posting_auths: z.array(z.string()),
  id: z.string(),
  json: z.string(),
});

const apiOperationSchema = z.union([
  z.strictObject({ type: z.literal('custom_json_operation'), value: customJsonValueSchema }),
  z.strictObject({ custom_json: customJsonValueSchema }),
]);

const transactionEnvelopeSchema = z
  .object({
    operations: z.array(z.unknown()),
    signatures: z.array(z.string()),
  })
  .passthrough();

export interface WaxHiveChainConfig {
  readonly apiEndpoint: string;
  readonly chainId: string;
  readonly apiTimeoutMs?: number;
  readonly restApiEndpoint?: string;
  readonly waxApiCaller?: string;
}

export class WaxHiveChainAdapter implements HiveChainPort {
  private readonly chain: Promise<IHiveChainInterface>;

  public constructor(config: WaxHiveChainConfig) {
    assertEndpoint(config.apiEndpoint, 'Hive RPC');
    if (config.restApiEndpoint !== undefined) {
      assertEndpoint(config.restApiEndpoint, 'Hive REST API');
    }
    if (!/^[0-9a-f]{64}$/.test(config.chainId)) {
      throw new HiveGatewayError(
        'invalid_operation',
        'Hive chain ID must be 32 lowercase hex bytes',
      );
    }

    const apiTimeout = config.apiTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(apiTimeout) || apiTimeout < 100 || apiTimeout > 120_000) {
      throw new HiveGatewayError('invalid_operation', 'Hive API timeout must be 100..120000 ms');
    }

    const options = {
      apiEndpoint: config.apiEndpoint,
      chainId: config.chainId,
      apiTimeout,
      ...(config.restApiEndpoint === undefined ? {} : { restApiEndpoint: config.restApiEndpoint }),
      ...(config.waxApiCaller === undefined ? {} : { waxApiCaller: config.waxApiCaller }),
    };
    this.chain = createHiveChain(options);
  }

  public async prepareCustomJson(
    operation: HiveCustomJsonOperation,
    expirationSeconds: number,
  ): Promise<PreparedChainTransaction> {
    if (
      !Number.isInteger(expirationSeconds) ||
      expirationSeconds < 10 ||
      expirationSeconds > 3_600
    ) {
      throw new HiveGatewayError(
        'invalid_operation',
        'Transaction expiration must be 10..3600 seconds',
      );
    }

    const chain = await this.chain;
    const transaction = await chain.createTransaction(`+${expirationSeconds}s`);
    transaction
      .pushOperation({
        custom_json_operation: {
          required_auths: [...operation.required_auths],
          required_posting_auths: [...operation.required_posting_auths],
          id: operation.id,
          json: operation.json,
        },
      })
      .validate();

    const unsignedTransactionJson = transaction.toApi();
    const inspected = await this.inspectTransaction(unsignedTransactionJson);
    return inspected;
  }

  public async inspectTransaction(transactionJson: string): Promise<InspectedChainTransaction> {
    const chain = await this.chain;
    let transaction;
    try {
      transaction = chain.createTransactionFromJson(transactionJson);
      transaction.validate();
    } catch (error: unknown) {
      throw new HiveGatewayError('invalid_operation', 'WAX rejected the Hive transaction', {
        cause: error,
      });
    }

    let raw: unknown;
    try {
      raw = JSON.parse(transaction.toApi()) as unknown;
    } catch (error: unknown) {
      throw new HiveGatewayError(
        'invalid_operation',
        'WAX transaction JSON could not be inspected',
        {
          cause: error,
        },
      );
    }

    const envelope = transactionEnvelopeSchema.safeParse(raw);
    if (!envelope.success || envelope.data.operations.length !== 1) {
      throw new HiveGatewayError('invalid_operation', 'Exactly one Hive operation is required');
    }

    const parsedOperation = apiOperationSchema.safeParse(envelope.data.operations[0]);
    if (!parsedOperation.success) {
      throw new HiveGatewayError(
        'invalid_operation',
        'Only custom_json is supported by this gateway',
      );
    }

    const operation =
      'value' in parsedOperation.data
        ? parsedOperation.data.value
        : parsedOperation.data.custom_json;

    return {
      unsignedTransactionJson: transaction.toApi(),
      signatureDigest: transaction.sigDigest,
      transactionId: transaction.id,
      canonicalOperationJson: canonicalCustomJsonOperation(operation),
      operation,
      isSigned: envelope.data.signatures.length > 0,
    };
  }

  public async recoverPublicKey(signatureDigest: string, signature: string): Promise<string> {
    const chain = await this.chain;
    try {
      return chain.getPublicKeyFromSignature(signatureDigest, signature);
    } catch (error: unknown) {
      throw new HiveGatewayError('invalid_signature', 'WAX could not recover the signing key', {
        cause: error,
      });
    }
  }

  public async attachSignature(
    unsignedTransactionJson: string,
    signature: string,
  ): Promise<string> {
    const chain = await this.chain;
    const transaction = chain.createTransactionFromJson(unsignedTransactionJson);
    if (transaction.isSigned()) {
      throw new HiveGatewayError('transaction_mismatch', 'Expected an unsigned Hive transaction');
    }

    transaction.addSignature(signature);
    return transaction.toApi();
  }

  public async broadcast(signedTransactionJson: string): Promise<void> {
    const chain = await this.chain;
    const transaction = chain.createTransactionFromJson(signedTransactionJson);
    transaction.validate();
    if (!transaction.isSigned()) {
      throw new HiveGatewayError('invalid_signature', 'Cannot broadcast an unsigned transaction');
    }
    await chain.broadcast(transaction);
  }
}

function assertEndpoint(value: string, label: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error: unknown) {
    throw new HiveGatewayError('invalid_operation', `${label} endpoint is not a valid URL`, {
      cause: error,
    });
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new HiveGatewayError(
      'invalid_operation',
      `${label} endpoint must be HTTPS without credentials, a query, or a fragment`,
    );
  }
}
