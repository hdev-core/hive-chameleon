export type MatchPublisherErrorCode =
  | 'configuration_invalid'
  | 'database_unavailable'
  | 'invalid_candidate'
  | 'payload_too_large'
  | 'publication_failed';

export class MatchPublisherError extends Error {
  public override readonly name = 'MatchPublisherError';

  public constructor(
    public readonly code: MatchPublisherErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
