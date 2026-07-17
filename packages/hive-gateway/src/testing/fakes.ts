import { sha256Hex } from '../canonical/hash.js';
import type {
  DigestSignatureProvider,
  HiveChainPort,
  HiveCustomJsonOperation,
  InspectedChainTransaction,
  PreparedChainTransaction,
  SignerIdempotencyBinding,
  SignerIdempotencyLedger,
  SignerIdempotencyAcquisition,
  IsolatedSignerResponse,
} from '../contracts.js';
import { canonicalCustomJsonOperation } from '../policy.js';

export class FixtureHiveChain implements HiveChainPort {
  public readonly broadcasts: string[] = [];
  public readonly attachedSignatures: string[] = [];

  private prepared: InspectedChainTransaction | undefined;

  public constructor(
    private readonly recoveredPublicKey: string,
    private readonly fixedDigest: string,
  ) {
    assertNonProductionFixture();
  }

  public async prepareCustomJson(
    operation: HiveCustomJsonOperation,
    expirationSeconds: number,
  ): Promise<PreparedChainTransaction> {
    void expirationSeconds;
    const canonicalOperationJson = canonicalCustomJsonOperation(operation);
    const unsignedTransactionJson = JSON.stringify({
      operations: [JSON.parse(canonicalOperationJson) as unknown],
      signatures: [],
    });
    this.prepared = {
      unsignedTransactionJson,
      signatureDigest: this.fixedDigest,
      transactionId: sha256Hex(unsignedTransactionJson).slice(0, 40),
      canonicalOperationJson,
      operation,
      isSigned: false,
    };
    return this.prepared;
  }

  public async inspectTransaction(transactionJson: string): Promise<InspectedChainTransaction> {
    if (this.prepared === undefined || transactionJson !== this.prepared.unsignedTransactionJson) {
      throw new Error('Unknown fixture transaction');
    }
    return this.prepared;
  }

  public async recoverPublicKey(signatureDigest: string, signature: string): Promise<string> {
    void signatureDigest;
    void signature;
    return this.recoveredPublicKey;
  }

  public async attachSignature(
    unsignedTransactionJson: string,
    signature: string,
  ): Promise<string> {
    this.attachedSignatures.push(signature);
    return `${unsignedTransactionJson}\n${signature}`;
  }

  public async broadcast(signedTransactionJson: string): Promise<void> {
    this.broadcasts.push(signedTransactionJson);
  }
}

export class FixtureDigestSignatureProvider implements DigestSignatureProvider {
  public readonly requests: Array<Parameters<DigestSignatureProvider['signDigest']>[0]> = [];

  public constructor(private readonly signature: string) {
    assertNonProductionFixture();
  }

  public async signDigest(
    request: Parameters<DigestSignatureProvider['signDigest']>[0],
  ): Promise<{ readonly signature: string }> {
    this.requests.push(request);
    return { signature: this.signature };
  }
}

interface FixtureIdempotencyRecord {
  readonly binding: SignerIdempotencyBinding;
  readonly bindingJson: string;
  readonly leaseId: string;
  response?: IsolatedSignerResponse;
}

export class FixtureSignerIdempotencyLedger implements SignerIdempotencyLedger {
  private readonly records = new Map<string, FixtureIdempotencyRecord>();
  private leaseSequence = 0;

  public constructor() {
    assertNonProductionFixture();
  }

  public async acquire(binding: SignerIdempotencyBinding): Promise<SignerIdempotencyAcquisition> {
    const bindingJson = JSON.stringify(binding);
    const existing = this.records.get(binding.idempotencyKey);
    if (existing === undefined) {
      const leaseId = `fixture-lease-${(this.leaseSequence += 1)}`;
      this.records.set(binding.idempotencyKey, { binding, bindingJson, leaseId });
      return { state: 'acquired', leaseId };
    }
    if (existing.bindingJson !== bindingJson) {
      return { state: 'conflict' };
    }
    if (existing.response === undefined) {
      throw new Error('Fixture ledger does not simulate waiting for an active identical lease');
    }
    return { state: 'replay', response: existing.response };
  }

  public async complete(
    binding: SignerIdempotencyBinding,
    leaseId: string,
    response: IsolatedSignerResponse,
  ): Promise<void> {
    const existing = this.assertActiveLease(binding, leaseId);
    existing.response = Object.freeze({ ...response });
  }

  public async abort(binding: SignerIdempotencyBinding, leaseId: string): Promise<void> {
    const existing = this.records.get(binding.idempotencyKey);
    if (
      existing !== undefined &&
      existing.response === undefined &&
      existing.leaseId === leaseId &&
      existing.bindingJson === JSON.stringify(binding)
    ) {
      this.records.delete(binding.idempotencyKey);
    }
  }

  private assertActiveLease(
    binding: SignerIdempotencyBinding,
    leaseId: string,
  ): FixtureIdempotencyRecord {
    const existing = this.records.get(binding.idempotencyKey);
    if (
      existing === undefined ||
      existing.response !== undefined ||
      existing.leaseId !== leaseId ||
      existing.bindingJson !== JSON.stringify(binding)
    ) {
      throw new Error('Fixture idempotency lease does not match');
    }
    return existing;
  }
}

function assertNonProductionFixture(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Hive Gateway testing fixtures are disabled in production');
  }
}
