import { z } from 'zod';

import type {
  IsolatedSignerClient,
  IsolatedSignerRequest,
  IsolatedSignerResponse,
} from './contracts.js';
import { HiveGatewayError } from './errors.js';

const signerResponseSchema = z.strictObject({
  signature: z.string().min(16).max(256),
  publicKey: z.string().min(16).max(128),
});

export interface HttpIsolatedSignerClientConfig {
  readonly endpoint: string;
  readonly bearerToken: string;
  readonly timeoutMs?: number;
  readonly fetchImplementation?: typeof fetch;
}

/**
 * Sends an already policy-constrained signing request to a separately protected signer process.
 * The transport never accepts a private key and never retries automatically: callers must make
 * retry/idempotency decisions with durable job state.
 */
export class HttpIsolatedSignerClient implements IsolatedSignerClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: typeof fetch;

  public constructor(private readonly config: HttpIsolatedSignerClientConfig) {
    this.endpoint = validateSignerEndpoint(config.endpoint);
    if (config.bearerToken.length < 32 || config.bearerToken.length > 4096) {
      throw new HiveGatewayError(
        'invalid_authorization',
        'Signer bearer token must contain 32..4096 characters',
      );
    }
    this.timeoutMs = config.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 120_000) {
      throw new HiveGatewayError(
        'invalid_authorization',
        'Signer timeout must be 100..120000 milliseconds',
      );
    }
    this.fetchImplementation = config.fetchImplementation ?? fetch;
  }

  public async sign(request: IsolatedSignerRequest): Promise<IsolatedSignerResponse> {
    let response: Response;
    try {
      response = await this.fetchImplementation(this.endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.config.bearerToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(request),
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error: unknown) {
      throw new HiveGatewayError('signer_unavailable', 'Isolated signer request failed', {
        cause: error,
      });
    }

    if (!response.ok) {
      throw new HiveGatewayError(
        'signer_unavailable',
        `Isolated signer rejected the request with HTTP ${response.status}`,
      );
    }

    let responseText: string;
    try {
      responseText = await response.text();
    } catch (error: unknown) {
      throw new HiveGatewayError('signer_unavailable', 'Isolated signer response was unreadable', {
        cause: error,
      });
    }
    if (Buffer.byteLength(responseText, 'utf8') > 16 * 1024) {
      throw new HiveGatewayError('signer_mismatch', 'Isolated signer response was oversized');
    }

    let responseBody: unknown;
    try {
      responseBody = JSON.parse(responseText) as unknown;
    } catch (error: unknown) {
      throw new HiveGatewayError('signer_mismatch', 'Isolated signer returned invalid JSON', {
        cause: error,
      });
    }
    const parsed = signerResponseSchema.safeParse(responseBody);
    if (!parsed.success) {
      throw new HiveGatewayError(
        'signer_mismatch',
        'Isolated signer returned an invalid response',
        {
          cause: parsed.error,
        },
      );
    }
    return parsed.data;
  }
}

function validateSignerEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error: unknown) {
    throw new HiveGatewayError('invalid_authorization', 'Signer endpoint is not a valid URL', {
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
      'invalid_authorization',
      'Signer endpoint must be HTTPS without credentials, query, or fragment',
    );
  }
  return url.toString();
}
