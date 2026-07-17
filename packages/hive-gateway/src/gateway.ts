import { sha256Hex } from './canonical/hash.js';
import type {
  BroadcastOfficialEventResult,
  HiveChainPort,
  IsolatedSignerClient,
  IsolatedSignerRequest,
  OfficialEventIntent,
  OfficialServiceAuthorization,
  PreparedOfficialEvent,
} from './contracts.js';
import { HiveGatewayError } from './errors.js';
import { authorizeOfficialEvent, canonicalCustomJsonOperation } from './policy.js';
import { eventFamily } from './protocol/events.js';
import { assertSignatureMatchesPublicKey } from './signature.js';

export class HiveGateway {
  public constructor(private readonly chain: HiveChainPort) {}

  public async prepareOfficialEvent(
    intent: OfficialEventIntent,
    authorization: OfficialServiceAuthorization,
  ): Promise<PreparedOfficialEvent> {
    const { operation, canonicalPayload } = authorizeOfficialEvent(intent, authorization);
    const canonicalOperationJson = canonicalCustomJsonOperation(operation);
    const prepared = await this.chain.prepareCustomJson(operation, intent.expirationSeconds ?? 300);

    if (prepared.canonicalOperationJson !== canonicalOperationJson) {
      throw new HiveGatewayError('transaction_mismatch', 'WAX prepared a different operation');
    }

    return {
      ...prepared,
      idempotencyKey: intent.idempotencyKey,
      policyVersion: intent.policyVersion,
      eventFamily: eventFamily(intent.event),
      eventType: intent.event.type,
      canonicalPayload,
      canonicalOperationHash: sha256Hex(canonicalOperationJson),
      authorization,
    };
  }

  public async broadcastOfficialEvent(
    prepared: PreparedOfficialEvent,
    signer: IsolatedSignerClient,
  ): Promise<BroadcastOfficialEventResult> {
    const request: IsolatedSignerRequest = {
      idempotencyKey: prepared.idempotencyKey,
      policyVersion: prepared.policyVersion,
      role: prepared.authorization.role,
      account: prepared.authorization.account,
      authority: prepared.authorization.authority,
      expectedPublicKey: prepared.authorization.expectedPublicKey,
      signerKeyReference: prepared.authorization.signerKeyReference,
      eventFamily: prepared.eventFamily,
      eventType: prepared.eventType,
      canonicalPayload: prepared.canonicalPayload,
      canonicalOperationJson: prepared.canonicalOperationJson,
      canonicalOperationHash: prepared.canonicalOperationHash,
      unsignedTransactionJson: prepared.unsignedTransactionJson,
      signatureDigest: prepared.signatureDigest,
      transactionId: prepared.transactionId,
    };
    const response = await signer.sign(request);
    if (response.publicKey !== prepared.authorization.expectedPublicKey) {
      throw new HiveGatewayError('signer_mismatch', 'Signer returned an unexpected public key');
    }

    await assertSignatureMatchesPublicKey(
      this.chain,
      prepared.signatureDigest,
      response.signature,
      prepared.authorization.expectedPublicKey,
    );
    const signed = await this.chain.attachSignature(
      prepared.unsignedTransactionJson,
      response.signature,
    );
    await this.chain.broadcast(signed);

    return { transactionId: prepared.transactionId, eventType: prepared.eventType };
  }
}
