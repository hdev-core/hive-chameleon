export type HafProjectorErrorCode =
  | 'cursor_conflict'
  | 'database_unavailable'
  | 'invalid_source_response'
  | 'irreversible_fork'
  | 'reorg_too_deep'
  | 'source_divergence'
  | 'source_unavailable';

export class HafProjectorError extends Error {
  public override readonly name = 'HafProjectorError';

  public constructor(
    public readonly code: HafProjectorErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
