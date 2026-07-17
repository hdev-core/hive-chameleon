export type HiveGatewayErrorCode =
  | 'invalid_authorization'
  | 'invalid_event'
  | 'invalid_operation'
  | 'invalid_signature'
  | 'idempotency_conflict'
  | 'idempotency_unavailable'
  | 'non_canonical_payload'
  | 'payload_too_large'
  | 'policy_denied'
  | 'signer_mismatch'
  | 'transaction_mismatch';

export class HiveGatewayError extends Error {
  public override readonly name = 'HiveGatewayError';

  public constructor(
    public readonly code: HiveGatewayErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
