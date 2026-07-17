import { sha256Hex } from './canonical/hash.js';
import type {
  DigestSignatureProvider,
  HiveChainPort,
  IsolatedSignerClient,
  IsolatedSignerRequest,
  IsolatedSignerResponse,
  OfficialEventIntent,
  OfficialSignerPolicy,
  SignerIdempotencyBinding,
  SignerIdempotencyLedger,
} from './contracts.js';
import { HiveGatewayError } from './errors.js';
import { authorizeOfficialEvent, canonicalCustomJsonOperation } from './policy.js';
import { eventFamily, parseHiveChameleonEvent } from './protocol/events.js';
import { assertSignatureMatchesPublicKey } from './signature.js';

export class PolicyEnforcingSignerBoundary implements IsolatedSignerClient {
  public constructor(
    private readonly chain: HiveChainPort,
    private readonly provider: DigestSignatureProvider,
    private readonly policy: OfficialSignerPolicy,
    private readonly idempotency: SignerIdempotencyLedger,
  ) {}

  public async sign(request: IsolatedSignerRequest): Promise<IsolatedSignerResponse> {
    const inspected = await this.chain.inspectTransaction(request.unsignedTransactionJson);
    if (inspected.isSigned) {
      throw new HiveGatewayError(
        'transaction_mismatch',
        'Signer boundary accepts unsigned transactions only',
      );
    }

    if (
      inspected.signatureDigest !== request.signatureDigest ||
      inspected.transactionId !== request.transactionId ||
      inspected.canonicalOperationJson !== request.canonicalOperationJson ||
      sha256Hex(inspected.canonicalOperationJson) !== request.canonicalOperationHash
    ) {
      throw new HiveGatewayError(
        'transaction_mismatch',
        'Signer request does not match its WAX transaction',
      );
    }

    const event = parseHiveChameleonEvent(request.canonicalPayload);
    if (event.type !== request.eventType) {
      throw new HiveGatewayError(
        'transaction_mismatch',
        'Signer event type does not match payload',
      );
    }
    if (eventFamily(event) !== request.eventFamily) {
      throw new HiveGatewayError(
        'transaction_mismatch',
        'Signer event family does not match payload',
      );
    }

    const authorization = this.policy.resolve(request.policyVersion, request.role);
    if (authorization === null || !matchesTrustedAuthorization(request, authorization)) {
      throw new HiveGatewayError(
        'policy_denied',
        'Signer request does not match an approved official signer policy',
      );
    }
    const intent: OfficialEventIntent = {
      idempotencyKey: request.idempotencyKey,
      policyVersion: request.policyVersion,
      event,
    };
    const authorized = authorizeOfficialEvent(intent, authorization);
    const expectedOperation = canonicalCustomJsonOperation(authorized.operation);
    if (
      expectedOperation !== request.canonicalOperationJson ||
      authorized.canonicalPayload !== request.canonicalPayload
    ) {
      throw new HiveGatewayError(
        'policy_denied',
        'Signer policy reconstructed a different operation',
      );
    }

    const binding = idempotencyBinding(request);
    const acquisition = await this.acquireIdempotency(binding);
    if (acquisition.state === 'conflict') {
      throw new HiveGatewayError(
        'idempotency_conflict',
        'Signer idempotency key is already bound to a different request',
      );
    }
    if (acquisition.state === 'replay') {
      await this.assertSignerResponse(request, acquisition.response);
      return acquisition.response;
    }

    let response: Awaited<ReturnType<DigestSignatureProvider['signDigest']>>;
    try {
      response = await this.provider.signDigest({
        idempotencyKey: request.idempotencyKey,
        signerKeyReference: request.signerKeyReference,
        signatureDigest: request.signatureDigest,
        expectedPublicKey: request.expectedPublicKey,
      });
    } catch (error: unknown) {
      // The provider may have completed signing even when its response was interrupted. Retaining
      // the reservation is the only fail-closed outcome: an identical retry must not sign again.
      throw new HiveGatewayError(
        'idempotency_unavailable',
        'Signer outcome is unresolved; idempotency reservation retained for reconciliation',
        { cause: error },
      );
    }

    const signerResponse = {
      signature: response.signature,
      publicKey: request.expectedPublicKey,
    };
    await this.assertSignerResponse(request, signerResponse);

    try {
      await this.idempotency.complete(binding, acquisition.leaseId, signerResponse);
    } catch (error: unknown) {
      // Completion can fail after the ledger committed. Never abort here: either a completed
      // replay or the still-active reservation must fence every retry until reconciliation.
      throw new HiveGatewayError(
        'idempotency_unavailable',
        'Signed response could not be durably completed; reservation retained for reconciliation',
        { cause: error },
      );
    }
    return signerResponse;
  }

  private async acquireIdempotency(
    binding: SignerIdempotencyBinding,
  ): Promise<Awaited<ReturnType<SignerIdempotencyLedger['acquire']>>> {
    try {
      return await this.idempotency.acquire(binding);
    } catch (error: unknown) {
      throw new HiveGatewayError(
        'idempotency_unavailable',
        'Signer idempotency ledger is unavailable',
        { cause: error },
      );
    }
  }

  private async assertSignerResponse(
    request: IsolatedSignerRequest,
    response: IsolatedSignerResponse,
  ): Promise<void> {
    if (response.publicKey !== request.expectedPublicKey) {
      throw new HiveGatewayError('signer_mismatch', 'Signer returned an unexpected public key');
    }
    await assertSignatureMatchesPublicKey(
      this.chain,
      request.signatureDigest,
      response.signature,
      request.expectedPublicKey,
    );
  }
}

function idempotencyBinding(request: IsolatedSignerRequest): SignerIdempotencyBinding {
  return {
    idempotencyKey: request.idempotencyKey,
    policyVersion: request.policyVersion,
    role: request.role,
    account: request.account,
    authority: request.authority,
    expectedPublicKey: request.expectedPublicKey,
    signerKeyReference: request.signerKeyReference,
    canonicalOperationJson: request.canonicalOperationJson,
    canonicalOperationHash: request.canonicalOperationHash,
    signatureDigest: request.signatureDigest,
    transactionId: request.transactionId,
  };
}

function matchesTrustedAuthorization(
  request: IsolatedSignerRequest,
  authorization: NonNullable<ReturnType<OfficialSignerPolicy['resolve']>>,
): boolean {
  return (
    authorization.mode === 'official_service' &&
    authorization.role === request.role &&
    authorization.account === request.account &&
    authorization.authority === request.authority &&
    authorization.expectedPublicKey === request.expectedPublicKey &&
    authorization.signerKeyReference === request.signerKeyReference &&
    authorization.policyVersion === request.policyVersion
  );
}
