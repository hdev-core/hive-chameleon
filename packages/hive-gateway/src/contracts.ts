import type { HiveChameleonEvent, HiveChameleonEventFamily } from './protocol/events.js';

export type HiveAuthority = 'active' | 'owner' | 'posting';
export type OfficialServiceRole =
  'collectible_issuer' | 'match_publisher' | 'rc_support' | 'treasury';

export interface OfficialServiceAuthorization {
  readonly mode: 'official_service';
  readonly role: OfficialServiceRole;
  readonly account: string;
  readonly authority: HiveAuthority;
  readonly expectedPublicKey: string;
  readonly signerKeyReference: string;
  readonly policyVersion: string;
}

export interface CustodialPlayerAuthorization {
  readonly mode: 'custodial_player';
  readonly playerId: string;
  readonly sessionId: string;
  readonly account: string;
  readonly authority: HiveAuthority;
  readonly expectedPublicKey: string;
  readonly signerKeyReference: string;
  readonly policyVersion: string;
}

export interface ExternalPlayerAuthorization {
  readonly mode: 'external_player';
  readonly playerId: string;
  readonly sessionId: string;
  readonly account: string;
  readonly authority: HiveAuthority;
  readonly expectedPublicKey: string;
  readonly provider: 'hiveauth' | 'hivesigner' | 'keychain';
  readonly policyVersion: string;
}

export type AuthorizationContext =
  CustodialPlayerAuthorization | ExternalPlayerAuthorization | OfficialServiceAuthorization;

export interface OfficialEventIntent {
  readonly idempotencyKey: string;
  readonly policyVersion: string;
  readonly event: HiveChameleonEvent;
  readonly expirationSeconds?: number;
}

export interface HiveCustomJsonOperation {
  readonly required_auths: readonly string[];
  readonly required_posting_auths: readonly string[];
  readonly id: string;
  readonly json: string;
}

export interface PreparedChainTransaction {
  readonly unsignedTransactionJson: string;
  readonly signatureDigest: string;
  readonly transactionId: string;
  readonly canonicalOperationJson: string;
}

export interface InspectedChainTransaction extends PreparedChainTransaction {
  readonly operation: HiveCustomJsonOperation;
  readonly isSigned: boolean;
}

export interface HiveChainPort {
  prepareCustomJson(
    operation: HiveCustomJsonOperation,
    expirationSeconds: number,
  ): Promise<PreparedChainTransaction>;
  inspectTransaction(transactionJson: string): Promise<InspectedChainTransaction>;
  recoverPublicKey(signatureDigest: string, signature: string): Promise<string>;
  attachSignature(unsignedTransactionJson: string, signature: string): Promise<string>;
  broadcast(signedTransactionJson: string): Promise<void>;
}

export interface PreparedOfficialEvent extends PreparedChainTransaction {
  readonly idempotencyKey: string;
  readonly policyVersion: string;
  readonly eventFamily: HiveChameleonEventFamily;
  readonly eventType: HiveChameleonEvent['type'];
  readonly canonicalPayload: string;
  readonly canonicalOperationHash: string;
  readonly authorization: OfficialServiceAuthorization;
}

export interface IsolatedSignerRequest {
  readonly idempotencyKey: string;
  readonly policyVersion: string;
  readonly role: OfficialServiceRole;
  readonly account: string;
  readonly authority: HiveAuthority;
  readonly expectedPublicKey: string;
  readonly signerKeyReference: string;
  readonly eventFamily: HiveChameleonEventFamily;
  readonly eventType: HiveChameleonEvent['type'];
  readonly canonicalPayload: string;
  readonly canonicalOperationJson: string;
  readonly canonicalOperationHash: string;
  readonly unsignedTransactionJson: string;
  readonly signatureDigest: string;
  readonly transactionId: string;
}

export interface IsolatedSignerResponse {
  readonly signature: string;
  readonly publicKey: string;
}

export interface SignerIdempotencyBinding {
  readonly idempotencyKey: string;
  readonly policyVersion: string;
  readonly role: OfficialServiceRole;
  readonly account: string;
  readonly authority: HiveAuthority;
  readonly expectedPublicKey: string;
  readonly signerKeyReference: string;
  readonly canonicalOperationJson: string;
  readonly canonicalOperationHash: string;
  readonly signatureDigest: string;
  readonly transactionId: string;
}

export type SignerIdempotencyAcquisition =
  | { readonly state: 'acquired'; readonly leaseId: string }
  | { readonly state: 'conflict' }
  | { readonly state: 'replay'; readonly response: IsolatedSignerResponse };

/**
 * Durable implementations atomically bind one idempotency key to one exact signing request.
 * An identical concurrent acquire must wait for the active reservation and return its replay,
 * rather than issue a second lease. `leaseId` is a fencing token, not an expiring permission:
 * once provider invocation may have begun, the reservation remains until durable completion or
 * explicit operator reconciliation. Completed bindings and responses are immutable.
 */
export interface SignerIdempotencyLedger {
  acquire(binding: SignerIdempotencyBinding): Promise<SignerIdempotencyAcquisition>;
  /** Atomically replaces the matching active lease with an immutable completed replay. */
  complete(
    binding: SignerIdempotencyBinding,
    leaseId: string,
    response: IsolatedSignerResponse,
  ): Promise<void>;
  /**
   * Clears only a matching reservation known not to have reached the signature provider.
   * Never call this after provider invocation or uncertain completion; completed records and
   * unresolved reservations must remain untouched so retries cannot produce another signature.
   */
  abort(binding: SignerIdempotencyBinding, leaseId: string): Promise<void>;
}

export interface IsolatedSignerClient {
  sign(request: IsolatedSignerRequest): Promise<IsolatedSignerResponse>;
}

export interface DigestSignatureProvider {
  signDigest(request: {
    readonly idempotencyKey: string;
    readonly signerKeyReference: string;
    readonly signatureDigest: string;
    readonly expectedPublicKey: string;
  }): Promise<{ readonly signature: string }>;
}

export interface OfficialSignerPolicy {
  resolve(policyVersion: string, role: OfficialServiceRole): OfficialServiceAuthorization | null;
}

export interface BroadcastOfficialEventResult {
  readonly transactionId: string;
  readonly eventType: HiveChameleonEvent['type'];
}
